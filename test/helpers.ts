import { env, exports } from "cloudflare:workers";

export const ORIGIN = "https://example.com";

export function get(path: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
}

export function post(path: string, form: Record<string, string>, opts: { cookie?: string; origin?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.Origin = origin;
  return exports.default.fetch(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(form), redirect: "manual" });
}

export function sessionCookie(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith("__Host-session="));
  if (!header) throw new Error(`no session cookie (status ${res.status})`);
  return header.split(";")[0]!;
}

export async function signup(name: string, email: string, orgName: string, password = "correct horse battery"): Promise<string> {
  const res = await post("/signup", { name, email, org_name: orgName, password });
  if (res.status !== 302) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return sessionCookie(res);
}

export async function orgIdFor(email: string): Promise<string> {
  const id = await env.DB.prepare("SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.role = 'owner'")
    .bind(email)
    .first<string>("org_id");
  if (!id) throw new Error(`no org for ${email}`);
  return id;
}

export async function inviteLink(res: Response): Promise<string> {
  const match = (await res.text()).match(/href="http:\/\/localhost:8787(\/invite\/[\w-]+)"/);
  if (!match) throw new Error("no dev invite link on page");
  return match[1]!;
}
