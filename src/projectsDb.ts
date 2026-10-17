import type { Tenant } from "./db";
import type { ChangeOrderStatus } from "./payapp";
import type { WaiverKind, WaiverStatus } from "./waivers";

export type ProjectStatus = "active" | "closed";
export type PayAppStatus = "draft" | "submitted" | "paid";

export interface Project {
  id: string;
  name: string;
  number: string;
  gc_name: string;
  gc_contact_email: string;
  owner_name: string;
  location: string;
  state: string;
  original_contract_cents: number;
  retainage_work_bp: number;
  retainage_stored_bp: number;
  first_furnished_on: string | null;
  last_furnished_on: string | null;
  status: ProjectStatus;
  created_at: number;
  updated_at: number;
}

export type ProjectInput = Omit<Project, "id" | "created_at" | "updated_at">;

export interface SovLineRow {
  id: string;
  project_id: string;
  position: number;
  item_no: string;
  description: string;
  scheduled_cents: number;
  change_order_id: string | null;
  locked: 0 | 1;
}

export interface ChangeOrderRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  amount_cents: number;
  status: ChangeOrderStatus;
  approved_at: number | null;
  created_at: number;
}

export interface PayAppRow {
  id: string;
  project_id: string;
  number: number;
  period_from: string;
  period_to: string;
  status: PayAppStatus;
  retainage_work_bp: number;
  retainage_stored_bp: number;
  submitted_at: number | null;
  paid_at: number | null;
  paid_cents: number | null;
  is_final: 0 | 1;
  shared: 0 | 1;
  created_at: number;
}

export interface PayAppLineRow {
  pay_app_id: string;
  sov_line_id: string;
  work_this_period_cents: number;
  stored_to_date_cents: number;
}

export interface WaiverRow {
  id: string;
  project_id: string;
  pay_app_id: string | null;
  kind: WaiverKind;
  state: string;
  amount_cents: number;
  through_date: string;
  exceptions_text: string;
  fields_json: string;
  status: WaiverStatus;
  signer_name: string | null;
  signer_title: string | null;
  signed_at: number | null;
  signed_document: string | null;
  created_at: number;
}

/** Everything one project's pay application math needs, already scoped to one org. */
export interface Ledger {
  project: Project;
  sov: SovLineRow[];
  changeOrders: ChangeOrderRow[];
  payApps: PayAppRow[];
  lines: PayAppLineRow[];
}

const PROJECT_COLUMNS =
  "id, name, number, gc_name, gc_contact_email, owner_name, location, state, original_contract_cents, retainage_work_bp, retainage_stored_bp, first_furnished_on, last_furnished_on, status, created_at, updated_at";
const SOV_COLUMNS = `s.id, s.project_id, s.position, s.item_no, s.description, s.scheduled_cents, s.change_order_id,
  EXISTS (SELECT 1 FROM pay_app_lines pl JOIN pay_apps p ON p.id = pl.pay_app_id WHERE pl.sov_line_id = s.id AND p.status != 'draft') AS locked`;
const CO_COLUMNS = "id, project_id, number, title, amount_cents, status, approved_at, created_at";
const PAY_APP_COLUMNS =
  "id, project_id, number, period_from, period_to, status, retainage_work_bp, retainage_stored_bp, submitted_at, paid_at, paid_cents, is_final, share_token_hash IS NOT NULL AS shared, created_at";
const WAIVER_COLUMNS =
  "id, project_id, pay_app_id, kind, state, amount_cents, through_date, exceptions_text, fields_json, status, signer_name, signer_title, signed_at, signed_document, created_at";
const LINE_COLUMNS = "pay_app_id, sov_line_id, work_this_period_cents, stored_to_date_cents";
const UNLOCKED = "NOT EXISTS (SELECT 1 FROM pay_app_lines pl JOIN pay_apps p ON p.id = pl.pay_app_id WHERE pl.sov_line_id = sov_lines.id AND p.status != 'draft')";

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && e.message.includes("UNIQUE constraint failed");
}

function groupBy<T extends { project_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.project_id, [...(m.get(r.project_id) ?? []), r]);
  return m;
}

async function loadLedgers(db: D1Database, orgId: string, projectId: string | null): Promise<Ledger[]> {
  const scope = (alias: string) => `${alias}org_id = ?1 AND (?2 IS NULL OR ${alias}project_id = ?2)`;
  const [projects, sov, cos, apps, lines] = await db.batch<unknown>([
    db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE org_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY status, created_at DESC`).bind(orgId, projectId),
    db.prepare(`SELECT ${SOV_COLUMNS} FROM sov_lines s WHERE ${scope("s.")} ORDER BY s.position, s.created_at`).bind(orgId, projectId),
    db.prepare(`SELECT ${CO_COLUMNS} FROM change_orders WHERE ${scope("")} ORDER BY number`).bind(orgId, projectId),
    db.prepare(`SELECT ${PAY_APP_COLUMNS} FROM pay_apps WHERE ${scope("")} ORDER BY number`).bind(orgId, projectId),
    db
      .prepare(`SELECT pl.pay_app_id, pl.sov_line_id, pl.work_this_period_cents, pl.stored_to_date_cents, p.project_id FROM pay_app_lines pl JOIN pay_apps p ON p.id = pl.pay_app_id WHERE pl.org_id = ?1 AND (?2 IS NULL OR p.project_id = ?2)`)
      .bind(orgId, projectId),
  ]);
  const sovBy = groupBy(sov!.results as SovLineRow[]);
  const coBy = groupBy(cos!.results as ChangeOrderRow[]);
  const appBy = groupBy(apps!.results as PayAppRow[]);
  const lineBy = groupBy(lines!.results as (PayAppLineRow & { project_id: string })[]);
  return (projects!.results as Project[]).map((project) => ({
    project,
    sov: sovBy.get(project.id) ?? [],
    changeOrders: coBy.get(project.id) ?? [],
    payApps: appBy.get(project.id) ?? [],
    lines: (lineBy.get(project.id) ?? []).map(({ project_id: _, ...l }) => l),
  }));
}

export async function loadOrgLedgers(t: Tenant, db: D1Database): Promise<Ledger[]> {
  return loadLedgers(db, t.orgId, null);
}

export async function loadProjectLedger(t: Tenant, db: D1Database, projectId: string): Promise<Ledger | null> {
  return (await loadLedgers(db, t.orgId, projectId))[0] ?? null;
}

export async function loadPayAppLedger(t: Tenant, db: D1Database, payAppId: string): Promise<{ ledger: Ledger; payApp: PayAppRow } | null> {
  const projectId = await db.prepare("SELECT project_id FROM pay_apps WHERE id = ? AND org_id = ?").bind(payAppId, t.orgId).first<string>("project_id");
  const ledger = projectId ? await loadProjectLedger(t, db, projectId) : null;
  const payApp = ledger?.payApps.find((a) => a.id === payAppId);
  return ledger && payApp ? { ledger, payApp } : null;
}

/** Unauthenticated: the share token is the credential, so the org comes from the pay app row it names. */
export async function loadSharedPayApp(db: D1Database, tokenHash: string): Promise<{ orgName: string; ledger: Ledger; payApp: PayAppRow; waivers: WaiverRow[] } | null> {
  const row = await db
    .prepare("SELECT p.id, p.org_id, p.project_id, o.name AS org_name FROM pay_apps p JOIN orgs o ON o.id = p.org_id WHERE p.share_token_hash = ? AND p.status != 'draft'")
    .bind(tokenHash)
    .first<{ id: string; org_id: string; project_id: string; org_name: string }>();
  if (!row) return null;
  const [ledgers, waivers] = await Promise.all([loadLedgers(db, row.org_id, row.project_id), projectWaivers(db, row.org_id, row.project_id)]);
  const ledger = ledgers[0];
  const payApp = ledger?.payApps.find((a) => a.id === row.id);
  return ledger && payApp ? { orgName: row.org_name, ledger, payApp, waivers } : null;
}

/** Scheduled jobs run without a session; the org id comes from the orgs table, never from a request. */
export async function loadLedgersForOrg(db: D1Database, orgId: string): Promise<Ledger[]> {
  return loadLedgers(db, orgId, null);
}

export async function createProject(t: Tenant, db: D1Database, id: string, p: ProjectInput, now: number) {
  await db
    .prepare(
      `INSERT INTO projects (id, org_id, name, number, gc_name, gc_contact_email, owner_name, location, state, original_contract_cents,
         retainage_work_bp, retainage_stored_bp, first_furnished_on, last_furnished_on, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, t.orgId, p.name, p.number, p.gc_name, p.gc_contact_email, p.owner_name, p.location, p.state, p.original_contract_cents,
      p.retainage_work_bp, p.retainage_stored_bp, p.first_furnished_on, p.last_furnished_on, p.status, now, now)
    .run();
}

export async function updateProject(t: Tenant, db: D1Database, id: string, p: ProjectInput, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE projects SET name = ?, number = ?, gc_name = ?, gc_contact_email = ?, owner_name = ?, location = ?, state = ?, original_contract_cents = ?,
         retainage_work_bp = ?, retainage_stored_bp = ?, first_furnished_on = ?, last_furnished_on = ?, status = ?, updated_at = ?
       WHERE id = ? AND org_id = ?`,
    )
    .bind(p.name, p.number, p.gc_name, p.gc_contact_email, p.owner_name, p.location, p.state, p.original_contract_cents,
      p.retainage_work_bp, p.retainage_stored_bp, p.first_furnished_on, p.last_furnished_on, p.status, now, id, t.orgId)
    .run();
  return result.meta.changes > 0;
}

export async function addSovLines(
  t: Tenant,
  db: D1Database,
  projectId: string,
  lines: { id: string; itemNo: string; description: string; scheduledCents: number }[],
  now: number,
): Promise<number> {
  if (lines.length === 0) return 0;
  const results = await db.batch(
    lines.map((l, index) =>
      db
        .prepare(
          `INSERT INTO sov_lines (id, org_id, project_id, position, item_no, description, scheduled_cents, created_at, updated_at)
           SELECT ?1, org_id, id, COALESCE((SELECT MAX(position) FROM sov_lines WHERE project_id = ?3), 0) + 1, ?4, ?5, ?6, ?7, ?7
           FROM projects WHERE org_id = ?2 AND id = ?3`,
        )
        .bind(l.id, t.orgId, projectId, l.itemNo, l.description, l.scheduledCents, now + index),
    ),
  );
  return results.reduce((n, r) => n + r.meta.changes, 0);
}

export async function sovLineProject(t: Tenant, db: D1Database, lineId: string): Promise<string | null> {
  return db.prepare("SELECT project_id FROM sov_lines WHERE id = ? AND org_id = ?").bind(lineId, t.orgId).first<string>("project_id");
}

export type LineEditResult = "ok" | "locked" | "not_found";

async function lineEditResult(t: Tenant, db: D1Database, lineId: string, changes: number): Promise<LineEditResult> {
  if (changes > 0) return "ok";
  const exists = await db.prepare("SELECT 1 FROM sov_lines WHERE id = ? AND org_id = ?").bind(lineId, t.orgId).first();
  return exists ? "locked" : "not_found";
}

export async function updateSovLine(
  t: Tenant,
  db: D1Database,
  lineId: string,
  l: { itemNo: string; description: string; scheduledCents: number },
  now: number,
): Promise<LineEditResult> {
  const result = await db
    .prepare(`UPDATE sov_lines SET item_no = ?, description = ?, scheduled_cents = ?, updated_at = ? WHERE id = ? AND org_id = ? AND ${UNLOCKED}`)
    .bind(l.itemNo, l.description, l.scheduledCents, now, lineId, t.orgId)
    .run();
  return lineEditResult(t, db, lineId, result.meta.changes);
}

export async function deleteSovLine(t: Tenant, db: D1Database, lineId: string): Promise<LineEditResult> {
  const result = await db.prepare(`DELETE FROM sov_lines WHERE id = ? AND org_id = ? AND ${UNLOCKED}`).bind(lineId, t.orgId).run();
  return lineEditResult(t, db, lineId, result.meta.changes);
}

/** Swaps positions with the neighbour above or below; returns the project id, or null if the line is not this org's. */
export async function moveSovLine(t: Tenant, db: D1Database, lineId: string, direction: "up" | "down"): Promise<string | null> {
  const line = await db.prepare("SELECT project_id, position FROM sov_lines WHERE id = ? AND org_id = ?").bind(lineId, t.orgId).first<{ project_id: string; position: number }>();
  if (!line) return null;
  const neighbour = await db
    .prepare(
      direction === "up"
        ? "SELECT id, position FROM sov_lines WHERE project_id = ? AND org_id = ? AND position < ? ORDER BY position DESC LIMIT 1"
        : "SELECT id, position FROM sov_lines WHERE project_id = ? AND org_id = ? AND position > ? ORDER BY position LIMIT 1",
    )
    .bind(line.project_id, t.orgId, line.position)
    .first<{ id: string; position: number }>();
  if (neighbour) {
    await db.batch([
      db.prepare("UPDATE sov_lines SET position = ? WHERE id = ? AND org_id = ?").bind(neighbour.position, lineId, t.orgId),
      db.prepare("UPDATE sov_lines SET position = ? WHERE id = ? AND org_id = ?").bind(line.position, neighbour.id, t.orgId),
    ]);
  }
  return line.project_id;
}

export async function createChangeOrder(t: Tenant, db: D1Database, projectId: string, co: { id: string; title: string; amountCents: number }, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO change_orders (id, org_id, project_id, number, title, amount_cents, status, created_at, updated_at)
       SELECT ?1, org_id, id, COALESCE((SELECT MAX(number) FROM change_orders WHERE project_id = ?3), 0) + 1, ?4, ?5, 'pending', ?6, ?6
       FROM projects WHERE org_id = ?2 AND id = ?3`,
    )
    .bind(co.id, t.orgId, projectId, co.title, co.amountCents, now)
    .run();
  return result.meta.changes > 0;
}

/** pending -> approved adds the change order's line to the schedule of values; pending -> rejected does not. */
export async function decideChangeOrder(t: Tenant, db: D1Database, coId: string, decision: "approved" | "rejected", lineId: string, now: number): Promise<string | null> {
  const statements = [
    db
      .prepare("UPDATE change_orders SET status = ?, approved_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'pending' RETURNING project_id")
      .bind(decision, decision === "approved" ? now : null, now, coId, t.orgId),
  ];
  if (decision === "approved") {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO sov_lines (id, org_id, project_id, position, item_no, description, scheduled_cents, change_order_id, created_at, updated_at)
           SELECT ?1, org_id, project_id, COALESCE((SELECT MAX(position) FROM sov_lines WHERE project_id = co.project_id), 0) + 1,
             'CO-' || number, title, amount_cents, id, ?3, ?3
           FROM change_orders co WHERE id = ?2 AND org_id = ?4 AND status = 'approved' AND approved_at = ?3`,
        )
        .bind(lineId, coId, now, t.orgId),
    );
  }
  const [updated] = await db.batch<{ project_id: string }>(statements);
  return updated!.results[0]?.project_id ?? null;
}

/** Numbers the app after the last one and carries each line's stored-materials balance forward. */
export async function createPayApp(
  t: Tenant,
  db: D1Database,
  projectId: string,
  a: { id: string; periodFrom: string; periodTo: string },
  now: number,
): Promise<"created" | "draft_exists" | "not_found"> {
  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO pay_apps (id, org_id, project_id, number, period_from, period_to, status, retainage_work_bp, retainage_stored_bp, created_at, updated_at)
           SELECT ?1, org_id, id, COALESCE((SELECT MAX(number) FROM pay_apps WHERE project_id = ?3), 0) + 1, ?4, ?5, 'draft', retainage_work_bp, retainage_stored_bp, ?6, ?6
           FROM projects WHERE org_id = ?2 AND id = ?3`,
        )
        .bind(a.id, t.orgId, projectId, a.periodFrom, a.periodTo, now),
      db
        .prepare(
          `INSERT INTO pay_app_lines (org_id, pay_app_id, sov_line_id, work_this_period_cents, stored_to_date_cents)
           SELECT s.org_id, ?1, s.id, 0, COALESCE((
             SELECT pl.stored_to_date_cents FROM pay_app_lines pl JOIN pay_apps p ON p.id = pl.pay_app_id
             WHERE pl.sov_line_id = s.id AND p.project_id = s.project_id AND p.number = (SELECT number FROM pay_apps WHERE id = ?1) - 1), 0)
           FROM sov_lines s WHERE s.org_id = ?2 AND s.project_id = ?3 AND EXISTS (SELECT 1 FROM pay_apps WHERE id = ?1)`,
        )
        .bind(a.id, t.orgId, projectId),
    ]);
    return inserted!.meta.changes > 0 ? "created" : "not_found";
  } catch (e) {
    if (isUniqueViolation(e)) return "draft_exists";
    throw e;
  }
}

export async function saveDraft(
  t: Tenant,
  db: D1Database,
  payAppId: string,
  d: { periodFrom: string; periodTo: string; retainageWorkBp: number; retainageStoredBp: number; isFinal: boolean; lines: { sovLineId: string; workThisPeriodCents: number; storedToDateCents: number }[] },
  now: number,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare("UPDATE pay_apps SET period_from = ?, period_to = ?, retainage_work_bp = ?, retainage_stored_bp = ?, is_final = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'draft'")
      .bind(d.periodFrom, d.periodTo, d.retainageWorkBp, d.retainageStoredBp, d.isFinal ? 1 : 0, now, payAppId, t.orgId),
    ...d.lines.map((l) =>
      db
        .prepare(
          `INSERT INTO pay_app_lines (org_id, pay_app_id, sov_line_id, work_this_period_cents, stored_to_date_cents)
           SELECT p.org_id, p.id, s.id, ?4, ?5 FROM pay_apps p JOIN sov_lines s ON s.project_id = p.project_id AND s.id = ?3
           WHERE p.id = ?1 AND p.org_id = ?2 AND p.status = 'draft'
           ON CONFLICT (pay_app_id, sov_line_id) DO UPDATE SET work_this_period_cents = excluded.work_this_period_cents, stored_to_date_cents = excluded.stored_to_date_cents`,
        )
        .bind(payAppId, t.orgId, l.sovLineId, l.workThisPeriodCents, l.storedToDateCents),
    ),
  ]);
  return results[0]!.meta.changes > 0;
}

/**
 * Creates the waiver a status change calls for, at most one per (pay app, kind): conditional on submit, unconditional on
 * payment, final when the app is marked final. Retries hit the unique key and change nothing.
 */
function insertWaiver(db: D1Database, t: Tenant, payAppId: string, w: { id: string; amountCents: number }, stage: "conditional" | "unconditional", status: PayAppStatus, now: number) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO lien_waivers (id, org_id, project_id, pay_app_id, kind, state, amount_cents, through_date, created_at, updated_at)
       SELECT ?1, a.org_id, a.project_id, a.id, ?2 || CASE WHEN a.is_final = 1 THEN '_final' ELSE '_progress' END, p.state, ?3, a.period_to, ?4, ?4
       FROM pay_apps a JOIN projects p ON p.id = a.project_id WHERE a.id = ?5 AND a.org_id = ?6 AND a.status = ?7`,
    )
    .bind(w.id, stage, w.amountCents, now, payAppId, t.orgId, status);
}

/** draft -> submitted. Freezes the line set so later schedule edits cannot change what was sent, and creates the conditional waiver. */
export async function submitPayApp(
  t: Tenant,
  db: D1Database,
  payAppId: string,
  shareTokenHash: string,
  waiver: { id: string; amountCents: number },
  now: number,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO pay_app_lines (org_id, pay_app_id, sov_line_id, work_this_period_cents, stored_to_date_cents)
         SELECT s.org_id, p.id, s.id, 0, 0 FROM pay_apps p JOIN sov_lines s ON s.project_id = p.project_id
         WHERE p.id = ? AND p.org_id = ? AND p.status = 'draft'`,
      )
      .bind(payAppId, t.orgId),
    db
      .prepare("UPDATE pay_apps SET status = 'submitted', submitted_at = ?, share_token_hash = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'draft'")
      .bind(now, shareTokenHash, now, payAppId, t.orgId),
    insertWaiver(db, t, payAppId, waiver, "conditional", "submitted", now),
  ]);
  return results[1]!.meta.changes > 0;
}

/** submitted -> paid, creating the unconditional waiver for the amount actually received. */
export async function markPayAppPaid(t: Tenant, db: D1Database, payAppId: string, p: { paidCents: number; paidAt: number; waiverId: string }, now: number): Promise<boolean> {
  const [updated] = await db.batch([
    db
      .prepare("UPDATE pay_apps SET status = 'paid', paid_cents = ?, paid_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'submitted'")
      .bind(p.paidCents, p.paidAt, now, payAppId, t.orgId),
    insertWaiver(db, t, payAppId, { id: p.waiverId, amountCents: p.paidCents }, "unconditional", "paid", now),
  ]);
  return updated!.meta.changes > 0;
}

/** submitted -> draft, only for the latest app on the project; the share link and any unsigned conditional waiver die with the submission. */
export async function reopenPayApp(t: Tenant, db: D1Database, payAppId: string, now: number): Promise<boolean> {
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE pay_apps SET status = 'draft', submitted_at = NULL, share_token_hash = NULL, updated_at = ?
         WHERE id = ? AND org_id = ? AND status = 'submitted'
           AND NOT EXISTS (SELECT 1 FROM pay_apps later WHERE later.project_id = pay_apps.project_id AND later.number > pay_apps.number)`,
      )
      .bind(now, payAppId, t.orgId),
    db
      .prepare(
        `DELETE FROM lien_waivers WHERE pay_app_id = ?1 AND org_id = ?2 AND kind IN ('conditional_progress', 'conditional_final') AND status != 'signed'
           AND EXISTS (SELECT 1 FROM pay_apps WHERE id = ?1 AND status = 'draft')`,
      )
      .bind(payAppId, t.orgId),
  ]);
  return updated!.meta.changes > 0;
}

export async function deleteDraft(t: Tenant, db: D1Database, payAppId: string): Promise<string | null> {
  return db.prepare("DELETE FROM pay_apps WHERE id = ? AND org_id = ? AND status = 'draft' RETURNING project_id").bind(payAppId, t.orgId).first<string>("project_id");
}

export async function setShareToken(t: Tenant, db: D1Database, payAppId: string, tokenHash: string | null): Promise<boolean> {
  const result = await db
    .prepare("UPDATE pay_apps SET share_token_hash = ? WHERE id = ? AND org_id = ? AND status != 'draft'")
    .bind(tokenHash, payAppId, t.orgId)
    .run();
  return result.meta.changes > 0;
}

function projectWaivers(db: D1Database, orgId: string, projectId: string): Promise<WaiverRow[]> {
  return db
    .prepare(`SELECT ${WAIVER_COLUMNS} FROM lien_waivers WHERE org_id = ? AND project_id = ? ORDER BY created_at, kind`)
    .bind(orgId, projectId)
    .all<WaiverRow>()
    .then((r) => r.results);
}

export function listProjectWaivers(t: Tenant, db: D1Database, projectId: string): Promise<WaiverRow[]> {
  return projectWaivers(db, t.orgId, projectId);
}

export function loadWaiver(t: Tenant, db: D1Database, waiverId: string): Promise<WaiverRow | null> {
  return db.prepare(`SELECT ${WAIVER_COLUMNS} FROM lien_waivers WHERE id = ? AND org_id = ?`).bind(waiverId, t.orgId).first<WaiverRow>();
}

export async function saveWaiverFields(t: Tenant, db: D1Database, waiverId: string, w: { exceptionsText: string; fields: Record<string, string> }, now: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE lien_waivers SET exceptions_text = ?, fields_json = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'draft'")
    .bind(w.exceptionsText, JSON.stringify(w.fields), now, waiverId, t.orgId)
    .run();
  return result.meta.changes > 0;
}

/** draft -> sent: the waiver joins the GC share page and its fields lock. */
export async function markWaiverSent(t: Tenant, db: D1Database, waiverId: string, now: number): Promise<boolean> {
  const result = await db.prepare("UPDATE lien_waivers SET status = 'sent', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'draft'").bind(now, waiverId, t.orgId).run();
  return result.meta.changes > 0;
}

/** draft | sent -> signed, keeping the filled form exactly as signed. */
export async function markWaiverSigned(
  t: Tenant,
  db: D1Database,
  waiverId: string,
  s: { signerName: string; signerTitle: string; signedAt: number; document: string },
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE lien_waivers SET status = 'signed', signer_name = ?, signer_title = ?, signed_at = ?, signed_document = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status IN ('draft', 'sent')")
    .bind(s.signerName, s.signerTitle, s.signedAt, s.document, now, waiverId, t.orgId)
    .run();
  return result.meta.changes > 0;
}

/** Orgs whose trial or subscription is live; a scheduled job's only source of org ids. */
export async function reminderOrgs(db: D1Database, now: number): Promise<{ id: string; name: string }[]> {
  const { results } = await db.prepare("SELECT id, name FROM orgs WHERE subscription_status = 'active' OR trial_ends_at > ? ORDER BY created_at").bind(now).all<{ id: string; name: string }>();
  return results;
}

/** Records each reminder before it is sent; returns only the ones not already recorded, so a retried run sends nothing twice. */
export async function claimReminders(db: D1Database, orgId: string, keys: { subjectKey: string; dueOn: string }[], now: number): Promise<{ subjectKey: string; dueOn: string }[]> {
  if (keys.length === 0) return [];
  const results = await db.batch(
    keys.map((k) => db.prepare("INSERT OR IGNORE INTO sent_reminders (org_id, subject_key, due_on, sent_at) VALUES (?, ?, ?, ?)").bind(orgId, k.subjectKey, k.dueOn, now)),
  );
  return keys.filter((_, i) => results[i]!.meta.changes > 0);
}

export async function releaseReminders(db: D1Database, orgId: string, keys: { subjectKey: string; dueOn: string }[]) {
  if (keys.length === 0) return;
  await db.batch(keys.map((k) => db.prepare("DELETE FROM sent_reminders WHERE org_id = ? AND subject_key = ? AND due_on = ?").bind(orgId, k.subjectKey, k.dueOn)));
}

export const EXPORT_TABLES = {
  projects: `SELECT ${PROJECT_COLUMNS} FROM projects WHERE org_id = ? ORDER BY created_at`,
  sov_lines: "SELECT id, project_id, position, item_no, description, scheduled_cents, change_order_id, created_at, updated_at FROM sov_lines WHERE org_id = ? ORDER BY project_id, position",
  change_orders: "SELECT id, project_id, number, title, amount_cents, status, approved_at, created_at, updated_at FROM change_orders WHERE org_id = ? ORDER BY project_id, number",
  pay_apps:
    "SELECT id, project_id, number, period_from, period_to, status, retainage_work_bp, retainage_stored_bp, submitted_at, paid_at, paid_cents, is_final, created_at, updated_at FROM pay_apps WHERE org_id = ? ORDER BY project_id, number",
  pay_app_lines: `SELECT ${LINE_COLUMNS} FROM pay_app_lines WHERE org_id = ? ORDER BY pay_app_id`,
  lien_waivers: `SELECT ${WAIVER_COLUMNS}, updated_at FROM lien_waivers WHERE org_id = ? ORDER BY project_id, created_at`,
} as const;

export type ExportTable = keyof typeof EXPORT_TABLES;

export async function exportTable(t: Tenant, db: D1Database, table: ExportTable): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare(EXPORT_TABLES[table]).bind(t.orgId).all<Record<string, unknown>>();
  return results;
}
