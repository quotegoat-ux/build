import * as db from "./db";
import { DEADLINE_LABEL, addDays, projectDeadlines } from "./deadlines";
import { escapeHtml, sendEmail } from "./email";
import { APP_NAME, type Env } from "./env";
import { daysBetween, summarizeProject, utcDay } from "./ledger";
import { formatMoney } from "./money";
import * as data from "./projectsDb";

const UNPAID_AFTER_DAYS = 30;
const DEADLINE_HORIZON_DAYS = 7;

export const DEADLINE_DISCLAIMER = "Deadline dates are estimates from the project's state and furnishing dates, not legal advice. Confirm every deadline with your counsel.";

interface Reminder {
  subjectKey: string;
  dueOn: string;
  line: string;
}

export function orgReminders(ledgers: data.Ledger[], now: number): Reminder[] {
  const today = utcDay(now);
  const horizon = addDays(today, DEADLINE_HORIZON_DAYS);
  const active = ledgers.filter((l) => l.project.status === "active");
  const deadlines = active.flatMap((l) =>
    projectDeadlines(l)
      .deadlines.filter((d) => d.dueOn >= today && d.dueOn <= horizon)
      .map((d) => ({
        subjectKey: `deadline:${l.project.id}:${d.kind}`,
        dueOn: d.dueOn,
        line: `${l.project.name}: ${DEADLINE_LABEL[d.kind]} due ${d.dueOn} (${d.basis}; ${d.confidence} confidence)`,
      })),
  );
  const unpaid = active.flatMap((l) =>
    summarizeProject(l)
      .views.filter((v) => v.payApp.status === "submitted" && daysBetween(v.payApp.submitted_at!, now) > UNPAID_AFTER_DAYS)
      .map((v) => ({
        subjectKey: `unpaid:${v.payApp.id}`,
        dueOn: addDays(utcDay(v.payApp.submitted_at!), UNPAID_AFTER_DAYS),
        line: `${l.project.name}: App #${v.payApp.number} for ${formatMoney(v.result.g702.currentPaymentDue)} unpaid ${daysBetween(v.payApp.submitted_at!, now)} days after submission`,
      })),
  );
  return [...deadlines, ...unpaid];
}

function reminderEmail(lines: string[], url: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1917">
<h1 style="font-size:20px">Lien deadlines and late payments</h1>
<ul style="font-size:15px;line-height:1.5;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#ea580c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open ${APP_NAME}</a></p>
<p style="font-size:13px;color:#57534e">${escapeHtml(DEADLINE_DISCLAIMER)}</p>
</div>`;
}

/** Daily: emails each org's owners and admins about deadlines due within a week and pay apps unpaid past 30 days, once per item. */
export async function sendReminders(env: Env, now: number): Promise<{ orgId: string; items: number }[]> {
  const report: { orgId: string; items: number }[] = [];
  for (const org of await data.reminderOrgs(env.DB, now)) {
    const reminders = orgReminders(await data.loadLedgersForOrg(env.DB, org.id), now);
    const claimed = await data.claimReminders(env.DB, org.id, reminders, now);
    if (claimed.length === 0) continue;
    const lines = reminders.filter((r) => claimed.some((c) => c.subjectKey === r.subjectKey && c.dueOn === r.dueOn)).map((r) => r.line);
    let delivered = 0;
    try {
      for (const to of await db.orgAdminEmails(env.DB, org.id)) {
        await sendEmail(env, { to, subject: `${APP_NAME}: ${lines.length} lien ${lines.length === 1 ? "reminder" : "reminders"} for ${org.name}`, html: reminderEmail(lines, `${env.APP_URL}/app`) });
        delivered++;
      }
    } catch (e) {
      console.error(`reminders for org ${org.id} failed after ${delivered} emails`, e);
      if (delivered === 0) await data.releaseReminders(env.DB, org.id, claimed);
      continue;
    }
    report.push({ orgId: org.id, items: lines.length });
  }
  return report;
}
