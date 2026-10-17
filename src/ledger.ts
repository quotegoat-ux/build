import { computePayApp, validate, type Issue, type PayAppInput, type PayAppResult, type Period } from "./payapp";
import type { Ledger, PayAppRow, Project } from "./projectsDb";

const DAY_MS = 86_400_000;

export interface PayAppView {
  project: Project;
  payApp: PayAppRow;
  input: PayAppInput;
  result: PayAppResult;
  issues: Issue[];
  isLatest: boolean;
}

function periodOf(ledger: Ledger, app: PayAppRow): Period {
  return {
    retainageWorkBp: app.retainage_work_bp,
    retainageStoredBp: app.retainage_stored_bp,
    lines: ledger.lines
      .filter((l) => l.pay_app_id === app.id)
      .map((l) => ({ sovLineId: l.sov_line_id, workThisPeriodCents: l.work_this_period_cents, storedToDateCents: l.stored_to_date_cents })),
  };
}

/**
 * A draft bills against the schedule as it stands. A submitted or paid app shows the lines it froze on submit and only
 * the change orders approved by then, so reprinting it later reproduces what the GC received.
 */
export function payAppInput(ledger: Ledger, app: PayAppRow): PayAppInput {
  const current = periodOf(ledger, app);
  const frozenAt = app.status === "draft" ? null : (app.submitted_at ?? 0);
  const billed = new Set(current.lines.map((l) => l.sovLineId));
  return {
    originalContractCents: ledger.project.original_contract_cents,
    changeOrders: ledger.changeOrders.map((co) => ({
      id: co.id,
      amountCents: co.amount_cents,
      status: co.status === "approved" && frozenAt !== null && (co.approved_at ?? 0) > frozenAt ? "pending" : co.status,
    })),
    sov: ledger.sov
      .filter((l) => frozenAt === null || billed.has(l.id))
      .map((l) => ({ id: l.id, itemNo: l.item_no, description: l.description, scheduledCents: l.scheduled_cents, changeOrderId: l.change_order_id })),
    prior: ledger.payApps.filter((a) => a.number < app.number).map((a) => periodOf(ledger, a)),
    current,
  };
}

export function payAppView(ledger: Ledger, app: PayAppRow): PayAppView {
  const input = payAppInput(ledger, app);
  return {
    project: ledger.project,
    payApp: app,
    input,
    result: computePayApp(input),
    issues: app.status === "draft" ? validate(input) : [],
    isLatest: !ledger.payApps.some((a) => a.number > app.number),
  };
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((Date.parse(utcDay(toMs)) - Date.parse(utcDay(fromMs))) / DAY_MS);
}

export interface ProjectSummary {
  project: Project;
  billedToDateCents: number;
  outstandingCents: number;
  retainageHeldCents: number;
  views: PayAppView[];
}

export function summarizeProject(ledger: Ledger): ProjectSummary {
  const views = ledger.payApps.map((a) => payAppView(ledger, a));
  const latestSent = views.filter((v) => v.payApp.status !== "draft").at(-1);
  return {
    project: ledger.project,
    billedToDateCents: latestSent?.result.g702.completedStoredToDate ?? 0,
    outstandingCents: views.filter((v) => v.payApp.status === "submitted").reduce((s, v) => s + v.result.g702.currentPaymentDue, 0),
    retainageHeldCents: latestSent?.result.g702.retainage ?? 0,
    views,
  };
}

export interface Dashboard {
  outstandingCents: number;
  retainageHeldCents: number;
  averageDaysToPay: number | null;
  awaiting: { view: PayAppView; daysOutstanding: number }[];
}

export function dashboard(summaries: ProjectSummary[], now: number): Dashboard {
  const all = summaries.flatMap((s) => s.views);
  const paid = all.filter((v) => v.payApp.status === "paid" && v.payApp.submitted_at !== null && v.payApp.paid_at !== null);
  return {
    outstandingCents: summaries.reduce((s, p) => s + p.outstandingCents, 0),
    retainageHeldCents: summaries.filter((s) => s.project.status === "active").reduce((s, p) => s + p.retainageHeldCents, 0),
    averageDaysToPay: paid.length === 0 ? null : Math.round(paid.reduce((s, v) => s + daysBetween(v.payApp.submitted_at!, v.payApp.paid_at!), 0) / paid.length),
    awaiting: all
      .filter((v) => v.payApp.status === "submitted")
      .map((view) => ({ view, daysOutstanding: daysBetween(view.payApp.submitted_at!, now) }))
      .sort((a, b) => b.daysOutstanding - a.daysOutstanding),
  };
}
