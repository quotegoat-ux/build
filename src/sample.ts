import { randomId, sha256Hex } from "./crypto";
import type { Tenant } from "./db";
import { payAppView } from "./ledger";
import * as data from "./projectsDb";

const DAY_MS = 86_400_000;

const SOV: [string, string, number][] = [
  ["1", "Mobilization and general conditions", 2_400_000],
  ["2", "Underground conduit and grounding", 3_850_000],
  ["3", "Switchgear and distribution", 9_600_000],
  ["4", "Branch wiring, level 1", 7_200_000],
  ["5", "Branch wiring, level 2", 6_800_000],
  ["6", "Lighting fixtures and controls", 8_400_000],
  ["7", "Fire alarm system", 5_200_000],
  ["8", "Low voltage and data rough-in", 3_100_000],
  ["9", "Testing, commissioning and closeout", 2_100_000],
];

type Progress = Record<string, [work: number, stored?: number]>;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A mid-job electrical subcontract: one paid application, one awaiting payment, and the current month in draft. */
export async function seedSampleProject(t: Tenant, db: D1Database, now: number): Promise<string> {
  const projectId = randomId();
  const start = now - 100 * DAY_MS;
  await data.createProject(
    t,
    db,
    projectId,
    {
      name: "Riverside Medical Office (sample)",
      number: "2417",
      gc_name: "Harbor Point Builders",
      gc_contact_email: "billing@harborpoint.example",
      owner_name: "Riverside Health Partners LLC",
      location: "1200 River Rd, Sacramento",
      state: "CA",
      original_contract_cents: 48_650_000,
      retainage_work_bp: 500,
      retainage_stored_bp: 500,
      first_furnished_on: day(start),
      last_furnished_on: null,
      status: "active",
    },
    start,
  );
  const lineIds = SOV.map(() => randomId());
  await data.addSovLines(t, db, projectId, SOV.map(([itemNo, description, scheduledCents], i) => ({ id: lineIds[i]!, itemNo, description, scheduledCents })), start);

  const ev = randomId();
  const relocate = randomId();
  await data.createChangeOrder(t, db, projectId, { id: ev, title: "Add EV charging circuits (4)", amountCents: 1_840_000 }, start + DAY_MS);
  await data.createChangeOrder(t, db, projectId, { id: relocate, title: "Relocate panel LP-2B", amountCents: 625_000 }, now - 5 * DAY_MS);

  const enter = async (payAppId: string, progress: Progress, at: number) => {
    const ledger = (await data.loadProjectLedger(t, db, projectId))!;
    const app = ledger.payApps.find((a) => a.id === payAppId)!;
    const carried = new Map(ledger.lines.filter((l) => l.pay_app_id === payAppId).map((l) => [l.sov_line_id, l.stored_to_date_cents]));
    await data.saveDraft(
      t,
      db,
      payAppId,
      {
        periodFrom: app.period_from,
        periodTo: app.period_to,
        retainageWorkBp: app.retainage_work_bp,
        retainageStoredBp: app.retainage_stored_bp,
        isFinal: false,
        lines: ledger.sov.map((l) => {
          const [work, stored] = progress[l.item_no] ?? [0];
          return { sovLineId: l.id, workThisPeriodCents: work, storedToDateCents: stored ?? carried.get(l.id) ?? 0 };
        }),
      },
      at,
    );
  };
  const currentDue = async (payAppId: string) => {
    const ledger = (await data.loadProjectLedger(t, db, projectId))!;
    return payAppView(ledger, ledger.payApps.find((a) => a.id === payAppId)!).result.g702.currentPaymentDue;
  };
  const period = async (n: number, progress: Progress, submittedAt: number | null) => {
    const id = randomId();
    const to = submittedAt ?? now;
    await data.createPayApp(t, db, projectId, { id, periodFrom: day(to - 30 * DAY_MS), periodTo: day(to - DAY_MS) }, to - n);
    await enter(id, progress, to);
    if (submittedAt !== null) await data.submitPayApp(t, db, id, await sha256Hex(randomId(32)), { id: randomId(), amountCents: await currentDue(id) }, submittedAt);
    return id;
  };

  const first = await period(1, { "1": [1_200_000], "2": [3_850_000], "3": [2_000_000, 4_500_000] }, now - 72 * DAY_MS);
  await data.markPayAppPaid(t, db, first, { paidCents: await currentDue(first), paidAt: Date.parse(day(now - 38 * DAY_MS)), waiverId: randomId() }, now - 38 * DAY_MS);

  await data.decideChangeOrder(t, db, ev, "approved", randomId(), now - 50 * DAY_MS);
  await period(2, { "1": [400_000], "3": [6_100_000, 0], "4": [3_600_000], "5": [1_020_000], "6": [0, 2_200_000], "CO-1": [920_000] }, now - 34 * DAY_MS);
  await period(3, { "4": [2_400_000], "5": [3_000_000], "6": [1_500_000], "7": [800_000] }, null);
  return projectId;
}
