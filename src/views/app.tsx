import type { Invite, Member, Org, Role, User } from "../db";
import { PLANS, hasAccess, type Plan } from "../billing";
import { APP_NAME } from "../env";
import { AppShell, DevLink, ErrorText, Field } from "./layout";

type ShellProps = { org: Org; user: User; notice?: string };

export function DashboardPage({ org, user, notice, memberCount }: ShellProps & { memberCount: number }) {
  const firstName = user.name.split(" ")[0];
  return (
    <AppShell title="Dashboard" active="dashboard" org={org} user={user} notice={notice}>
      <h1>Welcome, {firstName}</h1>
      <p class="lede">This is the home base for {org.name} in {APP_NAME}.</p>
      <div class="grid">
        <a href="/app/team" class="card card-link">
          <h3>Team</h3>
          <p class="stat">{memberCount}</p>
          <p class="muted">{memberCount === 1 ? "member" : "members"}. Invite your office and field staff.</p>
        </a>
        <a href="/app/billing" class="card card-link">
          <h3>Plan</h3>
          <p class="stat">{statusLabel(org)}</p>
          <p class="muted">Manage your subscription.</p>
        </a>
      </div>
    </AppShell>
  );
}

function statusLabel(org: Org): string {
  switch (org.subscription_status) {
    case "active":
      return "Active";
    case "trialing":
      return hasAccess(org, Date.now()) ? "Free trial" : "Trial ended";
    case "past_due":
      return "Payment due";
    case "canceled":
      return "Canceled";
    case "incomplete":
      return "Incomplete";
  }
}

export function TeamPage({
  org,
  user,
  notice,
  members,
  invites,
  canManage,
  error,
  devLink,
}: ShellProps & { members: Member[]; invites: Invite[]; canManage: boolean; error?: string; devLink?: string }) {
  return (
    <AppShell title="Team" active="team" org={org} user={user} notice={notice}>
      <h1>Team</h1>
      <ErrorText error={error} />
      <DevLink url={devLink} />
      <ul class="list">
        {members.map((m) => (
          <li class="list-row">
            <div>
              <strong>{m.name}</strong>
              {m.id === user.id && <span class="muted"> (you)</span>}
              <div class="muted">{m.email}</div>
            </div>
            <div class="row-actions">
              <span class={`pill pill-${m.role}`}>{m.role}</span>
              {canManage && m.role !== "owner" && m.id !== user.id && (
                <form method="post" action={`/app/team/members/${m.id}/remove`} data-confirm={`Remove ${m.name} from ${org.name}?`}>
                  <button type="submit" class="btn btn-small btn-danger">
                    Remove
                  </button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>

      {invites.length > 0 && (
        <>
          <h2>Pending invites</h2>
          <ul class="list">
            {invites.map((i) => (
              <li class="list-row">
                <div>
                  <strong>{i.email}</strong>
                  <div class="muted">Expires {new Date(i.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                </div>
                <div class="row-actions">
                  <span class={`pill pill-${i.role}`}>{i.role}</span>
                  {canManage && (
                    <form method="post" action={`/app/team/invites/${i.id}/revoke`}>
                      <button type="submit" class="btn btn-small btn-ghost">
                        Revoke
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {canManage ? (
        <section class="card">
          <h2>Invite someone</h2>
          <form method="post" action="/app/team/invites" class="stack">
            <Field label="Email" name="email" type="email" autocomplete="off" />
            <label class="field">
              <span class="field-label">Role</span>
              <select name="role">
                <option value="member">Member</option>
                <option value="admin">Admin (can manage team and billing)</option>
              </select>
            </label>
            <button type="submit" class="btn btn-block">
              Send invite
            </button>
          </form>
        </section>
      ) : (
        <p class="muted">Ask an owner or admin to invite or remove people.</p>
      )}
    </AppShell>
  );
}

export function BillingPage({
  org,
  user,
  notice,
  configured,
  canManage,
  availablePlans,
  error,
}: ShellProps & { configured: boolean; canManage: boolean; availablePlans: Plan["id"][]; error?: string }) {
  const now = Date.now();
  const locked = !hasAccess(org, now);
  return (
    <AppShell title="Billing" active="billing" org={org} user={user} notice={notice}>
      <h1>Billing</h1>
      {locked && (
        <p class="error" role="alert">
          Your free trial has ended. Choose a plan to keep using {APP_NAME}.
        </p>
      )}
      <ErrorText error={error} />
      <section class="card">
        <h2>Current plan</h2>
        <p class="stat">{statusLabel(org)}</p>
        {org.subscription_status !== "active" && !locked && (
          <p class="muted">Trial ends {new Date(org.trial_ends_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.</p>
        )}
        {configured && canManage && org.stripe_customer_id && (
          <form method="post" action="/app/billing/portal">
            <button type="submit" class="btn btn-ghost">
              Manage billing and invoices
            </button>
          </form>
        )}
      </section>

      {!configured ? (
        <p class="notice">Billing is not configured yet. Everything else works as normal.</p>
      ) : !canManage ? (
        <p class="muted">Only owners and admins can change the plan.</p>
      ) : null}

      <div class="plans">
        {PLANS.map((plan) => {
          const available = configured && canManage && availablePlans.includes(plan.id);
          return (
            <div class="plan">
              <h3>{plan.name}</h3>
              <p class="price">
                ${plan.monthlyUsd}
                <span>/month</span>
              </p>
              <ul>
                {plan.features.map((f) => (
                  <li>{f}</li>
                ))}
              </ul>
              <form method="post" action="/app/billing/checkout">
                <input type="hidden" name="plan" value={plan.id} />
                <button type="submit" class="btn btn-block" disabled={!available || org.subscription_status === "active"}>
                  {org.subscription_status === "active" ? "Change in billing portal" : `Choose ${plan.name}`}
                </button>
              </form>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}

export function SettingsPage({
  org,
  user,
  notice,
  canManage,
  orgs,
  error,
}: ShellProps & { canManage: boolean; orgs: { id: string; name: string; role: Role }[]; error?: string }) {
  return (
    <AppShell title="Settings" active="settings" org={org} user={user} notice={notice}>
      <h1>Settings</h1>
      <ErrorText error={error} />
      <section class="card">
        <h2>Organization</h2>
        {canManage ? (
          <form method="post" action="/app/settings" class="stack">
            <Field label="Organization name" name="name" value={org.name} autocomplete="organization" />
            <button type="submit" class="btn">
              Save
            </button>
          </form>
        ) : (
          <p>{org.name}</p>
        )}
      </section>
      {orgs.length > 1 && (
        <section class="card">
          <h2>Your organizations</h2>
          <ul class="list">
            {orgs.map((o) => (
              <li class="list-row">
                <div>
                  <strong>{o.name}</strong>
                  <div class="muted">{o.role}</div>
                </div>
                {o.id === org.id ? (
                  <span class="pill">current</span>
                ) : (
                  <form method="post" action="/app/orgs/switch">
                    <input type="hidden" name="org_id" value={o.id} />
                    <button type="submit" class="btn btn-small btn-ghost">
                      Switch
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section class="card">
        <h2>Your account</h2>
        <p>
          {user.name} · {user.email}
        </p>
      </section>
    </AppShell>
  );
}
