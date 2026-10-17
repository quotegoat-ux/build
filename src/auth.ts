import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomId, sha256Hex } from "./crypto";
import { deleteSession, insertSession, loadSession, type Org, type Role, type Tenant, type User } from "./db";
import type { Env } from "./env";
import { hasAccess } from "./billing";

export type PublicEnv = { Bindings: Env };
export type AppEnv = { Bindings: Env; Variables: { tenant: Tenant; user: User; org: Org; sessionId: string } };

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PERMISSIONS = {
  manageTeam: ["owner", "admin"],
  manageBilling: ["owner", "admin"],
  manageOrg: ["owner", "admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(t: Tenant, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(t.role);
}

/** Rotates: any session the request already carries is revoked, so a pre-login token can't be fixated. */
export async function startSession(c: Context, userId: string, orgId: string) {
  const previous = getCookie(c, SESSION_COOKIE, "host");
  if (previous) await deleteSession(c.env.DB, await sha256Hex(previous));
  const token = randomId(32);
  const now = Date.now();
  await insertSession(c.env.DB, { id: await sha256Hex(token), userId, orgId, expiresAt: now + SESSION_TTL_MS, now });
  setCookie(c, SESSION_COOKIE, token, {
    prefix: "host",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function endSession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE, "host");
  if (token) await deleteSession(c.env.DB, await sha256Hex(token));
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
}

export async function currentSession<E extends PublicEnv>(c: Context<E>) {
  const token = getCookie(c, SESSION_COOKIE, "host");
  if (!token) return null;
  const sessionId = await sha256Hex(token);
  const session = await loadSession(c.env.DB, sessionId, Date.now());
  return session && { ...session, sessionId };
}

const ALWAYS_REACHABLE = ["/app/billing", "/app/team", "/app/settings", "/app/orgs", "/app/export", "/app/export.json"];

export const requireTenant: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await currentSession(c);
  if (!session) {
    const query = c.req.method === "GET" ? `?next=${encodeURIComponent(c.req.path)}` : "";
    return c.redirect(`/login${query}`);
  }
  c.set("tenant", session.tenant);
  c.set("user", session.user);
  c.set("org", session.org);
  c.set("sessionId", session.sessionId);
  const path = c.req.path;
  if (!hasAccess(session.org, Date.now()) && !ALWAYS_REACHABLE.some((p) => path === p || path.startsWith(`${p}/`))) {
    return c.redirect("/app/billing");
  }
  await next();
};

/** Rejects cross-site state changes: non-GET requests must carry an Origin matching this host. */
export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.path === "/webhooks/stripe") return next();
  const origin = c.req.header("Origin");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {}
  if (originHost !== new URL(c.req.url).host) return c.text("Forbidden: cross-origin request", 403);
  await next();
};

export function safeNext(next: string | undefined): string {
  return next && next.startsWith("/app") && !next.startsWith("//") ? next : "/app";
}
