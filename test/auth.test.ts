import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { get, post, sessionCookie, signup } from "./helpers";

describe("signup, login, sessions", () => {
  it("signup creates user, org, owner membership and a 14-day trial, then login reaches /app", async () => {
    const signupRes = await post("/signup", { name: "Ada Builder", email: "Ada@Example.com", org_name: "Ada Framing LLC", password: "s3cret-password" });
    expect(signupRes.status).toBe(302);
    expect(signupRes.headers.get("Location")).toBe("/app");
    const setCookie = signupRes.headers.getSetCookie()[0]!;
    expect(setCookie).toMatch(/^__Host-session=[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);

    const row = await env.DB.prepare(
      `SELECT u.email, u.name, u.password_hash, o.name AS org_name, o.slug, o.subscription_status, o.trial_ends_at - o.created_at AS trial_ms, m.role
       FROM users u JOIN memberships m ON m.user_id = u.id JOIN orgs o ON o.id = m.org_id WHERE u.email = 'ada@example.com'`,
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      email: "ada@example.com",
      name: "Ada Builder",
      org_name: "Ada Framing LLC",
      slug: "ada-framing-llc",
      subscription_status: "trialing",
      trial_ms: 1_209_600_000,
      role: "owner",
    });
    expect(String(row!.password_hash)).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);

    const loginRes = await post("/login", { email: "ADA@example.com", password: "s3cret-password" });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.get("Location")).toBe("/app");

    const app = await get("/app", sessionCookie(loginRes));
    expect(app.status).toBe(200);
    const html = await app.text();
    expect(html).toContain("Bill your first pay application in minutes");
    expect(html).toContain("Ada Framing LLC");
  });

  it("rejects a wrong password and an unknown email with the same 401 and no session", async () => {
    await signup("Bea", "bea@example.com", "Bea Concrete");
    for (const creds of [
      { email: "bea@example.com", password: "wrong password" },
      { email: "nobody@example.com", password: "correct horse battery" },
    ]) {
      const res = await post("/login", creds);
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.text()).toContain("Incorrect email or password.");
    }
  });

  it("refuses a duplicate email on signup", async () => {
    await signup("Cy", "cy@example.com", "Cy Roofing");
    const res = await post("/signup", { name: "Cy Two", email: "CY@example.com", org_name: "Other", password: "another-password" });
    expect(res.status).toBe(409);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = 'Other'").first<number>("n");
    expect(count).toBe(0);
  });

  it("redirects anonymous /app requests to login and logout ends the session", async () => {
    const anon = await get("/app/team");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toBe("/login?next=%2Fapp%2Fteam");

    const cookie = await signup("Dee", "dee@example.com", "Dee Electric");
    expect((await get("/app", cookie)).status).toBe(200);
    const out = await post("/logout", {}, { cookie });
    expect(out.status).toBe(302);
    const after = await get("/app", cookie);
    expect(after.status).toBe(302);
    expect(after.headers.get("Location")).toBe("/login?next=%2Fapp");
  });

  it("resets a password through the emailed link, which works once and signs out old sessions", async () => {
    const oldCookie = await signup("Eve", "eve@example.com", "Eve Plumbing");
    const forgot = await post("/forgot", { email: "eve@example.com" });
    const link = (await forgot.text()).match(/href="http:\/\/localhost:8787(\/reset\/[\w-]+)"/)![1]!;

    const reset = await post(link, { password: "brand-new-password" });
    expect(reset.status).toBe(302);
    expect(reset.headers.get("Location")).toBe("/login?notice=password_reset");
    expect((await post(link, { password: "again-new-password" })).status).toBe(410);
    expect((await get("/app", oldCookie)).status).toBe(302);
    expect((await post("/login", { email: "eve@example.com", password: "correct horse battery" })).status).toBe(401);
    expect((await post("/login", { email: "eve@example.com", password: "brand-new-password" })).status).toBe(302);
  });
});

describe("CSRF origin check", () => {
  it("rejects POSTs with a missing or foreign Origin and accepts same-origin", async () => {
    const cookie = await signup("Fay", "fay@example.com", "Fay Drywall");
    const orgName = () => env.DB.prepare("SELECT o.name FROM orgs o JOIN memberships m ON m.org_id = o.id JOIN users u ON u.id = m.user_id WHERE u.email = 'fay@example.com'").first<string>("name");

    const foreign = await post("/app/settings", { name: "Hacked" }, { cookie, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toBe("Forbidden: cross-origin request");
    const missing = await post("/app/settings", { name: "Hacked" }, { cookie, origin: null });
    expect(missing.status).toBe(403);
    expect(await orgName()).toBe("Fay Drywall");

    const same = await post("/app/settings", { name: "Fay Drywall & Paint" }, { cookie });
    expect(same.status).toBe(302);
    expect(await orgName()).toBe("Fay Drywall & Paint");

    expect((await post("/login", { email: "fay@example.com", password: "correct horse battery" }, { origin: "https://evil.example" })).status).toBe(403);
  });
});
