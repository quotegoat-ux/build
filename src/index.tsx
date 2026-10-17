import { Hono, type Context } from "hono";
import styles from "./styles.css";
import { can, currentSession, endSession, requireTenant, safeNext, sameOriginOnly, startSession, type AppEnv, type PublicEnv } from "./auth";
import { TRIAL_DAYS, billingConfigured, createCheckoutUrl, createPortalUrl, handleStripeEvent, verifyStripeSignature } from "./billing";
import { DUMMY_PASSWORD_HASH, hashPassword, randomId, sha256Hex, verifyPassword } from "./crypto";
import * as db from "./db";
import { sendEmail, linkEmail } from "./email";
import { APP_NAME, isLocalDev, type Env } from "./env";
import { sendReminders } from "./reminders";
import { drawbook, shared } from "./routes";
import { BillingPage, SettingsPage, TeamPage } from "./views/app";
import { noticeFrom, render } from "./views/layout";
import { AcceptInvitePage, ForgotPage, Landing, LoginPage, MessagePage, ResetPage, SignupPage, notFound } from "./views/public";

const DAY_MS = 86_400_000;
const INVITE_TTL_MS = 7 * DAY_MS;
const RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Form = Record<string, string | File>;

function field(form: Form, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v.trim() : "";
}

function passwordError(password: string): string | undefined {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 256) return "Password is too long.";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "org";
}

/** In local dev without an email provider, the link is shown on screen so flows work end to end. */
function devLinkFor(env: Env, sent: { status: "sent" | "logged" }, url: string): string | undefined {
  return sent.status === "logged" && isLocalDev(env) ? url : undefined;
}

function forbidden(c: Context) {
  return render(c, <MessagePage title="Not allowed" status={403} message="Only owners and admins can do that." />, 403);
}

const app = new Hono<PublicEnv>();

app.use(sameOriginOnly);

app.get("/", (c) => render(c, <Landing />));

app.get("/styles.css", (c) => c.body(styles, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" }));

app.get("/signup", async (c) => ((await currentSession(c)) ? c.redirect("/app") : render(c, <SignupPage />)));

app.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const values = { name: field(form, "name"), org_name: field(form, "org_name"), email: field(form, "email").toLowerCase() };
  const password = typeof form.password === "string" ? form.password : "";
  const error =
    !values.name || !values.org_name
      ? "Please fill in your name and company name."
      : !EMAIL_RE.test(values.email)
        ? "Please enter a valid email address."
        : passwordError(password);
  if (error) return render(c, <SignupPage error={error} values={values} />, 422);

  let slug = slugify(values.org_name);
  if (await db.slugTaken(c.env.DB, slug)) slug = `${slug}-${randomId(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const now = Date.now();
  const ids = { userId: randomId(), orgId: randomId() };
  const result = await db.createAccount(c.env.DB, {
    ...ids,
    slug,
    name: values.name,
    email: values.email,
    orgName: values.org_name,
    passwordHash: await hashPassword(password),
    trialEndsAt: now + TRIAL_DAYS * DAY_MS,
    now,
  });
  if (result === "email_taken") {
    return render(c, <SignupPage error="An account with that email already exists. Try logging in." values={values} />, 409);
  }
  await startSession(c, ids.userId, ids.orgId);
  return c.redirect("/app");
});

app.get("/login", async (c) => {
  if (await currentSession(c)) return c.redirect(safeNext(c.req.query("next")));
  return render(c, <LoginPage next={c.req.query("next")} notice={noticeFrom(c.req.query("notice"))} />);
});

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = field(form, "email").toLowerCase();
  const password = typeof form.password === "string" ? form.password : "";
  const user = await db.findUserByEmail(c.env.DB, email);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  const orgId = user && ok ? await db.firstOrgIdForUser(c.env.DB, user.id) : null;
  if (!user || !orgId) {
    return render(c, <LoginPage error="Incorrect email or password." email={email} next={c.req.query("next")} />, 401);
  }
  await startSession(c, user.id, orgId);
  return c.redirect(safeNext(c.req.query("next")));
});

app.post("/logout", async (c) => {
  await endSession(c);
  return c.redirect("/login");
});

app.get("/forgot", (c) => render(c, <ForgotPage />));

app.post("/forgot", async (c) => {
  const email = field(await c.req.parseBody(), "email").toLowerCase();
  const user = await db.findUserByEmail(c.env.DB, email);
  if (!user) return render(c, <ForgotPage sent />);
  const token = randomId(32);
  await db.insertPasswordReset(c.env.DB, { tokenHash: await sha256Hex(token), userId: user.id, expiresAt: Date.now() + RESET_TTL_MS });
  const url = `${c.env.APP_URL}/reset/${token}`;
  const sent = await sendEmail(c.env, {
    to: user.email,
    subject: `Reset your ${APP_NAME} password`,
    html: linkEmail({
      heading: "Reset your password",
      body: `Someone asked to reset the password for ${user.email}. If that was you, use the button below. The link expires in one hour.`,
      cta: "Choose a new password",
      url,
      footer: "If you didn't ask for this, you can ignore this email.",
    }),
  });
  return render(c, <ForgotPage sent devLink={devLinkFor(c.env, sent, url)} />);
});

app.get("/reset/:token", async (c) => {
  const token = c.req.param("token");
  if (!(await db.passwordResetIsValid(c.env.DB, await sha256Hex(token), Date.now()))) {
    return render(c, <MessagePage title="Link expired" message="This reset link is invalid or has expired. Request a new one." />, 410);
  }
  return render(c, <ResetPage token={token} />);
});

app.post("/reset/:token", async (c) => {
  const token = c.req.param("token");
  const form = await c.req.parseBody();
  const password = typeof form.password === "string" ? form.password : "";
  const error = passwordError(password);
  if (error) return render(c, <ResetPage token={token} error={error} />, 422);
  const ok = await db.resetPassword(c.env.DB, await sha256Hex(token), await hashPassword(password), Date.now());
  if (!ok) return render(c, <MessagePage title="Link expired" message="This reset link is invalid or has expired. Request a new one." />, 410);
  return c.redirect("/login?notice=password_reset");
});

app.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const invite = await db.findPendingInvite(c.env.DB, await sha256Hex(token), Date.now());
  if (!invite) return render(c, <MessagePage title="Invite not found" message="This invite is invalid, expired, or already used." />, 410);
  const existingUser = (await db.findUserByEmail(c.env.DB, invite.email)) !== null;
  return render(c, <AcceptInvitePage invite={invite} token={token} existingUser={existingUser} />);
});

app.post("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const now = Date.now();
  const invite = await db.findPendingInvite(c.env.DB, await sha256Hex(token), now);
  if (!invite) return render(c, <MessagePage title="Invite not found" message="This invite is invalid, expired, or already used." />, 410);
  const form = await c.req.parseBody();
  const password = typeof form.password === "string" ? form.password : "";
  const existing = await db.findUserByEmail(c.env.DB, invite.email);

  let userId: string;
  if (existing) {
    if (!(await verifyPassword(password, existing.password_hash))) {
      return render(c, <AcceptInvitePage invite={invite} token={token} existingUser error="Incorrect password." />, 401);
    }
    userId = existing.id;
    await db.acceptInvite(c.env.DB, invite, { id: userId }, now);
  } else {
    const name = field(form, "name");
    const error = name ? passwordError(password) : "Please enter your name.";
    if (error) return render(c, <AcceptInvitePage invite={invite} token={token} existingUser={false} error={error} />, 422);
    userId = randomId();
    await db.acceptInvite(c.env.DB, invite, { id: userId, name, passwordHash: await hashPassword(password) }, now);
  }
  await startSession(c, userId, invite.org_id);
  return c.redirect("/app");
});

app.post("/webhooks/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.text("Stripe webhooks are not configured", 503);
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(secret, payload, c.req.header("Stripe-Signature"), Date.now()))) {
    return c.text("Invalid signature", 400);
  }
  const result = await handleStripeEvent(c.env.DB, JSON.parse(payload));
  return c.json({ received: true, result });
});

const authed = new Hono<AppEnv>();

authed.use(requireTenant);

authed.route("/", drawbook);

async function renderTeam(c: Context<AppEnv>, extra: { notice?: string; error?: string; devLink?: string } = {}, status: 200 | 409 | 422 = 200) {
  const t = c.var.tenant;
  const [members, invites] = await Promise.all([db.listMembers(t, c.env.DB), db.listPendingInvites(t, c.env.DB, Date.now())]);
  return render(
    c,
    <TeamPage org={c.var.org} user={c.var.user} members={members} invites={invites} canManage={can(t, "manageTeam")} {...extra} />,
    status,
  );
}

authed.get("/team", (c) => renderTeam(c, { notice: noticeFrom(c.req.query("notice")) }));

authed.post("/team/invites", async (c) => {
  const t = c.var.tenant;
  if (!can(t, "manageTeam")) return forbidden(c);
  const form = await c.req.parseBody();
  const email = field(form, "email").toLowerCase();
  const role = field(form, "role") === "admin" ? "admin" : "member";
  if (!EMAIL_RE.test(email)) return renderTeam(c, { error: "Please enter a valid email address." }, 422);
  const token = randomId(32);
  const now = Date.now();
  const result = await db.createInvite(t, c.env.DB, { id: randomId(), email, role, tokenHash: await sha256Hex(token), expiresAt: now + INVITE_TTL_MS, now });
  if (result === "already_member") return renderTeam(c, { error: `${email} is already on the team.` }, 409);
  const url = `${c.env.APP_URL}/invite/${token}`;
  const sent = await sendEmail(c.env, {
    to: email,
    subject: `${c.var.user.name} invited you to ${c.var.org.name} on ${APP_NAME}`,
    html: linkEmail({
      heading: `Join ${c.var.org.name} on ${APP_NAME}`,
      body: `${c.var.user.name} invited you to join ${c.var.org.name} as ${role === "admin" ? "an admin" : "a member"}.`,
      cta: "Accept invite",
      url,
      footer: "This invite expires in 7 days.",
    }),
  });
  const devLink = devLinkFor(c.env, sent, url);
  return devLink ? renderTeam(c, { notice: noticeFrom("invited"), devLink }) : c.redirect("/app/team?notice=invited");
});

authed.post("/team/members/:userId/remove", async (c) => {
  const t = c.var.tenant;
  if (!can(t, "manageTeam")) return forbidden(c);
  const userId = c.req.param("userId");
  if (userId === t.userId || !(await db.removeMember(t, c.env.DB, userId))) return notFound(c);
  return c.redirect("/app/team?notice=member_removed");
});

authed.post("/team/invites/:id/revoke", async (c) => {
  const t = c.var.tenant;
  if (!can(t, "manageTeam")) return forbidden(c);
  if (!(await db.revokeInvite(t, c.env.DB, c.req.param("id")))) return notFound(c);
  return c.redirect("/app/team?notice=invite_revoked");
});

function renderBilling(c: Context<AppEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 502 = 200) {
  return render(c, <BillingPage org={c.var.org} user={c.var.user} configured={billingConfigured(c.env)} canManage={can(c.var.tenant, "manageBilling")} {...extra} />, status);
}

authed.get("/billing", (c) => renderBilling(c, { notice: noticeFrom(c.req.query("notice")) }));

authed.post("/billing/checkout", async (c) => {
  if (!can(c.var.tenant, "manageBilling")) return forbidden(c);
  if (!billingConfigured(c.env)) return renderBilling(c, { error: "Billing is not available right now." }, 502);
  try {
    return c.redirect(await createCheckoutUrl(c.env, c.var.org, c.var.user.email), 303);
  } catch (e) {
    console.error(e);
    return renderBilling(c, { error: "We couldn't reach the payment provider. Please try again." }, 502);
  }
});

authed.post("/billing/portal", async (c) => {
  const customerId = c.var.org.stripe_customer_id;
  if (!can(c.var.tenant, "manageBilling")) return forbidden(c);
  if (!billingConfigured(c.env) || !customerId) return renderBilling(c, { error: "There is no billing account to manage yet." }, 502);
  try {
    return c.redirect(await createPortalUrl(c.env, customerId), 303);
  } catch (e) {
    console.error(e);
    return renderBilling(c, { error: "We couldn't reach the payment provider. Please try again." }, 502);
  }
});

async function renderSettings(c: Context<AppEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 422 = 200) {
  const t = c.var.tenant;
  const orgs = await db.listUserOrgs(t, c.env.DB);
  return render(c, <SettingsPage org={c.var.org} user={c.var.user} canManage={can(t, "manageOrg")} orgs={orgs} {...extra} />, status);
}

authed.get("/settings", (c) => renderSettings(c, { notice: noticeFrom(c.req.query("notice")) }));

authed.post("/settings", async (c) => {
  const t = c.var.tenant;
  if (!can(t, "manageOrg")) return forbidden(c);
  const name = field(await c.req.parseBody(), "name");
  if (!name || name.length > 100) return renderSettings(c, { error: "Organization name must be 1 to 100 characters." }, 422);
  await db.renameOrg(t, c.env.DB, name);
  return c.redirect("/app/settings?notice=saved");
});

authed.post("/orgs/switch", async (c) => {
  const orgId = field(await c.req.parseBody(), "org_id");
  if (!(await db.switchOrg(c.var.tenant, c.env.DB, c.var.sessionId, orgId))) return notFound(c);
  return c.redirect("/app?notice=switched");
});

app.route("/app", authed);

app.route("/s", shared);

app.notFound(notFound);

app.onError((err, c) => {
  console.error(err);
  return render(c, <MessagePage title="Something went wrong" status={500} message="Please try again in a moment." />, 500);
});

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendReminders(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
