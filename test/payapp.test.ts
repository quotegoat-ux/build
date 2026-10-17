import { describe, expect, it } from "vitest";
import { formatBp, formatMoney, parseMoney, parsePercentBp } from "../src/money";
import { computePayApp, validate, type ChangeOrderRef, type PayAppInput, type Period, type SovLine } from "../src/payapp";
import { parseSovPaste } from "../src/sovPaste";

const base: SovLine[] = [
  { id: "l1", itemNo: "1", description: "Mobilization", scheduledCents: 1_000_000, changeOrderId: null },
  { id: "l2", itemNo: "2", description: "Rough-in", scheduledCents: 6_000_000, changeOrderId: null },
  { id: "l3", itemNo: "3", description: "Fixtures", scheduledCents: 3_000_000, changeOrderId: null },
];
const coLine: SovLine = { id: "l4", itemNo: "CO-1", description: "Add 4 EV chargers", scheduledCents: 500_000, changeOrderId: "co1" };
const approved: ChangeOrderRef[] = [{ id: "co1", amountCents: 500_000, status: "approved" }];

const line = (sovLineId: string, workThisPeriodCents: number, storedToDateCents = 0) => ({ sovLineId, workThisPeriodCents, storedToDateCents });

const p1: Period = { retainageWorkBp: 1000, retainageStoredBp: 500, lines: [line("l1", 1_000_000), line("l2", 1_500_000), line("l3", 0, 800_000)] };
const p2: Period = {
  retainageWorkBp: 1000,
  retainageStoredBp: 500,
  lines: [line("l1", 0), line("l2", 2_000_000), line("l3", 1_200_000, 0), line("l4", 100_000, 33_333)],
};
const p3: Period = { retainageWorkBp: 500, retainageStoredBp: 500, lines: [line("l1", 0), line("l2", 2_500_000), line("l3", 1_800_000), line("l4", 400_000, 0)] };

const period1: PayAppInput = { originalContractCents: 10_000_000, changeOrders: [], sov: base, prior: [], current: p1 };
const period2: PayAppInput = { originalContractCents: 10_000_000, changeOrders: approved, sov: [...base, coLine], prior: [p1], current: p2 };
const period3: PayAppInput = { originalContractCents: 10_000_000, changeOrders: approved, sov: [...base, coLine], prior: [p1, p2], current: p3 };

describe("computePayApp: three periods with a change order, stored materials installed, and a retainage cut", () => {
  it("period 1: work at 10% retainage, fixtures stored at 5%", () => {
    const r = computePayApp(period1);
    expect(r.rows.map(({ sovLineId, c, d, e, f, g, pctBp, h, i }) => [sovLineId, c, d, e, f, g, pctBp, h, i])).toEqual([
      ["l1", 1_000_000, 0, 1_000_000, 0, 1_000_000, 10000, 0, 100_000],
      ["l2", 6_000_000, 0, 1_500_000, 0, 1_500_000, 2500, 4_500_000, 150_000],
      ["l3", 3_000_000, 0, 0, 800_000, 800_000, 2667, 2_200_000, 40_000],
    ]);
    expect(r.totals).toEqual({ c: 10_000_000, d: 0, e: 2_500_000, f: 800_000, g: 3_300_000, pctBp: 3300, h: 6_700_000, i: 290_000 });
    expect(r.g702).toEqual({
      originalContract: 10_000_000,
      netChangeOrders: 0,
      contractSumToDate: 10_000_000,
      completedStoredToDate: 3_300_000,
      retainage: 290_000,
      earnedLessRetainage: 3_010_000,
      previousCertificates: 0,
      currentPaymentDue: 3_010_000,
      balanceToFinish: 6_990_000,
    });
    expect(validate(period1)).toEqual([]);
  });

  it("period 2: approved change order adds line 2 and a schedule line; stored fixtures move into work", () => {
    const r = computePayApp(period2);
    expect(r.rows.map(({ sovLineId, c, d, e, f, g, pctBp, h, i }) => [sovLineId, c, d, e, f, g, pctBp, h, i])).toEqual([
      ["l1", 1_000_000, 1_000_000, 0, 0, 1_000_000, 10000, 0, 100_000],
      ["l2", 6_000_000, 1_500_000, 2_000_000, 0, 3_500_000, 5833, 2_500_000, 350_000],
      ["l3", 3_000_000, 0, 1_200_000, 0, 1_200_000, 4000, 1_800_000, 120_000],
      ["l4", 500_000, 0, 100_000, 33_333, 133_333, 2667, 366_667, 11_667],
    ]);
    expect(r.totals).toEqual({ c: 10_500_000, d: 2_500_000, e: 3_300_000, f: 33_333, g: 5_833_333, pctBp: 5556, h: 4_666_667, i: 581_667 });
    expect(r.g702).toEqual({
      originalContract: 10_000_000,
      netChangeOrders: 500_000,
      contractSumToDate: 10_500_000,
      completedStoredToDate: 5_833_333,
      retainage: 581_667,
      earnedLessRetainage: 5_251_666,
      previousCertificates: 3_010_000,
      currentPaymentDue: 2_241_666,
      balanceToFinish: 5_248_334,
    });
    expect(validate(period2)).toEqual([]);
  });

  it("period 3: retainage drops to 5% on all work to date; line 7 uses period 2 at its own 10%", () => {
    const r = computePayApp(period3);
    expect(r.rows.map(({ sovLineId, d, e, f, g, pctBp, h, i }) => [sovLineId, d, e, f, g, pctBp, h, i])).toEqual([
      ["l1", 1_000_000, 0, 0, 1_000_000, 10000, 0, 50_000],
      ["l2", 3_500_000, 2_500_000, 0, 6_000_000, 10000, 0, 300_000],
      ["l3", 1_200_000, 1_800_000, 0, 3_000_000, 10000, 0, 150_000],
      ["l4", 100_000, 400_000, 0, 500_000, 10000, 0, 25_000],
    ]);
    expect(r.g702).toEqual({
      originalContract: 10_000_000,
      netChangeOrders: 500_000,
      contractSumToDate: 10_500_000,
      completedStoredToDate: 10_500_000,
      retainage: 525_000,
      earnedLessRetainage: 9_975_000,
      previousCertificates: 5_251_666,
      currentPaymentDue: 4_723_334,
      balanceToFinish: 525_000,
    });
    expect(validate(period3)).toEqual([]);
  });

  it("pending and rejected change orders do not count toward line 2", () => {
    const r = computePayApp({
      ...period2,
      changeOrders: [...approved, { id: "co2", amountCents: 70_000, status: "pending" }, { id: "co3", amountCents: 90_000, status: "rejected" }],
    });
    expect(r.g702.netChangeOrders).toBe(500_000);
    expect(r.g702.contractSumToDate).toBe(10_500_000);
  });
});

describe("validate", () => {
  it("flags a line past 100%, work to date below zero, and negative stored materials", () => {
    const issues = validate({ ...period2, current: { ...p2, lines: [line("l1", 1), line("l2", -1_600_000), line("l3", 0, -5), line("l4", 0)] } });
    expect(issues).toEqual([
      { kind: "over_complete", sovLineId: "l1", itemNo: "1", completedCents: 1_000_001, scheduledCents: 1_000_000 },
      { kind: "below_zero", sovLineId: "l2", itemNo: "2", workToDateCents: -100_000 },
      { kind: "negative_stored", sovLineId: "l3", itemNo: "3", storedCents: -5 },
    ]);
  });

  it("flags stored materials on a zero-value line and billing on an unapproved change order line", () => {
    const allowance: SovLine = { id: "l5", itemNo: "5", description: "Allowance", scheduledCents: 0, changeOrderId: null };
    const issues = validate({
      ...period1,
      changeOrders: [{ id: "co1", amountCents: 500_000, status: "pending" }],
      sov: [...base, { ...coLine, scheduledCents: 0 }, allowance],
      current: { ...p1, lines: [...p1.lines, line("l4", 0, 0), line("l5", 0, 10_000)] },
    });
    expect(issues).toEqual([
      { kind: "over_complete", sovLineId: "l5", itemNo: "5", completedCents: 10_000, scheduledCents: 0 },
      { kind: "stored_without_value", sovLineId: "l5", itemNo: "5", storedCents: 10_000 },
    ]);
    const billedPending = validate({
      ...period2,
      changeOrders: [{ id: "co1", amountCents: 500_000, status: "pending" }],
    });
    expect(billedPending).toEqual([
      { kind: "unapproved_change_order", sovLineId: "l4", itemNo: "CO-1", status: "pending" },
      { kind: "sov_mismatch", sovTotalCents: 10_500_000, contractSumCents: 10_000_000 },
    ]);
  });

  it("flags billing past the contract sum and a schedule that does not tie to it", () => {
    const issues = validate({
      ...period1,
      originalContractCents: 2_000_000,
      current: { ...p1, lines: [line("l1", 1_000_000), line("l2", 1_500_000)] },
    });
    expect(issues).toEqual([
      { kind: "over_contract", completedCents: 2_500_000, contractSumCents: 2_000_000 },
      { kind: "sov_mismatch", sovTotalCents: 10_000_000, contractSumCents: 2_000_000 },
    ]);
  });

  it("treats a deductive change order line as over 100% when billed past its negative value", () => {
    const deduct: SovLine = { id: "l6", itemNo: "CO-2", description: "Delete lobby sconces", scheduledCents: -40_000, changeOrderId: "co2" };
    const issues = validate({
      ...period1,
      originalContractCents: 10_000_000,
      changeOrders: [{ id: "co2", amountCents: -40_000, status: "approved" }],
      sov: [...base, deduct],
      current: { ...p1, lines: [...p1.lines, line("l6", -50_000)] },
    });
    expect(issues).toEqual([{ kind: "over_complete", sovLineId: "l6", itemNo: "CO-2", completedCents: -50_000, scheduledCents: -40_000 }]);
  });
});

describe("money parsing", () => {
  it("parses dollar strings into cents and percentages into basis points", () => {
    expect(["$12,500.50", "12500.5", "(1,200)", "-40", ".07", "1,23", "abc", ""].map(parseMoney)).toEqual([1_250_050, 1_250_050, -120_000, -4000, 7, null, null, null]);
    expect(["10", "10%", "5.25", "x"].map(parsePercentBp)).toEqual([1000, 1000, 525, null]);
    expect([formatMoney(1_250_050), formatMoney(-7), formatBp(1000), formatBp(525)]).toEqual(["$12,500.50", "-$0.07", "10%", "5.25%"]);
  });
});

describe("parseSovPaste", () => {
  it("reads Excel tab-separated rows, skipping the header and total rows", () => {
    const text = "Item\tDescription\tScheduled Value\n1\tMobilization\t$12,000.00\n2\tBranch wiring, levels 1-3\t148,500\n\tTotal\t160,500.00\n";
    expect(parseSovPaste(text)).toEqual({
      lines: [
        { itemNo: "1", description: "Mobilization", scheduledCents: 1_200_000 },
        { itemNo: "2", description: "Branch wiring, levels 1-3", scheduledCents: 14_850_000 },
      ],
      errors: [],
    });
  });

  it("reads comma-separated rows with thousands separators, quotes, and two-column rows, and reports bad rows", () => {
    const text = '1, Conduit, boxes and wire, 12,500.00\n"2","Switchgear, 2000A","$84,000"\nTemporary power,3500\n4,Fire alarm,TBD';
    expect(parseSovPaste(text, 10)).toEqual({
      lines: [
        { itemNo: "1", description: "Conduit, boxes and wire", scheduledCents: 1_250_000 },
        { itemNo: "2", description: "Switchgear, 2000A", scheduledCents: 8_400_000 },
        { itemNo: "12", description: "Temporary power", scheduledCents: 350_000 },
      ],
      errors: [{ row: 4, text: "4,Fire alarm,TBD" }],
    });
  });
});
