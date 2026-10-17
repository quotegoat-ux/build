import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { get, orgIdFor, post, signup } from "./helpers";

const PROJECT_FORM = {
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

const SOV_PASTE = "Item\tDescription\tAmount\n1\tMobilization\t10,000.00\n2\tRough-in\t60,000.00\n3\tFixtures\t30,000.00\n\tTotal\t100,000.00";

async function createProject(cookie: string, form: Record<string, string> = PROJECT_FORM): Promise<string> {
  const res = await post("/app/projects", form, { cookie });
  expect(res.status).toBe(302);
  return res.headers.get("Location")!.match(/^\/app\/projects\/([\w-]+)\?notice=project_created$/)![1]!;
}

async function lineIds(projectId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM sov_lines WHERE project_id = ? ORDER BY position").bind(projectId).all<{ id: string }>();
  return results.map((r) => r.id);
}

async function createPayApp(cookie: string, projectId: string, from: string, to: string): Promise<string> {
  const res = await post(`/app/projects/${projectId}/pay-apps`, { period_from: from, period_to: to }, { cookie });
  expect(res.status).toBe(302);
  return res.headers.get("Location")!.replace("/app/pay-apps/", "");
}

function draftForm(ids: string[], entries: Record<number, { e?: string; f?: string; pct?: string }>, extra: Record<string, string> = {}) {
  const form: Record<string, string> = { period_from: "2026-09-01", period_to: "2026-09-30", retainage_work: "10", retainage_stored: "5", intent: "save", ...extra };
  ids.forEach((id, i) => {
    form[`e_${id}`] = entries[i]?.e ?? "0";
    form[`f_${id}`] = entries[i]?.f ?? "0";
    form[`pct_${id}`] = entries[i]?.pct ?? "x";
    form[`pct0_${id}`] = "x";
  });
  return form;
}

const payApp = (id: string) =>
  env.DB.prepare("SELECT number, status, submitted_at IS NOT NULL AS submitted, paid_cents, paid_at, share_token_hash IS NOT NULL AS shared FROM pay_apps WHERE id = ?").bind(id).first();

const appLines = async (id: string) =>
  (
    await env.DB.prepare("SELECT s.item_no, l.work_this_period_cents AS e, l.stored_to_date_cents AS f FROM pay_app_lines l JOIN sov_lines s ON s.id = l.sov_line_id WHERE l.pay_app_id = ? ORDER BY s.position")
      .bind(id)
      .all()
  ).results;

async function shareToken(res: Response): Promise<string> {
  const match = (await res.text()).match(/value="https:\/\/example\.com\/s\/([\w-]{43})"/);
  if (!match) throw new Error("no share link on page");
  return match[1]!;
}

async function submittedApp(cookie: string) {
  const projectId = await createProject(cookie);
  await post(`/app/projects/${projectId}/sov/paste`, { paste: SOV_PASTE }, { cookie });
  const ids = await lineIds(projectId);
  const appId = await createPayApp(cookie, projectId, "2026-09-01", "2026-09-30");
  const res = await post(`/app/pay-apps/${appId}`, draftForm(ids, { 0: { e: "10000" }, 1: { e: "15,000" }, 2: { f: "8000" } }, { intent: "submit" }), { cookie });
  expect(res.status).toBe(200);
  return { projectId, ids, appId, token: await shareToken(res) };
}

describe("projects", () => {
  it("creates, validates, edits, and lists a project with literal stored values", async () => {
    const cookie = await signup("Gil", "gil@example.com", "Gil Electric");
    const bad = await post("/app/projects", { ...PROJECT_FORM, retainage_work: "120" }, { cookie });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain("Retainage must be a percentage between 0 and 100.");

    const id = await createProject(cookie);
    expect(await env.DB.prepare("SELECT name, state, original_contract_cents, retainage_work_bp, retainage_stored_bp, first_furnished_on, last_furnished_on, status FROM projects WHERE id = ?").bind(id).first()).toEqual({
      name: "Lakeview Elementary Modernization",
      state: "NV",
      original_contract_cents: 10_000_000,
      retainage_work_bp: 1000,
      retainage_stored_bp: 500,
      first_furnished_on: "2026-08-03",
      last_furnished_on: null,
      status: "active",
    });

    expect(await (await get(`/app/projects/${id}/edit`, cookie)).text()).toContain('value="100000.00"');
    const edit = await post(`/app/projects/${id}`, { ...PROJECT_FORM, original_contract: "125,500.25", status: "closed" }, { cookie });
    expect(edit.status).toBe(302);
    expect(await env.DB.prepare("SELECT original_contract_cents, status FROM projects WHERE id = ?").bind(id).first()).toEqual({ original_contract_cents: 12_550_025, status: "closed" });

    const list = await (await get("/app/projects", cookie)).text();
    expect(list).toContain("Lakeview Elementary Modernization");
    expect(list).toContain("Summit Builders · 400 Lake St, Reno");
  });
});

describe("schedule of values", () => {
  it("adds pasted Excel rows in order, rejects a paste with a bad row, and edits, moves, and deletes lines", async () => {
    const cookie = await signup("Hana", "hana@example.com", "Hana Mechanical");
    const id = await createProject(cookie);
    const badPaste = await post(`/app/projects/${id}/sov/paste`, { paste: "1\tDuctwork\t40,000\n2\tControls\tTBD" }, { cookie });
    expect(badPaste.status).toBe(422);
    expect(await badPaste.text()).toContain("Nothing was added. These rows need an item, a description, and an amount: row 2.");
    expect(await lineIds(id)).toEqual([]);

    expect((await post(`/app/projects/${id}/sov/paste`, { paste: SOV_PASTE }, { cookie })).status).toBe(302);
    const rows = () => env.DB.prepare("SELECT position, item_no, description, scheduled_cents FROM sov_lines WHERE project_id = ? ORDER BY position").bind(id).all().then((r) => r.results);
    expect(await rows()).toEqual([
      { position: 1, item_no: "1", description: "Mobilization", scheduled_cents: 1_000_000 },
      { position: 2, item_no: "2", description: "Rough-in", scheduled_cents: 6_000_000 },
      { position: 3, item_no: "3", description: "Fixtures", scheduled_cents: 3_000_000 },
    ]);

    const [l1, , l3] = await lineIds(id);
    expect((await post(`/app/sov/${l3}`, { item_no: "3", description: "Light fixtures", scheduled: "29,000" }, { cookie })).status).toBe(302);
    expect((await post(`/app/sov/${l3}/move`, { direction: "up" }, { cookie })).status).toBe(302);
    expect((await post(`/app/sov/${l1}/delete`, {}, { cookie })).status).toBe(302);
    expect((await post(`/app/projects/${id}/sov`, { item_no: "4", description: "Temporary power", scheduled: "2500" }, { cookie })).status).toBe(302);
    expect(await rows()).toEqual([
      { position: 2, item_no: "3", description: "Light fixtures", scheduled_cents: 2_900_000 },
      { position: 3, item_no: "2", description: "Rough-in", scheduled_cents: 6_000_000 },
      { position: 4, item_no: "4", description: "Temporary power", scheduled_cents: 250_000 },
    ]);
  });

  it("approving a change order adds a schedule line and raises the contract sum; rejecting does not", async () => {
    const cookie = await signup("Ivo", "ivo@example.com", "Ivo Drywall");
    const id = await createProject(cookie);
    await post(`/app/projects/${id}/change-orders`, { title: "Add soffits at corridor B", amount: "5,000" }, { cookie });
    await post(`/app/projects/${id}/change-orders`, { title: "Credit for deleted bulkhead", amount: "-1,250" }, { cookie });
    const cos = (await env.DB.prepare("SELECT id FROM change_orders WHERE project_id = ? ORDER BY number").bind(id).all<{ id: string }>()).results;
    expect((await post(`/app/change-orders/${cos[0]!.id}/approve`, {}, { cookie })).status).toBe(302);
    expect((await post(`/app/change-orders/${cos[0]!.id}/approve`, {}, { cookie })).status).toBe(404);
    expect((await post(`/app/change-orders/${cos[1]!.id}/reject`, {}, { cookie })).status).toBe(302);

    expect((await env.DB.prepare("SELECT number, status, approved_at IS NOT NULL AS approved FROM change_orders WHERE project_id = ? ORDER BY number").bind(id).all()).results).toEqual([
      { number: 1, status: "approved", approved: 1 },
      { number: 2, status: "rejected", approved: 0 },
    ]);
    expect((await env.DB.prepare("SELECT item_no, description, scheduled_cents, change_order_id FROM sov_lines WHERE project_id = ?").bind(id).all()).results).toEqual([
      { item_no: "CO-1", description: "Add soffits at corridor B", scheduled_cents: 500_000, change_order_id: cos[0]!.id },
    ]);
    const page = await (await get(`/app/projects/${id}`, cookie)).text();
    expect(page).toContain("<dt>Contract sum to date</dt><dd>$105,000.00</dd>");
  });
});

describe("pay applications", () => {
  it("creates a draft, saves amounts and percent complete, blocks an invalid submit, then submits and locks", async () => {
    const cookie = await signup("Jun", "jun@example.com", "Jun Electric");
    const projectId = await createProject(cookie);
    await post(`/app/projects/${projectId}/sov/paste`, { paste: SOV_PASTE }, { cookie });
    const ids = await lineIds(projectId);
    const appId = await createPayApp(cookie, projectId, "2026-09-01", "2026-09-30");
    expect(await payApp(appId)).toEqual({ number: 1, status: "draft", submitted: 0, paid_cents: null, paid_at: null, shared: 0 });

    const second = await post(`/app/projects/${projectId}/pay-apps`, { period_from: "2026-10-01", period_to: "2026-10-31" }, { cookie });
    expect(second.status).toBe(409);

    const saved = await post(`/app/pay-apps/${appId}`, draftForm(ids, { 0: { e: "10,000" }, 1: { pct: "25" }, 2: { f: "8000" } }), { cookie });
    expect(saved.status).toBe(302);
    expect(await appLines(appId)).toEqual([
      { item_no: "1", e: 1_000_000, f: 0 },
      { item_no: "2", e: 1_500_000, f: 0 },
      { item_no: "3", e: 0, f: 800_000 },
    ]);
    const editor = await (await get(`/app/pay-apps/${appId}`, cookie)).text();
    expect(editor).toContain('<span class="g702-val" data-g702="currentPaymentDue">$30,100.00</span>');
    expect(editor).toContain("Checks passed.");

    const over = await post(`/app/pay-apps/${appId}`, draftForm(ids, { 0: { e: "10,000.01" } }, { intent: "submit" }), { cookie });
    expect(over.status).toBe(422);
    expect(await over.text()).toContain("Item 1 is billed past 100%: $10,000.01 against $10,000.00 scheduled.");
    expect(await payApp(appId)).toMatchObject({ status: "draft", submitted: 0 });

    const submit = await post(`/app/pay-apps/${appId}`, draftForm(ids, { 0: { e: "10000" }, 1: { e: "15000" }, 2: { f: "8000" } }, { intent: "submit" }), { cookie });
    expect(submit.status).toBe(200);
    expect(await submit.text()).toContain("https://example.com/s/");
    expect(await payApp(appId)).toEqual({ number: 1, status: "submitted", submitted: 1, paid_cents: null, paid_at: null, shared: 1 });

    expect((await post(`/app/pay-apps/${appId}`, draftForm(ids, { 0: { e: "1" } }), { cookie })).status).toBe(409);
    expect((await post(`/app/sov/${ids[0]}`, { item_no: "1", description: "Changed", scheduled: "1" }, { cookie })).status).toBe(409);
    expect((await post(`/app/sov/${ids[0]}/delete`, {}, { cookie })).status).toBe(409);
    expect(await env.DB.prepare("SELECT description, scheduled_cents FROM sov_lines WHERE id = ?").bind(ids[0]).first()).toEqual({ description: "Mobilization", scheduled_cents: 1_000_000 });
  });

  it("carries stored materials into the next app, records payment with days to pay, and only reopens the latest app", async () => {
    const cookie = await signup("Kai", "kai@example.com", "Kai Concrete");
    const { projectId, ids, appId } = await submittedApp(cookie);

    expect((await post(`/app/pay-apps/${appId}/paid`, { amount: "30,100", paid_on: "2020-01-01" }, { cookie })).status).toBe(422);
    const submittedAt = (await env.DB.prepare("SELECT submitted_at FROM pay_apps WHERE id = ?").bind(appId).first<number>("submitted_at"))!;
    const paidOn = new Date(submittedAt + 41 * 86_400_000).toISOString().slice(0, 10);
    expect((await post(`/app/pay-apps/${appId}/paid`, { amount: "30,100", paid_on: paidOn }, { cookie })).status).toBe(302);
    expect(await payApp(appId)).toMatchObject({ status: "paid", paid_cents: 3_010_000, paid_at: Date.parse(paidOn) });
    expect(await (await get(`/app/pay-apps/${appId}`, cookie)).text()).toContain(`Paid $30,100.00 on ${paidOn}, 41 days after submission.`);
    expect((await post(`/app/pay-apps/${appId}/reopen`, {}, { cookie })).status).toBe(409);

    const app2 = await createPayApp(cookie, projectId, "2026-10-01", "2026-10-31");
    expect(await appLines(app2)).toEqual([
      { item_no: "1", e: 0, f: 0 },
      { item_no: "2", e: 0, f: 0 },
      { item_no: "3", e: 0, f: 800_000 },
    ]);
    await post(`/app/pay-apps/${app2}`, draftForm(ids, { 1: { e: "20,000" }, 2: { e: "12,000" } }, { intent: "submit" }), { cookie });
    expect(await payApp(app2)).toMatchObject({ number: 2, status: "submitted" });
    const page = await (await get(`/app/pay-apps/${app2}`, cookie)).text();
    expect(page).toContain('data-g702="previousCertificates">$30,100.00</span>');
    expect(page).toContain('data-g702="currentPaymentDue">$21,200.00</span>');

    const app3 = await createPayApp(cookie, projectId, "2026-11-01", "2026-11-30");
    expect((await post(`/app/pay-apps/${app2}/reopen`, {}, { cookie })).status).toBe(409);
    expect((await post(`/app/pay-apps/${app3}/delete`, {}, { cookie })).status).toBe(302);
    expect(await payApp(app3)).toBe(null);
    expect((await post(`/app/pay-apps/${app2}/reopen`, {}, { cookie })).status).toBe(302);
    expect(await payApp(app2)).toEqual({ number: 2, status: "draft", submitted: 0, paid_cents: null, paid_at: null, shared: 0 });
  });

  it("serves the PDF and the continuation sheet CSV", async () => {
    const cookie = await signup("Lia", "lia@example.com", "Lia Tile & Stone");
    const { appId } = await submittedApp(cookie);
    const pdf = await get(`/app/pay-apps/${appId}/pdf`, cookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);

    const csv = await get(`/app/pay-apps/${appId}/csv`, cookie);
    expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(await csv.text()).toBe(
      [
        "Item,Description,Scheduled value,From previous application,This period,Materials presently stored,Completed and stored to date,Percent,Balance to finish,Retainage",
        "1,Mobilization,10000.00,0.00,10000.00,0.00,10000.00,100.00,0.00,1000.00",
        "2,Rough-in,60000.00,0.00,15000.00,0.00,15000.00,25.00,45000.00,1500.00",
        "3,Fixtures,30000.00,0.00,0.00,8000.00,8000.00,26.67,22000.00,400.00",
        ",Grand total,100000.00,0.00,25000.00,8000.00,33000.00,33.00,67000.00,2900.00",
        "",
      ].join("\r\n"),
    );
  });
});

describe("GC share link", () => {
  it("shows a noindex read-only packet without login, and stops working after revoke or regenerate", async () => {
    const cookie = await signup("Mo", "mo@example.com", "Mo Fire Protection");
    const { appId, token } = await submittedApp(cookie);
    const hash = await env.DB.prepare("SELECT share_token_hash FROM pay_apps WHERE id = ?").bind(appId).first<string>("share_token_hash");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hash).toBe(digest);

    const page = await get(`/s/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain("Lakeview Elementary Modernization · App #1");
    expect(html).toContain('data-g702="currentPaymentDue">$30,100.00</span>');
    expect(html).not.toContain("Log out");
    const pdf = await get(`/s/${token}/pdf`);
    expect(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    expect((await post(`/app/pay-apps/${appId}/share/revoke`, {}, { cookie })).status).toBe(302);
    expect((await get(`/s/${token}`)).status).toBe(404);
    expect((await get(`/s/${token}/pdf`)).status).toBe(404);

    const fresh = await shareToken(await post(`/app/pay-apps/${appId}/share`, {}, { cookie }));
    expect((await get(`/s/${fresh}`)).status).toBe(200);
    await post(`/app/pay-apps/${appId}/share`, {}, { cookie });
    expect((await get(`/s/${fresh}`)).status).toBe(404);
  });
});

describe("sample project and dashboard", () => {
  it("loads a realistic sample from the empty state and the dashboard totals it", async () => {
    const cookie = await signup("Nia", "nia@example.com", "Nia Electric");
    const load = await post("/app/sample", {}, { cookie });
    expect(load.status).toBe(302);
    expect(load.headers.get("Location")).toMatch(/^\/app\/projects\/[\w-]+\?notice=sample_loaded$/);

    const orgId = await orgIdFor("nia@example.com");
    expect((await env.DB.prepare("SELECT number, status FROM pay_apps WHERE org_id = ? ORDER BY number").bind(orgId).all()).results).toEqual([
      { number: 1, status: "paid" },
      { number: 2, status: "submitted" },
      { number: 3, status: "draft" },
    ]);
    const dash = await (await get("/app", cookie)).text();
    expect(dash).toContain('<p class="stat-label">Outstanding</p><p class="stat">$92,530.00</p>');
    expect(dash).toContain('<p class="stat-label">Retainage held</p><p class="stat">$10,645.00</p>');
    expect(dash).toContain('<p class="stat-label">Average days to pay</p><p class="stat">34</p>');
    expect(dash).toContain('<span class="age">34 days</span>');
    const list = await (await get("/app/projects", cookie)).text();
    expect(list).toContain("<dt>Billed to date</dt><dd>$212,900.00</dd>");

    const draftId = (await env.DB.prepare("SELECT id FROM pay_apps WHERE org_id = ? AND status = 'draft'").bind(orgId).first<string>("id"))!;
    expect(await (await get(`/app/pay-apps/${draftId}`, cookie)).text()).toContain("Checks passed.");
  });
});

describe("export", () => {
  it("exports every record as JSON and CSV, scoped to the org, even after the trial ends", async () => {
    const cookie = await signup("Oli", "oli@example.com", "Oli Glazing");
    await signup("Pam", "pam@example.com", "Pam Paving").then((pam) => post("/app/sample", {}, { cookie: pam }));
    const orgId = await orgIdFor("oli@example.com");
    await createProject(cookie);
    await env.DB.prepare("UPDATE orgs SET trial_ends_at = ? WHERE id = ?").bind(Date.now() - 1000, orgId).run();

    const json = await get("/app/export.json", cookie);
    expect(json.status).toBe(200);
    const body = (await json.json()) as Record<string, unknown[]>;
    expect([body.projects!.length, body.sov_lines!.length, body.pay_apps!.length]).toEqual([1, 0, 0]);
    expect(body.projects![0]).toMatchObject({ name: "Lakeview Elementary Modernization", original_contract_cents: 10_000_000 });

    const csv = await (await get("/app/export/projects.csv", cookie)).text();
    expect(csv.split("\r\n")[0]).toBe(
      "id,name,number,gc_name,gc_contact_email,owner_name,location,state,original_contract_cents,retainage_work_bp,retainage_stored_bp,first_furnished_on,last_furnished_on,status,created_at,updated_at",
    );
    expect(csv.split("\r\n")).toHaveLength(3);
    expect((await get("/app/export/users.csv", cookie)).status).toBe(404);
  });
});

describe("tenant isolation for projects and pay apps", () => {
  it("a user of org B gets 404 on every org A project, line, change order, and pay app route, and org A data is unchanged", async () => {
    const alice = await signup("Ana", "ana@example.com", "Alpha Electric");
    const bob = await signup("Ben", "ben@example.com", "Bravo Mechanical");
    const orgA = await orgIdFor("ana@example.com");
    const { projectId, ids, appId, token } = await submittedApp(alice);
    await post(`/app/projects/${projectId}/change-orders`, { title: "Extra circuits", amount: "900" }, { cookie: alice });
    const coId = (await env.DB.prepare("SELECT id FROM change_orders WHERE project_id = ?").bind(projectId).first<string>("id"))!;

    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          ["projects", "sov_lines", "change_orders", "pay_apps", "pay_app_lines"].map((t) => env.DB.prepare(`SELECT * FROM ${t} WHERE org_id = ? ORDER BY 1, 2, 3`).bind(orgA).all().then((r) => r.results)),
        ),
      );
    const before = await snapshot();

    for (const path of [`/app/projects/${projectId}`, `/app/projects/${projectId}/edit`, `/app/pay-apps/${appId}`, `/app/pay-apps/${appId}/pdf`, `/app/pay-apps/${appId}/csv`]) {
      const res = await get(path, bob);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("Lakeview");
    }
    const posts: [string, Record<string, string>][] = [
      [`/app/projects/${projectId}`, PROJECT_FORM],
      [`/app/projects/${projectId}`, { name: "" }],
      [`/app/projects/${projectId}/sov`, { item_no: "9", description: "Injected", scheduled: "1" }],
      [`/app/projects/${projectId}/sov/paste`, { paste: SOV_PASTE }],
      [`/app/sov/${ids[0]}`, { item_no: "1", description: "Renamed", scheduled: "1" }],
      [`/app/sov/${ids[0]}/delete`, {}],
      [`/app/sov/${ids[1]}/move`, { direction: "up" }],
      [`/app/projects/${projectId}/change-orders`, { title: "Injected", amount: "1" }],
      [`/app/change-orders/${coId}/approve`, {}],
      [`/app/change-orders/${coId}/reject`, {}],
      [`/app/projects/${projectId}/pay-apps`, { period_from: "2026-10-01", period_to: "2026-10-31" }],
      [`/app/pay-apps/${appId}`, draftForm(ids, { 0: { e: "1" } })],
      [`/app/pay-apps/${appId}/paid`, { amount: "1", paid_on: "2026-12-01" }],
      [`/app/pay-apps/${appId}/reopen`, {}],
      [`/app/pay-apps/${appId}/share`, {}],
      [`/app/pay-apps/${appId}/share/revoke`, {}],
      [`/app/pay-apps/${appId}/delete`, {}],
    ];
    for (const [path, form] of posts) expect((await post(path, form, { cookie: bob })).status, path).toBe(404);

    expect(await snapshot()).toBe(before);
    expect((await get(`/s/${token}`)).status).toBe(200);
    const bobList = await (await get("/app/projects", bob)).text();
    expect(bobList).not.toContain("Lakeview");
    const bobExport = (await (await get("/app/export.json", bob)).json()) as Record<string, unknown[]>;
    expect([bobExport.projects!.length, bobExport.sov_lines!.length, bobExport.change_orders!.length, bobExport.pay_apps!.length, bobExport.pay_app_lines!.length]).toEqual([0, 0, 0, 0, 0]);
  });
});
