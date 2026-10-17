import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { get, inviteLink, orgIdFor, post, sessionCookie, signup } from "./helpers";

const membership = (orgId: string, email: string) =>
  env.DB.prepare("SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?").bind(orgId, email).first<string>("role");

describe("team invites", () => {
  it("invites a new user, who accepts and joins as member; members cannot manage the team", async () => {
    const owner = await signup("Gus", "gus@example.com", "Gus Excavation");
    const orgId = await orgIdFor("gus@example.com");
    const invite = await post("/app/team/invites", { email: "hal@example.com", role: "member" }, { cookie: owner });
    expect(invite.status).toBe(200);
    const link = await inviteLink(invite);

    const page = await get(link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Join Gus Excavation");

    const accept = await post(link, { name: "Hal", password: "hal-password-1" });
    expect(accept.status).toBe(302);
    expect(accept.headers.get("Location")).toBe("/app");
    expect(await membership(orgId, "hal@example.com")).toBe("member");
    expect((await post(link, { name: "Hal", password: "hal-password-1" })).status).toBe(410);

    const hal = sessionCookie(accept);
    const forbidden = await post("/app/team/invites", { email: "ivy@example.com", role: "admin" }, { cookie: hal });
    expect(forbidden.status).toBe(403);
    const ivyInvites = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE email = 'ivy@example.com'").first<number>("n");
    expect(ivyInvites).toBe(0);
  });

  it("lets an existing user accept with their password, switch orgs, and fall back when removed", async () => {
    const owner = await signup("Jo", "jo@example.com", "Jo Masonry");
    let kim = await signup("Kim", "kim@example.com", "Kim Tile");
    const joOrg = await orgIdFor("jo@example.com");
    const link = await inviteLink(await post("/app/team/invites", { email: "kim@example.com", role: "admin" }, { cookie: owner }));

    expect((await post(link, { password: "wrong" })).status).toBe(401);
    const accept = await post(link, { password: "correct horse battery" }, { cookie: kim });
    expect(accept.status).toBe(302);
    kim = sessionCookie(accept);
    expect(await membership(joOrg, "kim@example.com")).toBe("admin");
    expect(await (await get("/app", kim)).text()).toContain("Jo Masonry");

    const kimId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'kim@example.com'").first<string>("id"))!;
    expect((await post(`/app/team/members/${kimId}/remove`, {}, { cookie: owner })).status).toBe(302);
    expect(await membership(joOrg, "kim@example.com")).toBe(null);
    const fallback = await (await get("/app", kim)).text();
    expect(fallback).toContain("Kim Tile");
    expect(fallback).not.toContain("Jo Masonry");
  });
});

describe("tenant isolation", () => {
  it("a user of org B cannot read or change org A data through any /app route", async () => {
    const alice = await signup("Alice", "alice@example.com", "Alpha Builders");
    const bob = await signup("Bob", "bob@example.com", "Bravo Remodeling");
    const orgA = await orgIdFor("alice@example.com");
    const orgB = await orgIdFor("bob@example.com");

    const carolLink = await inviteLink(await post("/app/team/invites", { email: "carol@example.com", role: "member" }, { cookie: alice }));
    await post(carolLink, { name: "Carol", password: "carol-password" });
    await post("/app/team/invites", { email: "dave@example.com", role: "member" }, { cookie: alice });
    const carolId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'carol@example.com'").first<string>("id"))!;
    const daveInviteId = (await env.DB.prepare("SELECT id FROM invites WHERE email = 'dave@example.com'").first<string>("id"))!;

    for (const path of ["/app", "/app/team", "/app/billing", "/app/settings"]) {
      const res = await get(path, bob);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Bravo Remodeling");
      for (const leak of ["Alpha Builders", "alice@example.com", "carol@example.com", "dave@example.com"]) expect(html).not.toContain(leak);
    }

    const remove = await post(`/app/team/members/${carolId}/remove`, {}, { cookie: bob });
    expect(remove.status).toBe(404);
    expect(await membership(orgA, "carol@example.com")).toBe("member");

    const revoke = await post(`/app/team/invites/${daveInviteId}/revoke`, {}, { cookie: bob });
    expect(revoke.status).toBe(404);
    const daveInvite = await env.DB.prepare("SELECT org_id FROM invites WHERE id = ?").bind(daveInviteId).first<string>("org_id");
    expect(daveInvite).toBe(orgA);

    const sw = await post("/app/orgs/switch", { org_id: orgA }, { cookie: bob });
    expect(sw.status).toBe(404);
    expect(await (await get("/app", bob)).text()).toContain("Bravo Remodeling");

    expect((await post("/app/settings", { name: "Renamed by Bob" }, { cookie: bob })).status).toBe(302);
    const names = await env.DB.prepare("SELECT id, name FROM orgs WHERE id IN (?, ?) ORDER BY name").bind(orgA, orgB).all<{ id: string; name: string }>();
    expect(names.results).toEqual([
      { id: orgA, name: "Alpha Builders" },
      { id: orgB, name: "Renamed by Bob" },
    ]);
  });
});
