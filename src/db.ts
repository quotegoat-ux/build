export type Role = "owner" | "admin" | "member";
export type InviteRole = Exclude<Role, "owner">;
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "incomplete";

declare const tenantBrand: unique symbol;

/**
 * The only way to get a Tenant is `loadSession`, so any function that takes one
 * can only run on behalf of an authenticated member of `orgId`. Domain data
 * functions take it first and filter every query by `t.orgId`.
 */
export type Tenant = {
  readonly orgId: string;
  readonly userId: string;
  readonly role: Role;
  readonly [tenantBrand]: true;
};

export interface Org {
  id: string;
  name: string;
  slug: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  trial_ends_at: number;
  created_at: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Member extends User {
  role: Role;
}

export interface Invite {
  id: string;
  email: string;
  role: InviteRole;
  expires_at: number;
}

export interface PendingInvite extends Invite {
  org_id: string;
  org_name: string;
}

const ORG_COLUMNS =
  "o.id, o.name, o.slug, o.stripe_customer_id, o.stripe_subscription_id, o.subscription_status, o.trial_ends_at, o.created_at";

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && e.message.includes("UNIQUE constraint failed");
}

// Unauthenticated: accounts, sessions, tokens.

export async function findUserByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?")
    .bind(email)
    .first<User & { password_hash: string }>();
}

export async function createAccount(
  db: D1Database,
  a: { userId: string; orgId: string; slug: string; name: string; email: string; passwordHash: string; orgName: string; trialEndsAt: number; now: number },
): Promise<"created" | "email_taken"> {
  try {
    await db.batch([
      db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(a.userId, a.email, a.name, a.passwordHash, a.now),
      db.prepare("INSERT INTO orgs (id, name, slug, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(a.orgId, a.orgName, a.slug, a.trialEndsAt, a.now),
      db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(a.orgId, a.userId, a.now),
    ]);
    return "created";
  } catch (e) {
    if (isUniqueViolation(e) && String(e).includes("users.email")) return "email_taken";
    throw e;
  }
}

export async function slugTaken(db: D1Database, slug: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM orgs WHERE slug = ?").bind(slug).first()) !== null;
}

export async function firstOrgIdForUser(db: D1Database, userId: string): Promise<string | null> {
  return db.prepare("SELECT org_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1").bind(userId).first<string>("org_id");
}

export async function insertSession(db: D1Database, s: { id: string; userId: string; orgId: string; expiresAt: number; now: number }) {
  await db
    .prepare("INSERT INTO sessions (id, user_id, org_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(s.id, s.userId, s.orgId, s.expiresAt, s.now)
    .run();
}

export async function deleteSession(db: D1Database, id: string) {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function loadSession(
  db: D1Database,
  sessionId: string,
  now: number,
): Promise<{ tenant: Tenant; user: User; org: Org } | null> {
  const row = await db
    .prepare(
      `SELECT s.user_id, m.role, u.email AS user_email, u.name AS user_name, ${ORG_COLUMNS}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
       LEFT JOIN orgs o ON o.id = m.org_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(sessionId, now)
    .first<Org & { user_id: string; role: Role | null; user_email: string; user_name: string }>();
  if (!row) return null;
  if (row.role === null) {
    // Removed from the active org: fall back to another membership rather than logging the user out.
    const orgId = await firstOrgIdForUser(db, row.user_id);
    if (!orgId) {
      await deleteSession(db, sessionId);
      return null;
    }
    await db.prepare("UPDATE sessions SET org_id = ? WHERE id = ?").bind(orgId, sessionId).run();
    return loadSession(db, sessionId, now);
  }
  const { user_id, role, user_email, user_name, ...org } = row;
  return {
    tenant: { orgId: org.id, userId: user_id, role } as Tenant,
    user: { id: user_id, email: user_email, name: user_name },
    org,
  };
}

export async function insertPasswordReset(db: D1Database, r: { tokenHash: string; userId: string; expiresAt: number }) {
  await db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(r.tokenHash, r.userId, r.expiresAt).run();
}

export async function passwordResetIsValid(db: D1Database, tokenHash: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(tokenHash, now).first();
  return row !== null;
}

/** Marks the token used and sets the password in one transaction; signs the user out everywhere. */
export async function resetPassword(db: D1Database, tokenHash: string, passwordHash: string, now: number): Promise<boolean> {
  const userId = await db
    .prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .bind(now, tokenHash, now)
    .first<string>("user_id");
  if (!userId) return false;
  await db.batch([
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
  return true;
}

export async function findPendingInvite(db: D1Database, tokenHash: string, now: number) {
  return db
    .prepare(
      `SELECT i.id, i.email, i.role, i.expires_at, i.org_id, o.name AS org_name
       FROM invites i JOIN orgs o ON o.id = i.org_id
       WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<PendingInvite>();
}

/** Idempotent: re-accepting leaves one membership and the original accepted_at. */
export async function acceptInvite(
  db: D1Database,
  invite: PendingInvite,
  user: { id: string } | { id: string; name: string; passwordHash: string },
  now: number,
) {
  const statements = [
    db.prepare("INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(invite.org_id, user.id, invite.role, now),
    db.prepare("UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL").bind(now, invite.id),
  ];
  if ("passwordHash" in user) {
    statements.unshift(
      db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(user.id, invite.email, user.name, user.passwordHash, now),
    );
  }
  await db.batch(statements);
}

// Stripe webhooks: authenticated by signature, not by a member, so they key on org id or Stripe ids.

export async function linkCheckout(db: D1Database, orgId: string, customerId: string, subscriptionId: string | null) {
  await db
    .prepare("UPDATE orgs SET stripe_customer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?")
    .bind(customerId, subscriptionId, orgId)
    .run();
}

export async function syncSubscription(
  db: D1Database,
  s: { orgId: string | null; customerId: string; subscriptionId: string; status: SubscriptionStatus; eventCreated: number; deleted: boolean },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE orgs SET
         stripe_customer_id = ?1,
         stripe_subscription_id = ?2,
         subscription_status = ?3,
         stripe_synced_at = ?4
       WHERE (id = ?5 OR (?5 IS NULL AND stripe_customer_id = ?1))
         AND (stripe_synced_at IS NULL OR stripe_synced_at <= ?4)
         AND (?6 = 0 OR stripe_subscription_id IS NULL OR stripe_subscription_id = ?2)`,
    )
    .bind(s.customerId, s.subscriptionId, s.status, s.eventCreated, s.orgId, s.deleted ? 1 : 0)
    .run();
  return result.meta.changes > 0;
}

// Tenant-scoped.

export async function listMembers(t: Tenant, db: D1Database): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? ORDER BY m.created_at`,
    )
    .bind(t.orgId)
    .all<Member>();
  return results;
}

export async function removeMember(t: Tenant, db: D1Database, userId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ? AND role != 'owner'").bind(t.orgId, userId).run();
  return result.meta.changes > 0;
}

export async function listPendingInvites(t: Tenant, db: D1Database, now: number): Promise<Invite[]> {
  const { results } = await db
    .prepare("SELECT id, email, role, expires_at FROM invites WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .bind(t.orgId, now)
    .all<Invite>();
  return results;
}

export async function createInvite(
  t: Tenant,
  db: D1Database,
  i: { id: string; email: string; role: InviteRole; tokenHash: string; expiresAt: number; now: number },
): Promise<"created" | "already_member"> {
  const member = await db
    .prepare("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?")
    .bind(t.orgId, i.email)
    .first();
  if (member) return "already_member";
  await db.batch([
    db.prepare("DELETE FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL").bind(t.orgId, i.email),
    db
      .prepare("INSERT INTO invites (id, org_id, email, role, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(i.id, t.orgId, i.email, i.role, i.tokenHash, i.expiresAt, i.now),
  ]);
  return "created";
}

export async function revokeInvite(t: Tenant, db: D1Database, inviteId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM invites WHERE org_id = ? AND id = ? AND accepted_at IS NULL").bind(t.orgId, inviteId).run();
  return result.meta.changes > 0;
}

export async function renameOrg(t: Tenant, db: D1Database, name: string) {
  await db.prepare("UPDATE orgs SET name = ? WHERE id = ?").bind(name, t.orgId).run();
}

export async function setStripeCustomer(t: Tenant, db: D1Database, customerId: string) {
  await db.prepare("UPDATE orgs SET stripe_customer_id = ? WHERE id = ?").bind(customerId, t.orgId).run();
}

export async function listUserOrgs(t: Tenant, db: D1Database): Promise<{ id: string; name: string; role: Role }[]> {
  const { results } = await db
    .prepare("SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name")
    .bind(t.userId)
    .all<{ id: string; name: string; role: Role }>();
  return results;
}

export async function switchOrg(t: Tenant, db: D1Database, sessionId: string, orgId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE sessions SET org_id = ?1 WHERE id = ?2 AND user_id = ?3 AND EXISTS (SELECT 1 FROM memberships WHERE org_id = ?1 AND user_id = ?3)")
    .bind(orgId, sessionId, t.userId)
    .run();
  return result.meta.changes > 0;
}
