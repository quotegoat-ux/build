export type ChangeOrderStatus = "pending" | "approved" | "rejected";

export interface SovLine {
  id: string;
  itemNo: string;
  description: string;
  scheduledCents: number;
  changeOrderId: string | null;
}

export interface ChangeOrderRef {
  id: string;
  amountCents: number;
  status: ChangeOrderStatus;
}

export interface LineEntry {
  sovLineId: string;
  workThisPeriodCents: number;
  storedToDateCents: number;
}

export interface Period {
  retainageWorkBp: number;
  retainageStoredBp: number;
  lines: LineEntry[];
}

export interface PayAppInput {
  originalContractCents: number;
  changeOrders: ChangeOrderRef[];
  sov: SovLine[];
  prior: Period[];
  current: Period;
}

export interface G703Row {
  sovLineId: string;
  itemNo: string;
  description: string;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  pctBp: number;
  h: number;
  i: number;
}

export type G703Totals = Omit<G703Row, "sovLineId" | "itemNo" | "description">;

export interface G702 {
  originalContract: number;
  netChangeOrders: number;
  contractSumToDate: number;
  completedStoredToDate: number;
  retainage: number;
  earnedLessRetainage: number;
  previousCertificates: number;
  currentPaymentDue: number;
  balanceToFinish: number;
}

export interface PayAppResult {
  rows: G703Row[];
  totals: G703Totals;
  g702: G702;
}

export type Issue =
  | { kind: "over_complete"; sovLineId: string; itemNo: string; completedCents: number; scheduledCents: number }
  | { kind: "below_zero"; sovLineId: string; itemNo: string; workToDateCents: number }
  | { kind: "negative_stored"; sovLineId: string; itemNo: string; storedCents: number }
  | { kind: "stored_without_value"; sovLineId: string; itemNo: string; storedCents: number }
  | { kind: "unapproved_change_order"; sovLineId: string; itemNo: string; status: ChangeOrderStatus | "missing" }
  | { kind: "over_contract"; completedCents: number; contractSumCents: number }
  | { kind: "sov_mismatch"; sovTotalCents: number; contractSumCents: number };

export function retainageOf(amountCents: number, bp: number): number {
  return Math.round((amountCents * bp) / 10000);
}

export function pctBp(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part * 10000) / whole);
}

function sumBy<T>(items: readonly T[], f: (x: T) => number): number {
  return items.reduce((s, x) => s + f(x), 0);
}

function priorWorkByLine(prior: readonly Period[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const p of prior) for (const l of p.lines) d.set(l.sovLineId, (d.get(l.sovLineId) ?? 0) + l.workThisPeriodCents);
  return d;
}

/** Line 6 of a period: everything earned through it, less the retainage that period held. */
function earnedLessRetainage(prior: readonly Period[], period: Period): number {
  const d = priorWorkByLine(prior);
  return sumBy(period.lines, (l) => {
    const work = (d.get(l.sovLineId) ?? 0) + l.workThisPeriodCents;
    const i = retainageOf(work, period.retainageWorkBp) + retainageOf(l.storedToDateCents, period.retainageStoredBp);
    return work + l.storedToDateCents - i;
  });
}

export function computePayApp(input: PayAppInput): PayAppResult {
  const { current, prior } = input;
  const d = priorWorkByLine(prior);
  const entries = new Map(current.lines.map((l) => [l.sovLineId, l]));
  const rows = input.sov.map((line): G703Row => {
    const entry = entries.get(line.id);
    const c = line.scheduledCents;
    const dv = d.get(line.id) ?? 0;
    const e = entry?.workThisPeriodCents ?? 0;
    const f = entry?.storedToDateCents ?? 0;
    const g = dv + e + f;
    return {
      sovLineId: line.id,
      itemNo: line.itemNo,
      description: line.description,
      c,
      d: dv,
      e,
      f,
      g,
      pctBp: pctBp(g, c),
      h: c - g,
      i: retainageOf(dv + e, current.retainageWorkBp) + retainageOf(f, current.retainageStoredBp),
    };
  });
  const totals: G703Totals = {
    c: sumBy(rows, (r) => r.c),
    d: sumBy(rows, (r) => r.d),
    e: sumBy(rows, (r) => r.e),
    f: sumBy(rows, (r) => r.f),
    g: sumBy(rows, (r) => r.g),
    pctBp: 0,
    h: sumBy(rows, (r) => r.h),
    i: sumBy(rows, (r) => r.i),
  };
  totals.pctBp = pctBp(totals.g, totals.c);

  const netChangeOrders = sumBy(
    input.changeOrders.filter((co) => co.status === "approved"),
    (co) => co.amountCents,
  );
  const contractSumToDate = input.originalContractCents + netChangeOrders;
  const earned = totals.g - totals.i;
  const previous = prior.length === 0 ? 0 : earnedLessRetainage(prior.slice(0, -1), prior[prior.length - 1]!);
  return {
    rows,
    totals,
    g702: {
      originalContract: input.originalContractCents,
      netChangeOrders,
      contractSumToDate,
      completedStoredToDate: totals.g,
      retainage: totals.i,
      earnedLessRetainage: earned,
      previousCertificates: previous,
      currentPaymentDue: earned - previous,
      balanceToFinish: contractSumToDate - earned,
    },
  };
}

export function validate(input: PayAppInput): Issue[] {
  const { rows, g702 } = computePayApp(input);
  const coStatus = new Map(input.changeOrders.map((co) => [co.id, co.status]));
  const sovById = new Map(input.sov.map((l) => [l.id, l]));
  const issues: Issue[] = [];
  for (const r of rows) {
    const line = { sovLineId: r.sovLineId, itemNo: r.itemNo };
    const sign = r.c < 0 ? -1 : 1;
    if (sign * r.g > sign * r.c) issues.push({ kind: "over_complete", ...line, completedCents: r.g, scheduledCents: r.c });
    if (sign * (r.d + r.e) < 0) issues.push({ kind: "below_zero", ...line, workToDateCents: r.d + r.e });
    if (r.f < 0) issues.push({ kind: "negative_stored", ...line, storedCents: r.f });
    if (r.f !== 0 && r.c === 0) issues.push({ kind: "stored_without_value", ...line, storedCents: r.f });
    const coId = sovById.get(r.sovLineId)?.changeOrderId;
    const status = coId ? (coStatus.get(coId) ?? "missing") : "approved";
    if (status !== "approved" && (r.e !== 0 || r.f !== 0)) issues.push({ kind: "unapproved_change_order", ...line, status });
  }
  if (g702.completedStoredToDate > g702.contractSumToDate) {
    issues.push({ kind: "over_contract", completedCents: g702.completedStoredToDate, contractSumCents: g702.contractSumToDate });
  }
  const sovTotal = sumBy(input.sov, (l) => l.scheduledCents);
  if (sovTotal !== g702.contractSumToDate) issues.push({ kind: "sov_mismatch", sovTotalCents: sovTotal, contractSumCents: g702.contractSumToDate });
  return issues;
}
