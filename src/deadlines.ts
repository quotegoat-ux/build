import { DEADLINE_RULES } from "./data/lienDeadlines";
import type { Ledger } from "./projectsDb";

export type Confidence = "high" | "medium-high" | "medium" | "low";

/**
 * When a deadline starts running. `lien_deadline` counts from the last day to file the lien; `lien_recorded` counts from
 * the day it is actually recorded, which Drawbook does not know, so it is estimated as that same last day.
 */
export type Trigger = "first_furnishing" | "last_furnishing" | "completion" | "lien_deadline" | "lien_recorded";

export type Rule =
  | { trigger: "month_of_work"; offsetMonths: number; dayOfMonth: number; required: boolean }
  | { trigger: Trigger; offset: { days: number } | { months: number }; required: boolean };

/** Rules per deadline kind: the first is the statute's main rule, the rest are alternatives where the earliest date controls. */
export interface StateDeadlineRules {
  citation: string;
  confidence: Confidence;
  prelim_notice: Rule[];
  lien_filing: Rule[];
  enforcement: Rule[];
}

export type DeadlineKind = "prelim_notice" | "lien_filing" | "enforcement";

export interface Deadline {
  kind: DeadlineKind;
  dueOn: string;
  basis: string;
  confidence: Confidence;
}

export interface DeadlineInput {
  state: string;
  firstFurnishedOn: string | null;
  lastFurnishedOn: string | null;
  completionOn?: string | null;
  /** "YYYY-MM" months with billed work that is still unpaid. */
  monthsWithWork: string[];
}

export interface DeadlineReport {
  deadlines: Deadline[];
  notes: string[];
  citation: string | null;
}

export const DEADLINE_LABEL: Record<DeadlineKind, string> = {
  prelim_notice: "Preliminary notice",
  lien_filing: "Lien filing",
  enforcement: "Lien enforcement suit",
};

const KINDS: DeadlineKind[] = ["prelim_notice", "lien_filing", "enforcement"];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar months, clamped to the end of a shorter month: 2026-01-31 + 1 month = 2026-02-28. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = index % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Every calendar month a billing period touches. */
export function monthsTouched(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(`${m}-01`, 1).slice(0, 7)) months.push(m);
  return months;
}

interface Candidate {
  group: string;
  dueOn: string;
  basis: string;
}

function offsetText(offset: { days: number } | { months: number }): { amount: string; before: boolean } {
  const n = "days" in offset ? offset.days : offset.months;
  const unit = "days" in offset ? "day" : "month";
  return { amount: `${Math.abs(n)} ${unit}${Math.abs(n) === 1 ? "" : "s"}`, before: n < 0 };
}

function shift(day: string, offset: { days: number } | { months: number }): string {
  return "days" in offset ? addDays(day, offset.days) : addMonths(day, offset.months);
}

function candidates(rule: Rule, input: DeadlineInput, liens: Candidate[]): Candidate[] {
  if (rule.trigger === "month_of_work") {
    return input.monthsWithWork.map((month) => ({
      group: month,
      dueOn: addMonths(`${month}-01`, rule.offsetMonths).slice(0, 8) + String(rule.dayOfMonth).padStart(2, "0"),
      basis: `${ordinal(rule.dayOfMonth)} day of the ${ordinal(rule.offsetMonths)} month after unpaid work in ${monthLabel(month)}`,
    }));
  }
  const { amount, before } = offsetText(rule.offset);
  const rel = before ? "before" : "after";
  const at = (group: string, day: string, event: string) => [{ group, dueOn: shift(day, rule.offset), basis: `${amount} ${rel} ${event}` }];
  switch (rule.trigger) {
    case "first_furnishing":
      return input.firstFurnishedOn ? at("", input.firstFurnishedOn, "first furnishing labor or materials") : [];
    case "last_furnishing":
      return input.lastFurnishedOn ? at("", input.lastFurnishedOn, "last furnishing labor or materials") : [];
    case "completion":
      if (input.completionOn) return at("", input.completionOn, "completion");
      return input.lastFurnishedOn ? at("", input.lastFurnishedOn, "completion (estimated as your last furnishing date)") : [];
    case "lien_deadline":
      return liens.flatMap((l) => at(l.group, l.dueOn, "the lien filing deadline"));
    case "lien_recorded":
      return liens.flatMap((l) => at(l.group, l.dueOn, "recording the lien, assuming it is recorded on the last day to file"));
  }
}

function earliestPerGroup(all: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of all) {
    const current = best.get(c.group);
    if (!current || c.dueOn < current.dueOn) best.set(c.group, c);
  }
  return [...best.values()];
}

const NEEDS: Record<Rule["trigger"], string> = {
  first_furnishing: "a first furnishing date",
  last_furnishing: "a last furnishing date",
  completion: "a last furnishing date",
  month_of_work: "a submitted, unpaid pay application",
  lien_deadline: "a lien filing deadline",
  lien_recorded: "a lien filing deadline",
};

export function computeDeadlines(rules: StateDeadlineRules | undefined, input: DeadlineInput): DeadlineReport {
  if (!input.state) return { deadlines: [], notes: ["Set the project state to estimate lien deadlines."], citation: null };
  if (!rules) return { deadlines: [], notes: [`No rules on file for ${input.state}; check your state's statute.`], citation: null };
  const notes: string[] = [];
  const found: Record<DeadlineKind, Candidate[]> = { prelim_notice: [], lien_filing: [], enforcement: [] };
  for (const kind of ["lien_filing", "prelim_notice", "enforcement"] as const) {
    const applicable = rules[kind].filter((r) => kind !== "prelim_notice" || r.required);
    if (applicable.length === 0) {
      if (kind === "prelim_notice") notes.push(`No preliminary notice is required of a first-tier subcontractor on a private job in ${input.state}.`);
      continue;
    }
    found[kind] = earliestPerGroup(applicable.flatMap((r) => candidates(r, input, found.lien_filing)));
    if (found[kind].length === 0) {
      const needs = [...new Set(applicable.map((r) => NEEDS[r.trigger]))].join(" or ");
      notes.push(`${DEADLINE_LABEL[kind]}: add ${needs} to estimate this deadline.`);
    }
  }
  const deadlines = KINDS.flatMap((kind) => found[kind].map((c) => ({ kind, dueOn: c.dueOn, basis: c.basis, confidence: rules.confidence })));
  return { deadlines: deadlines.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)), notes, citation: rules.citation };
}

/** Months of submitted-but-unpaid pay application periods: the work Texas-style month-of-work notices protect. */
export function unpaidMonths(ledger: Ledger): string[] {
  const months = ledger.payApps.filter((a) => a.status === "submitted").flatMap((a) => monthsTouched(a.period_from, a.period_to));
  return [...new Set(months)].sort();
}

export function projectDeadlines(ledger: Ledger): DeadlineReport {
  const p = ledger.project;
  return computeDeadlines(DEADLINE_RULES[p.state], {
    state: p.state,
    firstFurnishedOn: p.first_furnished_on,
    lastFurnishedOn: p.last_furnished_on,
    monthsWithWork: unpaidMonths(ledger),
  });
}

export interface UpcomingDeadline extends Deadline {
  projectId: string;
  projectName: string;
  overdue: boolean;
}

/** Active projects' deadlines from 30 days overdue through the next 60 days, soonest first. */
export function upcomingDeadlines(ledgers: Ledger[], today: string): UpcomingDeadline[] {
  const from = addDays(today, -30);
  const to = addDays(today, 60);
  return ledgers
    .filter((l) => l.project.status === "active")
    .flatMap((l) =>
      projectDeadlines(l)
        .deadlines.filter((d) => d.dueOn >= from && d.dueOn <= to)
        .map((d) => ({ ...d, projectId: l.project.id, projectName: l.project.name, overdue: d.dueOn < today })),
    )
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}
