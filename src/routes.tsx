import { Hono, type Context } from "hono";
import type { AppEnv, PublicEnv } from "./auth";
import { randomId, sha256Hex } from "./crypto";
import { toCsv } from "./csv";
import { dashboard, payAppView, summarizeProject, utcDay, type PayAppView } from "./ledger";
import { centsToDecimal, parseMoney, parsePercentBp } from "./money";
import { validate } from "./payapp";
import { payAppPdf } from "./pdf";
import * as data from "./projectsDb";
import { seedSampleProject } from "./sample";
import { parseSovPaste } from "./sovPaste";
import { noticeFrom, render } from "./views/layout";
import { DashboardPage, PayAppPage, ProjectFormPage, ProjectPage, ProjectsPage, SharedPayAppPage, US_STATES, issueText, projectFormValues } from "./views/projects";
import { notFound } from "./views/public";

type Form = Record<string, string | File>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function field(form: Form, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v.trim() : "";
}

function isDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

function parseProjectForm(form: Form): { values: Record<string, string>; project?: data.ProjectInput; error?: string } {
  const keys = ["name", "number", "gc_name", "gc_contact_email", "owner_name", "location", "state", "original_contract", "retainage_work", "retainage_stored", "first_furnished_on", "last_furnished_on", "status"];
  const values = Object.fromEntries(keys.map((k) => [k, field(form, k)]));
  values.state = values.state!.toUpperCase();
  const contract = parseMoney(values.original_contract!);
  const work = parsePercentBp(values.retainage_work!);
  const stored = parsePercentBp(values.retainage_stored!);
  const pctOk = (bp: number | null): bp is number => bp !== null && bp >= 0 && bp <= 10000;
  const error = !values.name || values.name.length > 120
    ? "Enter a job name (up to 120 characters)."
    : contract === null || contract < 0
      ? "Enter the original contract sum as a dollar amount."
      : !pctOk(work) || !pctOk(stored)
        ? "Retainage must be a percentage between 0 and 100."
        : values.state && !(US_STATES as readonly string[]).includes(values.state)
          ? "Choose a US state."
          : values.gc_contact_email && !EMAIL_RE.test(values.gc_contact_email)
            ? "Enter a valid GC billing email or leave it blank."
            : [values.first_furnished_on, values.last_furnished_on].some((d) => d && !isDate(d))
              ? "Furnishing dates must be valid dates."
              : undefined;
  if (error) return { values, error };
  return {
    values,
    project: {
      name: values.name!,
      number: values.number!,
      gc_name: values.gc_name!,
      gc_contact_email: values.gc_contact_email!,
      owner_name: values.owner_name!,
      location: values.location!,
      state: values.state!,
      original_contract_cents: contract!,
      retainage_work_bp: work!,
      retainage_stored_bp: stored!,
      first_furnished_on: values.first_furnished_on || null,
      last_furnished_on: values.last_furnished_on || null,
      status: values.status === "closed" ? "closed" : "active",
    },
  };
}

function shareUrlFor(c: Context, token: string): string {
  return `${new URL(c.req.url).origin}/s/${token}`;
}

function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^\w.-]+/g, "-")}"`;
}

function continuationCsv(v: PayAppView): string {
  const header = ["Item", "Description", "Scheduled value", "From previous application", "This period", "Materials presently stored", "Completed and stored to date", "Percent", "Balance to finish", "Retainage"];
  const t = v.result.totals;
  const row = (itemNo: string, description: string, r: typeof t) => [
    itemNo,
    description,
    centsToDecimal(r.c),
    centsToDecimal(r.d),
    centsToDecimal(r.e),
    centsToDecimal(r.f),
    centsToDecimal(r.g),
    (r.pctBp / 100).toFixed(2),
    centsToDecimal(r.h),
    centsToDecimal(r.i),
  ];
  return toCsv([header, ...v.result.rows.map((r) => row(r.itemNo, r.description, r)), row("", "Grand total", t)]);
}

function pdfName(v: PayAppView): string {
  return `${v.project.name}-pay-app-${v.payApp.number}`;
}

export const drawbook = new Hono<AppEnv>();

drawbook.get("/", async (c) => {
  const summaries = (await data.loadOrgLedgers(c.var.tenant, c.env.DB)).map(summarizeProject);
  return render(c, <DashboardPage org={c.var.org} user={c.var.user} notice={noticeFrom(c.req.query("notice"))} summaries={summaries} dash={dashboard(summaries, Date.now())} />);
});

drawbook.post("/sample", async (c) => {
  const id = await seedSampleProject(c.var.tenant, c.env.DB, Date.now());
  return c.redirect(`/app/projects/${id}?notice=sample_loaded`);
});

drawbook.get("/projects", async (c) => {
  const summaries = (await data.loadOrgLedgers(c.var.tenant, c.env.DB)).map(summarizeProject);
  return render(c, <ProjectsPage org={c.var.org} user={c.var.user} notice={noticeFrom(c.req.query("notice"))} summaries={summaries} />);
});

drawbook.get("/projects/new", (c) => render(c, <ProjectFormPage org={c.var.org} user={c.var.user} values={{}} />));

drawbook.post("/projects", async (c) => {
  const parsed = parseProjectForm(await c.req.parseBody());
  if (!parsed.project) return render(c, <ProjectFormPage org={c.var.org} user={c.var.user} values={parsed.values} error={parsed.error} />, 422);
  const id = randomId();
  await data.createProject(c.var.tenant, c.env.DB, id, parsed.project, Date.now());
  return c.redirect(`/app/projects/${id}?notice=project_created`);
});

async function renderProject(c: Context<AppEnv>, projectId: string, extra: { error?: string; paste?: string } = {}, status: 200 | 409 | 422 = 200) {
  const ledger = await data.loadProjectLedger(c.var.tenant, c.env.DB, projectId);
  if (!ledger) return notFound(c);
  return render(
    c,
    <ProjectPage org={c.var.org} user={c.var.user} notice={noticeFrom(c.req.query("notice"))} ledger={ledger} summary={summarizeProject(ledger)} today={utcDay(Date.now())} {...extra} />,
    status,
  );
}

drawbook.get("/projects/:id", (c) => renderProject(c, c.req.param("id")));

drawbook.get("/projects/:id/edit", async (c) => {
  const ledger = await data.loadProjectLedger(c.var.tenant, c.env.DB, c.req.param("id"));
  if (!ledger) return notFound(c);
  return render(c, <ProjectFormPage org={c.var.org} user={c.var.user} projectId={ledger.project.id} values={projectFormValues(ledger.project)} />);
});

drawbook.post("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = parseProjectForm(await c.req.parseBody());
  if (!parsed.project) {
    if (!(await data.loadProjectLedger(c.var.tenant, c.env.DB, id))) return notFound(c);
    return render(c, <ProjectFormPage org={c.var.org} user={c.var.user} projectId={id} values={parsed.values} error={parsed.error} />, 422);
  }
  if (!(await data.updateProject(c.var.tenant, c.env.DB, id, parsed.project, Date.now()))) return notFound(c);
  return c.redirect(`/app/projects/${id}?notice=saved`);
});

drawbook.post("/projects/:id/sov", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const scheduled = parseMoney(field(form, "scheduled"));
  const description = field(form, "description");
  if (!description || scheduled === null) return renderProject(c, id, { error: "Enter a description and a scheduled value." }, 422);
  const added = await data.addSovLines(c.var.tenant, c.env.DB, id, [{ id: randomId(), itemNo: field(form, "item_no"), description, scheduledCents: scheduled }], Date.now());
  return added === 0 ? notFound(c) : c.redirect(`/app/projects/${id}?notice=lines_added`);
});

drawbook.post("/projects/:id/sov/paste", async (c) => {
  const id = c.req.param("id");
  const ledger = await data.loadProjectLedger(c.var.tenant, c.env.DB, id);
  if (!ledger) return notFound(c);
  const text = field(await c.req.parseBody(), "paste");
  const { lines, errors } = parseSovPaste(text, ledger.sov.length + 1);
  if (lines.length === 0 || errors.length > 0) {
    const error =
      errors.length > 0
        ? `Nothing was added. These rows need an item, a description, and an amount: ${errors.map((e) => `row ${e.row}`).join(", ")}.`
        : "Nothing to add. Paste rows with an item, a description, and an amount.";
    return renderProject(c, id, { error, paste: text }, 422);
  }
  await data.addSovLines(c.var.tenant, c.env.DB, id, lines.map((l) => ({ id: randomId(), ...l })), Date.now());
  return c.redirect(`/app/projects/${id}?notice=lines_added`);
});

drawbook.post("/sov/:lineId", async (c) => {
  const lineId = c.req.param("lineId");
  const projectId = await data.sovLineProject(c.var.tenant, c.env.DB, lineId);
  if (!projectId) return notFound(c);
  const form = await c.req.parseBody();
  const scheduled = parseMoney(field(form, "scheduled"));
  const description = field(form, "description");
  if (!description || scheduled === null) return renderProject(c, projectId, { error: "Enter a description and a scheduled value." }, 422);
  const result = await data.updateSovLine(c.var.tenant, c.env.DB, lineId, { itemNo: field(form, "item_no"), description, scheduledCents: scheduled }, Date.now());
  if (result === "locked") return renderProject(c, projectId, { error: "That line is on a submitted pay application and can no longer change." }, 409);
  return c.redirect(`/app/projects/${projectId}?notice=lines_added`);
});

drawbook.post("/sov/:lineId/delete", async (c) => {
  const lineId = c.req.param("lineId");
  const projectId = await data.sovLineProject(c.var.tenant, c.env.DB, lineId);
  if (!projectId) return notFound(c);
  const result = await data.deleteSovLine(c.var.tenant, c.env.DB, lineId);
  if (result === "locked") return renderProject(c, projectId, { error: "That line is on a submitted pay application and cannot be deleted." }, 409);
  return c.redirect(`/app/projects/${projectId}?notice=line_deleted`);
});

drawbook.post("/sov/:lineId/move", async (c) => {
  const direction = field(await c.req.parseBody(), "direction") === "up" ? "up" : "down";
  const projectId = await data.moveSovLine(c.var.tenant, c.env.DB, c.req.param("lineId"), direction);
  return projectId ? c.redirect(`/app/projects/${projectId}`) : notFound(c);
});

drawbook.post("/projects/:id/change-orders", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const amount = parseMoney(field(form, "amount"));
  const title = field(form, "title");
  if (!title || amount === null) return renderProject(c, id, { error: "Enter a change order title and amount." }, 422);
  const created = await data.createChangeOrder(c.var.tenant, c.env.DB, id, { id: randomId(), title, amountCents: amount }, Date.now());
  return created ? c.redirect(`/app/projects/${id}?notice=co_added`) : notFound(c);
});

for (const [action, decision] of [["approve", "approved"], ["reject", "rejected"]] as const) {
  drawbook.post(`/change-orders/:id/${action}`, async (c) => {
    const projectId = await data.decideChangeOrder(c.var.tenant, c.env.DB, c.req.param("id"), decision, randomId(), Date.now());
    return projectId ? c.redirect(`/app/projects/${projectId}?notice=co_${decision}`) : notFound(c);
  });
}

drawbook.post("/projects/:id/pay-apps", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const periodFrom = field(form, "period_from");
  const periodTo = field(form, "period_to");
  if (!isDate(periodFrom) || !isDate(periodTo) || periodFrom > periodTo) return renderProject(c, id, { error: "Enter a billing period with the start on or before the end." }, 422);
  const payAppId = randomId();
  const result = await data.createPayApp(c.var.tenant, c.env.DB, id, { id: payAppId, periodFrom, periodTo }, Date.now());
  if (result === "not_found") return notFound(c);
  if (result === "draft_exists") return renderProject(c, id, { error: "Finish or submit the current draft before starting the next pay application." }, 409);
  return c.redirect(`/app/pay-apps/${payAppId}`);
});

async function loadView(c: Context<AppEnv>, payAppId: string): Promise<PayAppView | null> {
  const found = await data.loadPayAppLedger(c.var.tenant, c.env.DB, payAppId);
  return found && payAppView(found.ledger, found.payApp);
}

async function renderPayApp(c: Context<AppEnv>, payAppId: string, extra: { error?: string; shareUrl?: string; notice?: string } = {}, status: 200 | 409 | 422 = 200) {
  const view = await loadView(c, payAppId);
  if (!view) return notFound(c);
  return render(c, <PayAppPage org={c.var.org} user={c.var.user} notice={noticeFrom(c.req.query("notice"))} view={view} today={utcDay(Date.now())} {...extra} />, status);
}

drawbook.get("/pay-apps/:id", (c) => renderPayApp(c, c.req.param("id")));

drawbook.post("/pay-apps/:id", async (c) => {
  const id = c.req.param("id");
  const view = await loadView(c, id);
  if (!view) return notFound(c);
  if (view.payApp.status !== "draft") return renderPayApp(c, id, { error: "This application is already submitted. Reopen it to make changes." }, 409);
  const form = await c.req.parseBody();
  const periodFrom = field(form, "period_from");
  const periodTo = field(form, "period_to");
  const work = parsePercentBp(field(form, "retainage_work"));
  const stored = parsePercentBp(field(form, "retainage_stored"));
  const problems: string[] = [];
  if (!isDate(periodFrom) || !isDate(periodTo) || periodFrom > periodTo) problems.push("The billing period needs a start on or before the end.");
  if (work === null || stored === null || work < 0 || stored < 0 || work > 10000 || stored > 10000) problems.push("Retainage must be a percentage between 0 and 100.");
  const lines = view.result.rows.map((r) => {
    const f = parseMoney(field(form, `f_${r.sovLineId}`) || "0");
    const pctField = field(form, `pct_${r.sovLineId}`);
    const pct = pctField !== field(form, `pct0_${r.sovLineId}`) ? parsePercentBp(pctField) : null;
    const e = pct !== null && f !== null ? Math.round((pct * r.c) / 10000) - r.d - f : parseMoney(field(form, `e_${r.sovLineId}`) || "0");
    if (e === null || f === null) problems.push(`Item ${r.itemNo} has an amount that is not a number.`);
    return { sovLineId: r.sovLineId, workThisPeriodCents: e ?? r.e, storedToDateCents: f ?? r.f };
  });
  if (problems.length > 0) return renderPayApp(c, id, { error: problems.join(" ") }, 422);
  const t = c.var.tenant;
  const now = Date.now();
  await data.saveDraft(t, c.env.DB, id, { periodFrom, periodTo, retainageWorkBp: work!, retainageStoredBp: stored!, lines }, now);
  if (field(form, "intent") !== "submit") return c.redirect(`/app/pay-apps/${id}?notice=draft_saved`);

  const saved = (await loadView(c, id))!;
  const issues = validate(saved.input);
  if (issues.length > 0) return renderPayApp(c, id, { error: `Not submitted. ${issues.map(issueText).join(" ")}` }, 422);
  const token = randomId(32);
  if (!(await data.submitPayApp(t, c.env.DB, id, await sha256Hex(token), now))) return renderPayApp(c, id, { error: "This application changed while you were editing. Review it and try again." }, 409);
  return renderPayApp(c, id, { notice: "Submitted. The application is locked and ready to send.", shareUrl: shareUrlFor(c, token) });
});

drawbook.post("/pay-apps/:id/paid", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const amount = parseMoney(field(form, "amount"));
  const paidOn = field(form, "paid_on");
  const view = await loadView(c, id);
  if (!view) return notFound(c);
  if (amount === null || amount < 0 || !isDate(paidOn)) return renderPayApp(c, id, { error: "Enter the amount received and the date it arrived." }, 422);
  if (view.payApp.submitted_at !== null && paidOn < utcDay(view.payApp.submitted_at)) return renderPayApp(c, id, { error: "The payment date cannot be before the application was submitted." }, 422);
  if (!(await data.markPayAppPaid(c.var.tenant, c.env.DB, id, { paidCents: amount, paidAt: Date.parse(paidOn) }, Date.now()))) {
    return renderPayApp(c, id, { error: "Only a submitted, unpaid application can be marked paid." }, 409);
  }
  return c.redirect(`/app/pay-apps/${id}?notice=marked_paid`);
});

drawbook.post("/pay-apps/:id/reopen", async (c) => {
  const id = c.req.param("id");
  if (!(await loadView(c, id))) return notFound(c);
  if (!(await data.reopenPayApp(c.var.tenant, c.env.DB, id, Date.now()))) {
    return renderPayApp(c, id, { error: "Only the latest submitted, unpaid application can be reopened. Later applications build on this one." }, 409);
  }
  return c.redirect(`/app/pay-apps/${id}?notice=reopened`);
});

drawbook.post("/pay-apps/:id/delete", async (c) => {
  const projectId = await data.deleteDraft(c.var.tenant, c.env.DB, c.req.param("id"));
  return projectId ? c.redirect(`/app/projects/${projectId}?notice=draft_deleted`) : notFound(c);
});

drawbook.post("/pay-apps/:id/share", async (c) => {
  const id = c.req.param("id");
  const token = randomId(32);
  if (!(await data.setShareToken(c.var.tenant, c.env.DB, id, await sha256Hex(token)))) return notFound(c);
  return renderPayApp(c, id, { notice: "New share link created. The previous link no longer works.", shareUrl: shareUrlFor(c, token) });
});

drawbook.post("/pay-apps/:id/share/revoke", async (c) => {
  const id = c.req.param("id");
  if (!(await data.setShareToken(c.var.tenant, c.env.DB, id, null))) return notFound(c);
  return c.redirect(`/app/pay-apps/${id}?notice=share_revoked`);
});

drawbook.get("/pay-apps/:id/pdf", async (c) => {
  const view = await loadView(c, c.req.param("id"));
  if (!view) return notFound(c);
  return c.body(await payAppPdf(c.var.org.name, view), 200, { "Content-Type": "application/pdf", "Content-Disposition": attachment(`${pdfName(view)}.pdf`) });
});

drawbook.get("/pay-apps/:id/csv", async (c) => {
  const view = await loadView(c, c.req.param("id"));
  if (!view) return notFound(c);
  return c.body(continuationCsv(view), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": attachment(`${pdfName(view)}-continuation.csv`) });
});

drawbook.get("/export.json", async (c) => {
  const t = c.var.tenant;
  const tables = Object.keys(data.EXPORT_TABLES) as data.ExportTable[];
  const rows = await Promise.all(tables.map((table) => data.exportTable(t, c.env.DB, table)));
  const body = { exported_at: new Date().toISOString(), organization: c.var.org.name, money: "integer cents", percentages: "basis points (1000 = 10%)", ...Object.fromEntries(tables.map((table, i) => [table, rows[i]])) };
  return c.body(JSON.stringify(body, null, 2), 200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": attachment(`drawbook-export-${utcDay(Date.now())}.json`) });
});

drawbook.get("/export/:table{[a-z_]+\\.csv}", async (c) => {
  const table = c.req.param("table").replace(/\.csv$/, "");
  if (!(table in data.EXPORT_TABLES)) return notFound(c);
  const rows = await data.exportTable(c.var.tenant, c.env.DB, table as data.ExportTable);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const csv = toCsv([columns, ...rows.map((r) => columns.map((k) => r[k] as string | number | null))]);
  return c.body(csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": attachment(`drawbook-${table}.csv`) });
});

export const shared = new Hono<PublicEnv>();

shared.use(async (c, next) => {
  await next();
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "private, no-store");
});

async function loadShared(c: Context<PublicEnv>) {
  const found = await data.loadSharedPayApp(c.env.DB, await sha256Hex(c.req.param("token") ?? ""));
  return found && { orgName: found.orgName, view: payAppView(found.ledger, found.payApp) };
}

shared.get("/:token", async (c) => {
  const found = await loadShared(c);
  if (!found) return notFound(c);
  return render(c, <SharedPayAppPage orgName={found.orgName} view={found.view} token={c.req.param("token")} />);
});

shared.get("/:token/pdf", async (c) => {
  const found = await loadShared(c);
  if (!found) return notFound(c);
  return c.body(await payAppPdf(found.orgName, found.view), 200, { "Content-Type": "application/pdf", "Content-Disposition": attachment(`${pdfName(found.view)}.pdf`) });
});
