import { GENERIC_WAIVER_FORMS, STATE_WAIVER_RULES } from "./data/lienWaivers";
import { payAppView, utcDay } from "./ledger";
import { formatMoney } from "./money";
import type { G702 } from "./payapp";
import type { Ledger, PayAppStatus, Project, WaiverRow } from "./projectsDb";

export const WAIVER_KINDS = ["conditional_progress", "unconditional_progress", "conditional_final", "unconditional_final"] as const;
export type WaiverKind = (typeof WAIVER_KINDS)[number];
export type WaiverStatus = "draft" | "sent" | "signed";

export interface WaiverForm {
  title: string;
  body: string;
  verified: boolean;
}

export interface StateWaiverRules {
  citation: string;
  notarize: boolean;
  witness: boolean;
  forms: Partial<Record<WaiverKind, WaiverForm>>;
  /** Why a kind has no statutory form, from the research notes. */
  gaps: Partial<Record<WaiverKind, string>>;
}

export type WaiverTemplate = WaiverForm & { notarize: boolean; witness: boolean } & (
    | { source: "statutory"; state: string; citation: string }
    | { source: "generic"; reason: string; detail: string | null }
  );

export const WAIVER_KIND_LABEL: Record<WaiverKind, string> = {
  conditional_progress: "Conditional progress",
  unconditional_progress: "Unconditional progress",
  conditional_final: "Conditional final",
  unconditional_final: "Unconditional final",
};

export const WAIVER_DISCLAIMER =
  "Drawbook is not a law firm and does not give legal advice. Lien waiver forms are provided as-is, without warranty. Verify the form and how you use it with your counsel before signing.";

export const UNVERIFIED_BADGE = "Not statutory text. Have counsel review.";

const NOTARY_BLOCK = `NOTARY ACKNOWLEDGMENT
State of {{notary_state}}, County of {{notary_county}}
Subscribed and sworn to before me on {{notary_date}} by {{signer_name}}.
Notary public: {{notary_name}}
My commission expires: {{notary_commission_expires}}`;

const WITNESS_BLOCK = `WITNESS
Witness signature: ____________________
Witness name: {{witness_name}}
Witness address: {{witness_address}}`;

/** Filled from project, org, pay app, and signing data; every other placeholder is a field on the waiver screen. */
const AUTO_FIELDS = new Set(["claimant", "customer", "owner", "job_name", "job_location", "through_date", "amount", "exceptions", "signer_name", "signer_title", "date"]);

const BLANK = "____________________";

/** The state's statutory form for this kind when it has one, otherwise the generic form; notary and witness blocks follow the state. */
export function selectTemplate(state: string, kind: WaiverKind): WaiverTemplate {
  const rules = STATE_WAIVER_RULES[state];
  const form = rules?.forms[kind];
  const requirements = { notarize: rules?.notarize ?? false, witness: rules?.witness ?? false };
  const withBlocks = (t: WaiverTemplate): WaiverTemplate => {
    const blocks = [t.notarize && !t.body.includes("{{notary_name}}") && NOTARY_BLOCK, t.witness && !t.body.includes("{{witness_name}}") && WITNESS_BLOCK].filter(Boolean);
    return blocks.length ? { ...t, body: [t.body, ...blocks].join("\n\n") } : t;
  };
  if (rules && form) return withBlocks({ ...form, ...requirements, source: "statutory", state, citation: rules.citation });
  const label = WAIVER_KIND_LABEL[kind].toLowerCase();
  const reason = !state
    ? "The project has no state set, so this uses Drawbook's generic form."
    : rules
      ? `${state} has no statutory ${label} waiver form, so this uses Drawbook's generic form.`
      : `${state} does not prescribe a statutory lien waiver form, so this uses Drawbook's generic form.`;
  return withBlocks({ ...GENERIC_WAIVER_FORMS[kind], ...requirements, source: "generic", reason, detail: rules?.gaps[kind] ?? null });
}

export function placeholders(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
}

export function fieldLabel(key: string): string {
  const s = key.replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function editableFields(template: WaiverTemplate): string[] {
  return placeholders(template.body).filter((k) => !AUTO_FIELDS.has(k));
}

export interface WaiverContext {
  orgName: string;
  project: Pick<Project, "name" | "number" | "gc_name" | "owner_name" | "location" | "state">;
  payApp: { number: number; submittedAt: number | null; g702: G702 } | null;
  waiver: { amount_cents: number; through_date: string; exceptions_text: string; signer_name: string | null; signer_title: string | null; signed_at: number | null; fields: Record<string, string> };
  priorUnpaid: { date: string; amountCents: number }[];
}

const amount = (cents: number) => formatMoney(cents).replace("$", "");

export function waiverValues(ctx: WaiverContext): Record<string, string> {
  const { project: p, payApp, waiver: w } = ctx;
  const g = payApp?.g702;
  const defaults: Record<string, string | undefined> = {
    maker_of_check: p.gc_name,
    check_payable_to: ctx.orgName,
    job_number: p.number,
    job_description: p.name,
    invoice_number: payApp ? `Pay application #${payApp.number}` : undefined,
    application_number: payApp ? String(payApp.number) : undefined,
    invoice_date: payApp?.submittedAt ? utcDay(payApp.submittedAt) : undefined,
    state: p.state,
    notary_state: p.state,
    retainage_amount: g && amount(g.retainage),
    retainage: g && amount(g.retainage),
    original_contract_amount: g && amount(g.originalContract),
    approved_change_orders: g && amount(g.netChangeOrders),
    adjusted_contract_amount: g && amount(g.contractSumToDate),
    completed_to_date: g && amount(g.completedStoredToDate),
    previous_payments: g && amount(g.previousCertificates),
    total_payable_to_date: g && amount(g.earnedLessRetainage),
    prior_unpaid_waiver_dates: ctx.priorUnpaid.length ? ctx.priorUnpaid.map((u) => u.date).join(", ") : "None",
    prior_unpaid_waiver_amounts: ctx.priorUnpaid.length ? ctx.priorUnpaid.map((u) => amount(u.amountCents)).join(", ") : "0.00",
  };
  const typed = Object.fromEntries(Object.entries(w.fields).filter(([, v]) => v !== ""));
  return {
    ...(Object.fromEntries(Object.entries(defaults).filter(([, v]) => v)) as Record<string, string>),
    ...typed,
    claimant: ctx.orgName,
    customer: p.gc_name,
    owner: p.owner_name,
    job_name: p.name,
    job_location: [p.location, p.state].filter(Boolean).join(", "),
    through_date: w.through_date,
    amount: amount(w.amount_cents),
    exceptions: w.exceptions_text || "None",
    signer_name: w.signer_name ?? "",
    signer_title: w.signer_title ?? "",
    date: w.signed_at ? utcDay(w.signed_at) : "",
  };
}

export function fillTemplate(template: WaiverTemplate, values: Record<string, string>): WaiverTemplate {
  return { ...template, body: template.body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] || BLANK) };
}

/**
 * California's conditional progress form lists earlier conditional waivers whose payment has not arrived: the
 * project's other conditional progress waivers on applications still awaiting payment, created before this one.
 */
export function priorUnpaidWaivers(
  waiver: { id: string; created_at: number },
  projectWaivers: { id: string; kind: WaiverKind; pay_app_id: string | null; amount_cents: number; created_at: number }[],
  payApps: { id: string; status: PayAppStatus }[],
): { date: string; amountCents: number }[] {
  const awaiting = new Set(payApps.filter((a) => a.status === "submitted").map((a) => a.id));
  return projectWaivers
    .filter((w) => w.id !== waiver.id && w.kind === "conditional_progress" && w.pay_app_id !== null && awaiting.has(w.pay_app_id) && w.created_at < waiver.created_at)
    .map((w) => ({ date: utcDay(w.created_at), amountCents: w.amount_cents }));
}

export interface WaiverView {
  waiver: WaiverRow;
  project: Project;
  payAppNumber: number | null;
  /** The filled form: the snapshot taken at signing, or built from current data while unsigned. */
  document: WaiverTemplate;
  fields: { key: string; label: string; value: string }[];
}

export function waiverView(orgName: string, ledger: Ledger, waiver: WaiverRow, projectWaivers: WaiverRow[]): WaiverView {
  const app = ledger.payApps.find((a) => a.id === waiver.pay_app_id) ?? null;
  const template = selectTemplate(waiver.state, waiver.kind);
  const values = waiverValues({
    orgName,
    project: ledger.project,
    payApp: app && { number: app.number, submittedAt: app.submitted_at, g702: payAppView(ledger, app).result.g702 },
    waiver: { ...waiver, fields: JSON.parse(waiver.fields_json) as Record<string, string> },
    priorUnpaid: priorUnpaidWaivers(waiver, projectWaivers, ledger.payApps),
  });
  return {
    waiver,
    project: ledger.project,
    payAppNumber: app?.number ?? null,
    document: waiver.signed_document ? (JSON.parse(waiver.signed_document) as WaiverTemplate) : fillTemplate(template, values),
    fields: editableFields(template).map((key) => ({ key, label: fieldLabel(key), value: values[key] ?? "" })),
  };
}
