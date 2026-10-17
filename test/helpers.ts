import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";

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

export const PROJECT_FORM = {
  name: "Lakeview Elementary Modernization",
  number: "24-118",
  gc_name: "Summit Builders",
  gc_contact_email: "ap@summit.example",
  owner_name: "Lakeview Unified School District",
  location: "400 Lake St, Reno",
  state: "nv",
  original_contract: "$100,000",
  retainage_work: "10",
  retainage_stored: "5",
  first_furnished_on: "2026-08-03",
  last_furnished_on: "",
};

export const SOV_PASTE = "Item\tDescription\tAmount\n1\tMobilization\t10,000.00\n2\tRough-in\t60,000.00\n3\tFixtures\t30,000.00\n\tTotal\t100,000.00";

export async function createProject(cookie: string, form: Record<string, string> = PROJECT_FORM): Promise<string> {
  const res = await post("/app/projects", form, { cookie });
  expect(res.status).toBe(302);
  return res.headers.get("Location")!.match(/^\/app\/projects\/([\w-]+)\?notice=project_created$/)![1]!;
}

export async function lineIds(projectId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM sov_lines WHERE project_id = ? ORDER BY position").bind(projectId).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function createPayApp(cookie: string, projectId: string, from: string, to: string): Promise<string> {
  const res = await post(`/app/projects/${projectId}/pay-apps`, { period_from: from, period_to: to }, { cookie });
  expect(res.status).toBe(302);
  return res.headers.get("Location")!.replace("/app/pay-apps/", "");
}

export function draftForm(ids: string[], entries: Record<number, { e?: string; f?: string; pct?: string }>, extra: Record<string, string> = {}) {
  const form: Record<string, string> = { period_from: "2026-09-01", period_to: "2026-09-30", retainage_work: "10", retainage_stored: "5", intent: "save", ...extra };
  ids.forEach((id, i) => {
    form[`e_${id}`] = entries[i]?.e ?? "0";
    form[`f_${id}`] = entries[i]?.f ?? "0";
    form[`pct_${id}`] = entries[i]?.pct ?? "x";
    form[`pct0_${id}`] = "x";
  });
  return form;
}

export async function shareToken(res: Response): Promise<string> {
  const match = (await res.text()).match(/value="https:\/\/example\.com\/s\/([\w-]{43})"/);
  if (!match) throw new Error("no share link on page");
  return match[1]!;
}
