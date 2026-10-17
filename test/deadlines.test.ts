import { describe, expect, it } from "vitest";
import { DEADLINE_RULES } from "../src/data/lienDeadlines";
import { addMonths, computeDeadlines, monthsTouched } from "../src/deadlines";

const none = { firstFurnishedOn: null, lastFurnishedOn: null, monthsWithWork: [] };

describe("computeDeadlines", () => {
  it("TX: a notice and a lien deadline per unpaid month of work, and a suit deadline a year after each lien deadline", () => {
    expect(computeDeadlines(DEADLINE_RULES.TX, { ...none, state: "TX", firstFurnishedOn: "2026-08-03", monthsWithWork: ["2026-09", "2026-10"] })).toEqual({
      citation: "Tex. Prop. Code §§ 53.052, 53.055, 53.056, 53.057, 53.158 (as amended by Acts 2021, H.B. 2237)",
      notes: [],
      deadlines: [
        { kind: "prelim_notice", dueOn: "2026-12-15", basis: "15th day of the 3rd month after unpaid work in Sep 2026", confidence: "high" },
        { kind: "prelim_notice", dueOn: "2027-01-15", basis: "15th day of the 3rd month after unpaid work in Oct 2026", confidence: "high" },
        { kind: "lien_filing", dueOn: "2027-01-15", basis: "15th day of the 4th month after unpaid work in Sep 2026", confidence: "high" },
        { kind: "lien_filing", dueOn: "2027-02-15", basis: "15th day of the 4th month after unpaid work in Oct 2026", confidence: "high" },
        { kind: "enforcement", dueOn: "2028-01-15", basis: "12 months after the lien filing deadline", confidence: "high" },
        { kind: "enforcement", dueOn: "2028-02-15", basis: "12 months after the lien filing deadline", confidence: "high" },
      ],
    });
  });

  it("TX with nothing unpaid has no running deadlines and says what would start them", () => {
    expect(computeDeadlines(DEADLINE_RULES.TX, { ...none, state: "TX" })).toMatchObject({
      deadlines: [],
      notes: [
        "Lien filing: add a submitted, unpaid pay application to estimate this deadline.",
        "Preliminary notice: add a submitted, unpaid pay application to estimate this deadline.",
        "Lien enforcement suit: add a lien filing deadline to estimate this deadline.",
      ],
    });
  });

  it("CA: 20-day notice from first furnishing, lien 90 days after completion (estimated from last furnishing), suit 90 days after recording", () => {
    expect(computeDeadlines(DEADLINE_RULES.CA, { ...none, state: "CA", firstFurnishedOn: "2026-08-03", lastFurnishedOn: "2026-11-20" }).deadlines).toEqual([
      { kind: "prelim_notice", dueOn: "2026-08-23", basis: "20 days after first furnishing labor or materials", confidence: "high" },
      { kind: "lien_filing", dueOn: "2027-02-18", basis: "90 days after completion (estimated as your last furnishing date)", confidence: "high" },
      { kind: "enforcement", dueOn: "2027-05-19", basis: "90 days after recording the lien, assuming it is recorded on the last day to file", confidence: "high" },
    ]);
    expect(computeDeadlines(DEADLINE_RULES.CA, { ...none, state: "CA", firstFurnishedOn: "2026-08-03", lastFurnishedOn: "2026-11-20", completionOn: "2026-12-15" }).deadlines.map((d) => d.dueOn)).toEqual([
      "2026-08-23",
      "2027-03-15",
      "2027-06-13",
    ]);
  });

  it("CA without a last furnishing date keeps the notice and asks for the date", () => {
    const report = computeDeadlines(DEADLINE_RULES.CA, { ...none, state: "CA", firstFurnishedOn: "2026-08-03" });
    expect(report.deadlines.map((d) => [d.kind, d.dueOn])).toEqual([["prelim_notice", "2026-08-23"]]);
    expect(report.notes).toEqual(["Lien filing: add a last furnishing date to estimate this deadline.", "Lien enforcement suit: add a lien filing deadline to estimate this deadline."]);
  });

  it("FL: 45-day notice to owner, lien 90 days after last furnishing, suit a year after recording", () => {
    expect(computeDeadlines(DEADLINE_RULES.FL, { ...none, state: "FL", firstFurnishedOn: "2026-08-03", lastFurnishedOn: "2026-11-20" }).deadlines).toEqual([
      { kind: "prelim_notice", dueOn: "2026-09-17", basis: "45 days after first furnishing labor or materials", confidence: "high" },
      { kind: "lien_filing", dueOn: "2027-02-18", basis: "90 days after last furnishing labor or materials", confidence: "high" },
      { kind: "enforcement", dueOn: "2028-02-18", basis: "12 months after recording the lien, assuming it is recorded on the last day to file", confidence: "high" },
    ]);
  });

  it("NY requires no preliminary notice; PA's required notice counts back from the lien deadline", () => {
    const ny = computeDeadlines(DEADLINE_RULES.NY, { ...none, state: "NY", lastFurnishedOn: "2026-11-20" });
    expect(ny.notes).toEqual(["No preliminary notice is required of a first-tier subcontractor on a private job in NY."]);
    expect(ny.deadlines.map((d) => [d.kind, d.dueOn])).toEqual([
      ["lien_filing", "2027-07-20"],
      ["enforcement", "2028-07-20"],
    ]);
    expect(computeDeadlines(DEADLINE_RULES.PA, { ...none, state: "PA", firstFurnishedOn: "2026-08-03", lastFurnishedOn: "2027-01-20" }).deadlines).toEqual([
      { kind: "prelim_notice", dueOn: "2027-06-20", basis: "30 days before the lien filing deadline", confidence: "high" },
      { kind: "lien_filing", dueOn: "2027-07-20", basis: "6 months after completion (estimated as your last furnishing date)", confidence: "high" },
      { kind: "enforcement", dueOn: "2029-07-20", basis: "24 months after recording the lien, assuming it is recorded on the last day to file", confidence: "high" },
    ]);
  });

  it("a state with no rules on file says so instead of guessing", () => {
    expect(computeDeadlines(DEADLINE_RULES.OK, { ...none, state: "OK", firstFurnishedOn: "2026-08-03", lastFurnishedOn: "2026-11-20" })).toEqual({
      deadlines: [],
      notes: ["No rules on file for OK; check your state's statute."],
      citation: null,
    });
  });
});

describe("date helpers", () => {
  it("clamps month arithmetic to the end of the month and lists every month a period touches", () => {
    expect([addMonths("2026-01-31", 1), addMonths("2027-11-15", 3), addMonths("2028-02-29", 12)]).toEqual(["2026-02-28", "2028-02-15", "2029-02-28"]);
    expect(monthsTouched("2026-11-25", "2027-01-05")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});
