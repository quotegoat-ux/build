import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays } from "../src/deadlines";
import worker from "../src/index";
import { utcDay } from "../src/ledger";
import { editableFields, selectTemplate } from "../src/waivers";
import { PROJECT_FORM, SOV_PASTE, createPayApp, createProject, draftForm, get, lineIds, orgIdFor, post, shareToken, signup } from "./helpers";

const DAY_MS = 86_400_000;
const PROGRESS = { 0: { e: "10000" }, 1: { e: "15,000" }, 2: { f: "8000" } };

async function submitted(cookie: string, state = "ca", extra: Record<string, string> = {}) {
  const projectId = await createProject(cookie, { ...PROJECT_FORM, state });
  await post(`/app/projects/${projectId}/sov/paste`, { paste: SOV_PASTE }, { cookie });
  const ids = await lineIds(projectId);
  const appId = await createPayApp(cookie, projectId, "2026-09-01", "2026-09-30");
  const res = await post(`/app/pay-apps/${appId}`, draftForm(ids, PROGRESS, { intent: "submit", ...extra }), { cookie });
  expect(res.status).toBe(200);
  return { projectId, ids, appId, token: await shareToken(res) };
}

const waivers = (payAppId: string) =>
  env.DB.prepare("SELECT kind, state, amount_cents, through_date, status FROM lien_waivers WHERE pay_app_id = ? ORDER BY created_at, kind").bind(payAppId).all().then((r) => r.results);

const waiverId = (payAppId: string, kind: string) =>
  env.DB.prepare("SELECT id FROM lien_waivers WHERE pay_app_id = ? AND kind = ?").bind(payAppId, kind).first<string>("id").then((id) => id!);

const pdfMagic = async (res: Response) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5));

describe("waiver form selection", () => {
  it("uses the statutory form when the state has one and the generic form, with the reason, when it does not", () => {
    expect(selectTemplate("CA", "conditional_progress")).toMatchObject({
      source: "statutory",
      title: "CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT",
      verified: true,
      citation: "Cal. Civ. Code §§ 8132, 8134, 8136, 8138 (forms); §§ 8120-8138 (waiver and release generally)",
    });
    expect(selectTemplate("UT", "unconditional_progress")).toMatchObject({
      source: "generic",
      title: "UNCONDITIONAL WAIVER AND RELEASE OF LIEN UPON PROGRESS PAYMENT",
      verified: false,
      reason: "UT has no statutory unconditional progress waiver form, so this uses Drawbook's generic form.",
      detail: "Utah Code 38-1a-802 defines no unconditional progress form. Use the conditional progress form (38-1a-802(4)(b)); it becomes effective when the check is paid.",
    });
    expect(selectTemplate("OK", "conditional_final")).toMatchObject({ source: "generic", reason: "OK does not prescribe a statutory lien waiver form, so this uses Drawbook's generic form.", detail: null });
    expect(selectTemplate("MO", "unconditional_final")).toMatchObject({ source: "generic", reason: "MO has no statutory unconditional final waiver form, so this uses Drawbook's generic form." });
    expect(selectTemplate("FL", "conditional_progress")).toMatchObject({ source: "statutory", verified: false });
  });

  it("adds notary and witness blocks only where the state requires them and the form lacks them", () => {
    const msGeneric = selectTemplate("MS", "unconditional_final");
    expect([msGeneric.source, msGeneric.notarize, msGeneric.body.endsWith("Notary public: {{notary_name}}\nMy commission expires: {{notary_commission_expires}}")]).toEqual(["generic", true, true]);
    expect(selectTemplate("MS", "conditional_progress").body.match(/NOTARY/g)).toHaveLength(1);
    expect(selectTemplate("GA", "unconditional_progress").body.endsWith("Witness name: {{witness_name}}\nWitness address: {{witness_address}}")).toBe(true);
    expect(selectTemplate("CA", "unconditional_final").body).not.toContain("NOTARY ACKNOWLEDGMENT");
    expect(editableFields(selectTemplate("MS", "conditional_progress"))).toEqual(["county", "scope_of_work", "city", "notary_date", "notary_name"]);
    expect(editableFields(selectTemplate("CA", "conditional_progress"))).toEqual(["maker_of_check", "check_payable_to", "prior_unpaid_waiver_dates", "prior_unpaid_waiver_amounts"]);
  });
});

describe("lien waivers on the pay application lifecycle", () => {
  it("submit creates the conditional waiver once, payment creates the unconditional one, and the waiver can be filled, sent, and signed", async () => {
    const cookie = await signup("Ria", "ria@example.com", "Ria Electric");
    const { projectId, ids, appId, token } = await submitted(cookie);
    expect(await waivers(appId)).toEqual([{ kind: "conditional_progress", state: "CA", amount_cents: 3_010_000, through_date: "2026-09-30", status: "draft" }]);
    expect((await post(`/app/pay-apps/${appId}`, draftForm(ids, PROGRESS, { intent: "submit" }), { cookie })).status).toBe(409);
    expect(await waivers(appId)).toHaveLength(1);

    const id = await waiverId(appId, "conditional_progress");
    expect(await (await get(`/app/pay-apps/${appId}`, cookie)).text()).toContain(`href="/app/waivers/${id}"`);
    const page = await (await get(`/app/waivers/${id}`, cookie)).text();
    expect(page).toContain("Name of Claimant: Ria Electric\nName of Customer: Summit Builders\nJob Location: 400 Lake St, Reno, CA");
    expect(page).toContain("Amount of Check: $30,100.00\nCheck Payable to: Ria Electric");
    expect(page).toContain("Date(s) of waiver and release: None");
    expect(page).toContain("Drawbook is not a law firm and does not give legal advice.");
    expect(page).not.toContain("Not statutory text");

    expect((await post(`/app/waivers/${id}`, { field_maker_of_check: "Summit Builders LLC", field_check_payable_to: "", exceptions: "CO-3 dispute, $1,200" }, { cookie })).status).toBe(302);
    expect(await env.DB.prepare("SELECT exceptions_text, fields_json FROM lien_waivers WHERE id = ?").bind(id).first()).toEqual({
      exceptions_text: "CO-3 dispute, $1,200",
      fields_json: '{"maker_of_check":"Summit Builders LLC","check_payable_to":"","prior_unpaid_waiver_dates":"","prior_unpaid_waiver_amounts":""}',
    });
    expect(await (await get(`/app/waivers/${id}`, cookie)).text()).toContain("Maker of Check: Summit Builders LLC");

    const pdf = await get(`/app/waivers/${id}/pdf`, cookie);
    expect([pdf.status, pdf.headers.get("Content-Type"), await pdfMagic(pdf)]).toEqual([200, "application/pdf", "%PDF-"]);

    expect(await (await get(`/s/${token}`)).text()).not.toContain("Lien waivers");
    expect((await post(`/app/waivers/${id}/sent`, {}, { cookie })).status).toBe(302);
    expect((await post(`/app/waivers/${id}`, { exceptions: "late edit" }, { cookie })).status).toBe(409);
    const share = await (await get(`/s/${token}`)).text();
    expect(share).toContain("Conditional progress waiver · $30,100.00 · Sent");
    expect(share).toContain("Maker of Check: Summit Builders LLC");
    expect(await pdfMagic(await get(`/s/${token}/waivers/${id}/pdf`))).toBe("%PDF-");

    expect((await post(`/app/waivers/${id}/signed`, { signer_name: "", signed_on: "2026-10-02" }, { cookie })).status).toBe(422);
    expect((await post(`/app/waivers/${id}/signed`, { signer_name: "Ria Patel", signer_title: "Owner", signed_on: "2026-10-02" }, { cookie })).status).toBe(302);
    expect((await post(`/app/waivers/${id}/signed`, { signer_name: "Someone Else", signed_on: "2026-10-03" }, { cookie })).status).toBe(409);
    const signed = await env.DB.prepare("SELECT status, signer_name, signer_title, signed_at, signed_document FROM lien_waivers WHERE id = ?").bind(id).first<Record<string, string | number>>();
    expect([signed!.status, signed!.signer_name, signed!.signer_title, signed!.signed_at]).toEqual(["signed", "Ria Patel", "Owner", Date.parse("2026-10-02")]);
    expect(JSON.parse(signed!.signed_document as string).body).toContain("Claimant's Signature: Ria Patel\nClaimant's Title: Owner\nDate of Signature: 2026-10-02");

    await post(`/app/projects/${projectId}`, { ...PROJECT_FORM, state: "ca", gc_name: "Bayline Construction" }, { cookie });
    expect(await (await get(`/app/waivers/${id}`, cookie)).text()).toContain("Name of Customer: Summit Builders");

    const submittedAt = (await env.DB.prepare("SELECT submitted_at FROM pay_apps WHERE id = ?").bind(appId).first<number>("submitted_at"))!;
    const paidOn = utcDay(submittedAt + 3 * DAY_MS);
    expect((await post(`/app/pay-apps/${appId}/paid`, { amount: "30,000", paid_on: paidOn }, { cookie })).status).toBe(302);
    expect((await post(`/app/pay-apps/${appId}/paid`, { amount: "30,000", paid_on: paidOn }, { cookie })).status).toBe(409);
    expect(await waivers(appId)).toEqual([
      { kind: "conditional_progress", state: "CA", amount_cents: 3_010_000, through_date: "2026-09-30", status: "signed" },
      { kind: "unconditional_progress", state: "CA", amount_cents: 3_000_000, through_date: "2026-09-30", status: "draft" },
    ]);
    const unconditional = await (await get(`/app/waivers/${await waiverId(appId, "unconditional_progress")}`, cookie)).text();
    expect(unconditional).toContain("UNCONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT");
    expect(unconditional).toContain("The claimant has received the following progress payment: $30,000.00");
    expect(unconditional).toContain("Name of Customer: Bayline Construction");

    const exported = (await (await get("/app/export.json", cookie)).json()) as { lien_waivers: { kind: string; amount_cents: number; status: string }[] };
    expect(exported.lien_waivers.map((w) => [w.kind, w.amount_cents, w.status])).toEqual([
      ["conditional_progress", 3_010_000, "signed"],
      ["unconditional_progress", 3_000_000, "draft"],
    ]);
  });

  it("reopening deletes an unsigned conditional waiver, a final app gets final waivers, and CA lists prior unpaid conditionals", async () => {
    const cookie = await signup("Sol", "sol@example.com", "Sol Mechanical");
    const { projectId, ids, appId } = await submitted(cookie);
    expect((await post(`/app/pay-apps/${appId}/reopen`, {}, { cookie })).status).toBe(302);
    expect(await waivers(appId)).toEqual([]);

    expect((await post(`/app/pay-apps/${appId}`, draftForm(ids, PROGRESS, { intent: "submit" }), { cookie })).status).toBe(200);
    const first = await waiverId(appId, "conditional_progress");
    const app2 = await createPayApp(cookie, projectId, "2026-10-01", "2026-10-31");
    expect((await post(`/app/pay-apps/${app2}`, draftForm(ids, { 1: { e: "45,000" }, 2: { e: "22,000" } }, { period_from: "2026-10-01", period_to: "2026-10-31", intent: "submit", is_final: "1" }), { cookie })).status).toBe(200);
    expect(await env.DB.prepare("SELECT is_final FROM pay_apps WHERE id = ?").bind(app2).first<number>("is_final")).toBe(1);
    expect(await waivers(app2)).toEqual([{ kind: "conditional_final", state: "CA", amount_cents: 5_270_000, through_date: "2026-10-31", status: "draft" }]);
    const finalPage = await (await get(`/app/waivers/${await waiverId(app2, "conditional_final")}`, cookie)).text();
    expect(finalPage).toContain("CONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT");
    expect(await (await get(`/app/pay-apps/${app2}`, cookie)).text()).toContain(" · Final application");

    const firstPage = await (await get(`/app/waivers/${first}`, cookie)).text();
    expect(firstPage).toContain("Date(s) of waiver and release: None");
    await post(`/app/waivers/${first}/signed`, { signer_name: "Sol Ortiz", signed_on: "2026-10-05" }, { cookie });
    expect((await post(`/app/pay-apps/${app2}/reopen`, {}, { cookie })).status).toBe(302);
    expect(await waivers(app2)).toEqual([]);
    expect(await waivers(appId)).toMatchObject([{ kind: "conditional_progress", status: "signed" }]);

    const orgId = await orgIdFor("sol@example.com");
    await env.DB.prepare("UPDATE lien_waivers SET created_at = created_at - 1000 WHERE org_id = ?").bind(orgId).run();
    await post(`/app/pay-apps/${app2}`, draftForm(ids, { 1: { e: "45,000" }, 2: { e: "22,000" } }, { period_from: "2026-10-01", period_to: "2026-10-31", intent: "submit" }), { cookie });
    const progress2 = await (await get(`/app/waivers/${await waiverId(app2, "conditional_progress")}`, cookie)).text();
    const firstCreated = (await env.DB.prepare("SELECT created_at FROM lien_waivers WHERE id = ?").bind(first).first<number>("created_at"))!;
    expect(progress2).toContain(`Date(s) of waiver and release: ${utcDay(firstCreated)}\nAmount(s) of unpaid progress payment(s): $30,100.00`);
  });

  it("falls back to the generic form on screen where the state has no statutory form for the kind", async () => {
    const cookie = await signup("Ute", "ute@example.com", "Ute Concrete");
    const { appId } = await submitted(cookie, "ut");
    const submittedAt = (await env.DB.prepare("SELECT submitted_at FROM pay_apps WHERE id = ?").bind(appId).first<number>("submitted_at"))!;
    await post(`/app/pay-apps/${appId}/paid`, { amount: "30,100", paid_on: utcDay(submittedAt) }, { cookie });
    const page = await (await get(`/app/waivers/${await waiverId(appId, "unconditional_progress")}`, cookie)).text();
    expect(page).toContain("UT has no statutory unconditional progress waiver form, so this uses Drawbook&#39;s generic form.");
    expect(page).toContain('<p class="badge-warn">Not statutory text. Have counsel review.</p>');
    expect(page).toContain("UNCONDITIONAL WAIVER AND RELEASE OF LIEN UPON PROGRESS PAYMENT");
    const conditional = await (await get(`/app/waivers/${await waiverId(appId, "conditional_progress")}`, cookie)).text();
    expect(conditional).toContain("UTAH CONDITIONAL WAIVER AND RELEASE UPON PROGRESS PAYMENT");
    expect(conditional).toContain('name="field_invoice_number" type="text" value="Pay application #1"');
  });
});

describe("lien deadlines on screen", () => {
  it("shows the project's deadlines with confidence and puts the next 60 days on the dashboard", async () => {
    const cookie = await signup("Val", "val@example.com", "Val Drywall");
    const projectId = await createProject(cookie, { ...PROJECT_FORM, state: "ca", first_furnished_on: "2026-08-03" });
    const page = await (await get(`/app/projects/${projectId}`, cookie)).text();
    expect(page).toContain("<strong>Preliminary notice</strong><div class=\"muted small\">20 days after first furnishing labor or materials</div>");
    expect(page).toContain("2026-08-23");
    expect(page).toContain("Lien filing: add a last furnishing date to estimate this deadline.");
    expect(page).toContain("Deadline dates are estimates");

    const soon = utcDay(Date.now() - 5 * DAY_MS);
    const other = await createProject(cookie, { ...PROJECT_FORM, name: "Harbor Clinic", state: "ca", first_furnished_on: soon });
    const dash = await (await get("/app", cookie)).text();
    expect(dash).toContain("Upcoming deadlines");
    expect(dash).toContain(`<a class="list-row row-link" href="/app/projects/${other}"><div><strong>Preliminary notice</strong><div class="muted">Harbor Clinic</div></div><div class="row-figures"><strong>${addDays(soon, 20)}</strong><span class="pill pill-conf">high confidence</span>`);

    const ok = await createProject(cookie, { ...PROJECT_FORM, state: "ok" });
    expect(await (await get(`/app/projects/${ok}`, cookie)).text()).toContain("No rules on file for OK; check your state&#39;s statute.");
  });
});

describe("daily reminders", () => {
  afterEach(() => vi.restoreAllMocks());

  async function runCron(now: number) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: now, cron: "0 13 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
  }

  it("emails owners and admins about deadlines due within 7 days and apps unpaid past 30 days, once", async () => {
    const cookie = await signup("Wes", "wes@example.com", "Wes Fire");
    const orgId = await orgIdFor("wes@example.com");
    const now = Date.now();
    const projectId = await createProject(cookie, { ...PROJECT_FORM, state: "ca", first_furnished_on: utcDay(now - 15 * DAY_MS) });
    await createProject(cookie, { ...PROJECT_FORM, state: "ca", first_furnished_on: utcDay(now - 2 * DAY_MS) });
    await post("/app/sample", {}, { cookie });
    const unpaid = (await env.DB.prepare("SELECT id, submitted_at FROM pay_apps WHERE org_id = ? AND status = 'submitted'").bind(orgId).first<{ id: string; submitted_at: number }>())!;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u-member-wes', 'member@wes.example', 'Mem', 'x', 0)"),
      env.DB.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, 'u-member-wes', 'member', 0)").bind(orgId),
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCron(now);
    const mails = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Wes Fire"));
    expect(mails().map((l) => l.split("\n")[0])).toEqual(['[email not sent: RESEND_API_KEY unset] to=wes@example.com subject="Drawbook: 2 lien reminders for Wes Fire"']);
    expect(mails()[0]).toContain(`Lakeview Elementary Modernization: Preliminary notice due ${utcDay(now + 5 * DAY_MS)} (20 days after first furnishing labor or materials; high confidence)`);
    expect(mails()[0]).toContain("Riverside Medical Office (sample): App #2 for $92,530.00 unpaid 34 days after submission");
    expect(mails()[0]).not.toContain("member@wes.example");

    const rows = () => env.DB.prepare("SELECT subject_key, due_on FROM sent_reminders WHERE org_id = ? ORDER BY subject_key").bind(orgId).all().then((r) => r.results);
    expect(await rows()).toEqual([
      { subject_key: `deadline:${projectId}:prelim_notice`, due_on: utcDay(now + 5 * DAY_MS) },
      { subject_key: `unpaid:${unpaid.id}`, due_on: utcDay(unpaid.submitted_at + 30 * DAY_MS) },
    ]);
    await runCron(now + 60_000);
    expect(mails()).toHaveLength(1);
    expect(await rows()).toHaveLength(2);
  });
});

describe("tenant isolation for lien waivers", () => {
  it("a user of org B gets 404 on every org A waiver route, share links only serve their own sent waivers, and org A data is unchanged", async () => {
    const alice = await signup("Abe", "abe@example.com", "Alpha Glazing");
    const bob = await signup("Bea", "bea@example.com", "Bravo Roofing");
    const orgA = await orgIdFor("abe@example.com");
    const a = await submitted(alice);
    const b = await submitted(bob);
    const aWaiver = await waiverId(a.appId, "conditional_progress");
    const bWaiver = await waiverId(b.appId, "conditional_progress");
    const snapshot = () => env.DB.prepare("SELECT * FROM lien_waivers WHERE org_id = ? ORDER BY id").bind(orgA).all().then((r) => JSON.stringify(r.results));
    const before = await snapshot();

    for (const path of [`/app/waivers/${aWaiver}`, `/app/waivers/${aWaiver}/pdf`]) {
      const res = await get(path, bob);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("Alpha Glazing");
    }
    const posts: [string, Record<string, string>][] = [
      [`/app/waivers/${aWaiver}`, { exceptions: "Injected", field_maker_of_check: "Injected" }],
      [`/app/waivers/${aWaiver}/sent`, {}],
      [`/app/waivers/${aWaiver}/signed`, { signer_name: "Bea", signed_on: "2026-10-01" }],
      [`/app/waivers/${aWaiver}/signed`, { signer_name: "", signed_on: "" }],
    ];
    for (const [path, form] of posts) expect((await post(path, form, { cookie: bob })).status, path).toBe(404);
    expect(await snapshot()).toBe(before);

    expect((await get(`/s/${a.token}/waivers/${aWaiver}/pdf`)).status).toBe(404);
    await post(`/app/waivers/${bWaiver}/sent`, {}, { cookie: bob });
    expect((await get(`/s/${a.token}/waivers/${bWaiver}/pdf`)).status).toBe(404);
    expect((await get(`/s/${b.token}/waivers/${bWaiver}/pdf`)).status).toBe(200);
    expect(((await (await get("/app/export.json", bob)).json()) as { lien_waivers: { id: string }[] }).lien_waivers.map((w) => w.id)).toEqual([bWaiver]);
  });
});
