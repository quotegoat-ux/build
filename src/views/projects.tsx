import type { Child } from "hono/jsx";
import type { Org, User } from "../db";
import { daysBetween, type Dashboard, type PayAppView, type ProjectSummary } from "../ledger";
import { centsToDecimal, formatBp, formatMoney } from "../money";
import type { G702, G703Row, Issue } from "../payapp";
import type { Ledger, PayAppStatus, Project } from "../projectsDb";
import { PAY_APP_SCRIPT } from "./payappScript";
import { AppShell, Document, ErrorText, Field, Mark } from "./layout";

type ShellProps = { org: Org; user: User; notice?: string };

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

const STATUS: Record<PayAppStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "pill-draft" },
  submitted: { label: "Awaiting payment", cls: "pill-submitted" },
  paid: { label: "Paid", cls: "pill-paid" },
};

type IssueText = { [K in Issue["kind"]]: (i: Extract<Issue, { kind: K }>) => string };

const ISSUE_TEXT: IssueText = {
  over_complete: (i) => `Item ${i.itemNo} is billed past 100%: ${formatMoney(i.completedCents)} against ${formatMoney(i.scheduledCents)} scheduled.`,
  below_zero: (i) => `Item ${i.itemNo} would take work completed below zero (${formatMoney(i.workToDateCents)}).`,
  negative_stored: (i) => `Item ${i.itemNo} has negative stored materials (${formatMoney(i.storedCents)}).`,
  stored_without_value: (i) => `Item ${i.itemNo} has stored materials but no scheduled value.`,
  unapproved_change_order: (i) => `Item ${i.itemNo} bills a change order that is ${i.status === "missing" ? "missing" : i.status}. Only approved change orders can be billed.`,
  over_contract: (i) => `Total completed and stored (${formatMoney(i.completedCents)}) is more than the contract sum to date (${formatMoney(i.contractSumCents)}).`,
  sov_mismatch: (i) => `The schedule of values totals ${formatMoney(i.sovTotalCents)} but the contract sum to date is ${formatMoney(i.contractSumCents)}. GCs reject applications that do not tie.`,
};

export function issueText(issue: Issue): string {
  return (ISSUE_TEXT[issue.kind] as (i: Issue) => string)(issue);
}

function StatusPill({ status }: { status: PayAppStatus }) {
  return <span class={`pill ${STATUS[status].cls}`}>{STATUS[status].label}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: Child }) {
  return (
    <div class="card stat-card">
      <p class="stat-label">{label}</p>
      <p class="stat">{value}</p>
      {hint && <p class="muted small">{hint}</p>}
    </div>
  );
}

function EmptyState() {
  return (
    <section class="card empty">
      <h2>Bill your first pay application in minutes</h2>
      <p class="muted">
        Add a job and its schedule of values, then enter this month's progress. Drawbook carries prior totals forward, does the retainage math, and checks
        the numbers before your GC does.
      </p>
      <div class="hero-actions">
        <a href="/app/projects/new" class="btn btn-large">
          Create a project
        </a>
        <form method="post" action="/app/sample">
          <button type="submit" class="btn btn-large btn-ghost">
            Load sample project
          </button>
        </form>
      </div>
      <p class="muted small">The sample is a mid-job electrical subcontract with one paid, one outstanding, and one draft pay application.</p>
    </section>
  );
}

export function DashboardPage({ org, user, notice, summaries, dash }: ShellProps & { summaries: ProjectSummary[]; dash: Dashboard }) {
  return (
    <AppShell title="Dashboard" active="dashboard" org={org} user={user} notice={notice}>
      <h1>Cash at a glance</h1>
      {summaries.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div class="stats">
            <Stat label="Outstanding" value={formatMoney(dash.outstandingCents)} hint={`${dash.awaiting.length} submitted, unpaid`} />
            <Stat label="Retainage held" value={formatMoney(dash.retainageHeldCents)} hint="Across active projects" />
            <Stat label="Average days to pay" value={dash.averageDaysToPay === null ? "-" : String(dash.averageDaysToPay)} hint="Submitted to paid" />
          </div>
          <h2>Awaiting payment</h2>
          {dash.awaiting.length === 0 ? (
            <p class="muted">Nothing outstanding. Every submitted application has been paid.</p>
          ) : (
            <ul class="list">
              {dash.awaiting.map(({ view, daysOutstanding }) => (
                <li>
                  <a class="list-row row-link" href={`/app/pay-apps/${view.payApp.id}`}>
                    <div>
                      <strong>{view.project.name}</strong>
                      <div class="muted">
                        App #{view.payApp.number} · {view.project.gc_name || "No GC"}
                      </div>
                    </div>
                    <div class="row-figures">
                      <strong>{formatMoney(view.result.g702.currentPaymentDue)}</strong>
                      <span class={daysOutstanding > 45 ? "age age-late" : "age"}>{daysOutstanding} days</span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p>
            <a href="/app/projects" class="btn btn-ghost">
              All projects
            </a>
          </p>
        </>
      )}
    </AppShell>
  );
}

export function ProjectsPage({ org, user, notice, summaries }: ShellProps & { summaries: ProjectSummary[] }) {
  return (
    <AppShell title="Projects" active="projects" org={org} user={user} notice={notice}>
      <div class="page-head">
        <h1>Projects</h1>
        <a href="/app/projects/new" class="btn">
          New project
        </a>
      </div>
      {summaries.length === 0 ? (
        <EmptyState />
      ) : (
        <div class="project-grid">
          {summaries.map((s) => (
            <a href={`/app/projects/${s.project.id}`} class="card card-link project-card">
              <div class="project-card-head">
                <h3>{s.project.name}</h3>
                {s.project.status === "closed" && <span class="pill">Closed</span>}
              </div>
              <p class="muted">{[s.project.gc_name, s.project.location].filter(Boolean).join(" · ") || "No GC yet"}</p>
              <dl class="figures">
                <div>
                  <dt>Billed to date</dt>
                  <dd>{formatMoney(s.billedToDateCents)}</dd>
                </div>
                <div>
                  <dt>Outstanding</dt>
                  <dd>{formatMoney(s.outstandingCents)}</dd>
                </div>
                <div>
                  <dt>Retainage held</dt>
                  <dd>{formatMoney(s.retainageHeldCents)}</dd>
                </div>
              </dl>
            </a>
          ))}
        </div>
      )}
    </AppShell>
  );
}

export type ProjectFormValues = Record<string, string>;

export function projectFormValues(p: Project): ProjectFormValues {
  return {
    name: p.name,
    number: p.number,
    gc_name: p.gc_name,
    gc_contact_email: p.gc_contact_email,
    owner_name: p.owner_name,
    location: p.location,
    state: p.state,
    original_contract: centsToDecimal(p.original_contract_cents),
    retainage_work: formatBp(p.retainage_work_bp).replace("%", ""),
    retainage_stored: formatBp(p.retainage_stored_bp).replace("%", ""),
    first_furnished_on: p.first_furnished_on ?? "",
    last_furnished_on: p.last_furnished_on ?? "",
    status: p.status,
  };
}

export function ProjectFormPage({ org, user, projectId, values, error }: ShellProps & { projectId?: string; values: ProjectFormValues; error?: string }) {
  const v = (k: string) => values[k] ?? "";
  return (
    <AppShell title={projectId ? "Edit project" : "New project"} active="projects" org={org} user={user}>
      <h1>{projectId ? "Edit project" : "New project"}</h1>
      <ErrorText error={error} />
      <form method="post" action={projectId ? `/app/projects/${projectId}` : "/app/projects"} class="card stack">
        <Field label="Job name" name="name" value={v("name")} autocomplete="off" />
        <div class="two">
          <Field label="Job number" name="number" value={v("number")} required={false} autocomplete="off" />
          <Field label="Original contract sum" name="original_contract" value={v("original_contract")} hint="From your subcontract, e.g. 486,500" autocomplete="off" />
        </div>
        <div class="two">
          <Field label="General contractor" name="gc_name" value={v("gc_name")} required={false} autocomplete="off" />
          <Field label="GC billing email" name="gc_contact_email" type="email" value={v("gc_contact_email")} required={false} autocomplete="off" />
        </div>
        <Field label="Owner" name="owner_name" value={v("owner_name")} required={false} autocomplete="off" />
        <div class="two">
          <Field label="Job address" name="location" value={v("location")} required={false} autocomplete="off" />
          <label class="field">
            <span class="field-label">State</span>
            <select name="state">
              <option value="">Choose</option>
              {US_STATES.map((s) => (
                <option value={s} selected={v("state") === s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="two">
          <Field label="Retainage on work (%)" name="retainage_work" value={v("retainage_work") || "10"} hint="Held on columns D + E" />
          <Field label="Retainage on stored materials (%)" name="retainage_stored" value={v("retainage_stored") || "10"} hint="Held on column F" />
        </div>
        <div class="two">
          <Field label="First day furnishing labor or materials" name="first_furnished_on" type="date" value={v("first_furnished_on")} required={false} />
          <Field label="Last day furnishing" name="last_furnished_on" type="date" value={v("last_furnished_on")} required={false} />
        </div>
        {projectId && (
          <label class="field">
            <span class="field-label">Status</span>
            <select name="status">
              <option value="active" selected={v("status") !== "closed"}>
                Active
              </option>
              <option value="closed" selected={v("status") === "closed"}>
                Closed
              </option>
            </select>
          </label>
        )}
        <button type="submit" class="btn btn-block">
          {projectId ? "Save project" : "Create project"}
        </button>
      </form>
    </AppShell>
  );
}

function ContractSummary({ ledger }: { ledger: Ledger }) {
  const approved = ledger.changeOrders.filter((co) => co.status === "approved").reduce((s, co) => s + co.amount_cents, 0);
  const contractSum = ledger.project.original_contract_cents + approved;
  const sovTotal = ledger.sov.reduce((s, l) => s + l.scheduled_cents, 0);
  return (
    <>
      <dl class="figures figures-4">
        <div>
          <dt>Original contract</dt>
          <dd>{formatMoney(ledger.project.original_contract_cents)}</dd>
        </div>
        <div>
          <dt>Approved changes</dt>
          <dd>{formatMoney(approved)}</dd>
        </div>
        <div>
          <dt>Contract sum to date</dt>
          <dd>{formatMoney(contractSum)}</dd>
        </div>
        <div>
          <dt>Schedule of values</dt>
          <dd>{formatMoney(sovTotal)}</dd>
        </div>
      </dl>
      {ledger.sov.length > 0 && sovTotal !== contractSum && (
        <p class="warn">
          The schedule of values is {formatMoney(Math.abs(contractSum - sovTotal))} {sovTotal < contractSum ? "short of" : "over"} the contract sum to date.
          Pay applications cannot be submitted until they tie.
        </p>
      )}
    </>
  );
}

export function ProjectPage({
  org,
  user,
  notice,
  error,
  summary,
  ledger,
  paste,
  today,
}: ShellProps & { error?: string; summary: ProjectSummary; ledger: Ledger; paste?: string; today: string }) {
  const p = ledger.project;
  const draft = ledger.payApps.find((a) => a.status === "draft");
  const last = ledger.payApps.at(-1);
  const nextFrom = last ? new Date(Date.parse(last.period_to) + 86_400_000).toISOString().slice(0, 10) : today.slice(0, 8) + "01";
  const pending = ledger.changeOrders.filter((co) => co.status === "pending");
  return (
    <AppShell title={p.name} active="projects" org={org} user={user} notice={notice}>
      <p class="crumbs">
        <a href="/app/projects">Projects</a>
      </p>
      <div class="page-head">
        <div>
          <h1>{p.name}</h1>
          <p class="muted">
            {[p.number && `Job #${p.number}`, p.gc_name, [p.location, p.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
          </p>
        </div>
        <a href={`/app/projects/${p.id}/edit`} class="btn btn-ghost btn-small">
          Edit project
        </a>
      </div>
      <ErrorText error={error} />
      <ContractSummary ledger={ledger} />

      <section>
        <h2>Pay applications</h2>
        {summary.views.length > 0 && (
          <ul class="list">
            {[...summary.views].reverse().map((v) => (
              <li>
                <a class="list-row row-link" href={`/app/pay-apps/${v.payApp.id}`}>
                  <div>
                    <strong>App #{v.payApp.number}</strong>
                    <div class="muted">
                      {v.payApp.period_from} to {v.payApp.period_to}
                    </div>
                  </div>
                  <div class="row-figures">
                    <strong>{formatMoney(v.result.g702.currentPaymentDue)}</strong>
                    <StatusPill status={v.payApp.status} />
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
        {draft ? (
          <a href={`/app/pay-apps/${draft.id}`} class="btn btn-block">
            Continue draft app #{draft.number}
          </a>
        ) : ledger.sov.length === 0 ? (
          <p class="muted">Add your schedule of values below, then start your first pay application.</p>
        ) : (
          <details class="card" open={ledger.payApps.length === 0}>
            <summary class="summary-btn">New pay application #{(last?.number ?? 0) + 1}</summary>
            <form method="post" action={`/app/projects/${p.id}/pay-apps`} class="stack">
              <div class="two">
                <Field label="Period from" name="period_from" type="date" value={nextFrom} />
                <Field label="Period to" name="period_to" type="date" value={today} />
              </div>
              <p class="muted small">
                Prior work carries forward and stored materials start at last month's balance. Retainage starts at {formatBp(p.retainage_work_bp)} on work and{" "}
                {formatBp(p.retainage_stored_bp)} on stored materials.
              </p>
              <button type="submit" class="btn btn-block">
                Start pay application
              </button>
            </form>
          </details>
        )}
      </section>

      <section>
        <h2>Schedule of values</h2>
        {ledger.sov.length > 0 && (
          <ul class="list sov-list">
            {ledger.sov.map((l, index) => (
              <li class="sov-row">
                <details>
                  <summary class="list-row">
                    <span class="sov-item">{l.item_no}</span>
                    <span class="sov-desc">
                      {l.description}
                      {l.locked === 1 && <span class="muted small"> · billed</span>}
                    </span>
                    <strong class="sov-amt">{formatMoney(l.scheduled_cents)}</strong>
                  </summary>
                  <div class="sov-edit">
                    {l.locked === 1 ? (
                      <p class="muted small">This line is on a submitted pay application, so it can no longer be edited or deleted. Use a change order instead.</p>
                    ) : (
                      <form method="post" action={`/app/sov/${l.id}`} class="stack">
                        <div class="three">
                          <Field label="Item" name="item_no" value={l.item_no} />
                          <Field label="Description" name="description" value={l.description} />
                          <Field label="Scheduled value" name="scheduled" value={centsToDecimal(l.scheduled_cents)} />
                        </div>
                        <button type="submit" class="btn btn-small">
                          Save line
                        </button>
                      </form>
                    )}
                    <div class="row-actions">
                      <form method="post" action={`/app/sov/${l.id}/move`}>
                        <input type="hidden" name="direction" value="up" />
                        <button type="submit" class="btn btn-small btn-ghost" disabled={index === 0} aria-label="Move up">
                          Move up
                        </button>
                      </form>
                      <form method="post" action={`/app/sov/${l.id}/move`}>
                        <input type="hidden" name="direction" value="down" />
                        <button type="submit" class="btn btn-small btn-ghost" disabled={index === ledger.sov.length - 1} aria-label="Move down">
                          Move down
                        </button>
                      </form>
                      {l.locked === 0 && (
                        <form method="post" action={`/app/sov/${l.id}/delete`} data-confirm={`Delete line ${l.item_no}?`}>
                          <button type="submit" class="btn btn-small btn-danger">
                            Delete
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <details class="card" open={ledger.sov.length === 0 || paste !== undefined}>
          <summary class="summary-btn">Paste from Excel</summary>
          <form method="post" action={`/app/projects/${p.id}/sov/paste`} class="stack">
            <label class="field">
              <span class="field-label">Copy the item, description, and amount columns from your spreadsheet and paste them here</span>
              <textarea name="paste" rows={7} placeholder={"1\tMobilization\t24,000\n2\tUnderground conduit\t38,500\n3\tSwitchgear\t96,000"}>
                {paste ?? ""}
              </textarea>
              <span class="field-hint">Tab or comma separated. Header and total rows are skipped.</span>
            </label>
            <button type="submit" class="btn btn-block">
              Add lines
            </button>
          </form>
        </details>
        <details class="card">
          <summary class="summary-btn">Add one line</summary>
          <form method="post" action={`/app/projects/${p.id}/sov`} class="stack">
            <div class="three">
              <Field label="Item" name="item_no" value={String(ledger.sov.length + 1)} />
              <Field label="Description" name="description" />
              <Field label="Scheduled value" name="scheduled" />
            </div>
            <button type="submit" class="btn btn-block">
              Add line
            </button>
          </form>
        </details>
      </section>

      <section>
        <h2>Change orders</h2>
        {ledger.changeOrders.length > 0 && (
          <ul class="list">
            {ledger.changeOrders.map((co) => (
              <li class="list-row">
                <div>
                  <strong>
                    CO-{co.number} {co.title}
                  </strong>
                  <div class="muted">{formatMoney(co.amount_cents)}</div>
                </div>
                <div class="row-actions">
                  {co.status === "pending" ? (
                    <>
                      <form method="post" action={`/app/change-orders/${co.id}/approve`}>
                        <button type="submit" class="btn btn-small">
                          Approve
                        </button>
                      </form>
                      <form method="post" action={`/app/change-orders/${co.id}/reject`} data-confirm={`Reject CO-${co.number}?`}>
                        <button type="submit" class="btn btn-small btn-ghost">
                          Reject
                        </button>
                      </form>
                    </>
                  ) : (
                    <span class={`pill pill-co-${co.status}`}>{co.status}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {pending.length > 0 && <p class="muted small">Approve a change order once it is executed. Approving adds it to the schedule of values so it can be billed.</p>}
        <details class="card">
          <summary class="summary-btn">Add change order</summary>
          <form method="post" action={`/app/projects/${p.id}/change-orders`} class="stack">
            <div class="two">
              <Field label="Title" name="title" />
              <Field label="Amount" name="amount" hint="Use a minus sign for a deduct" />
            </div>
            <button type="submit" class="btn btn-block">
              Add change order
            </button>
          </form>
        </details>
      </section>
    </AppShell>
  );
}

const G702_LINES: [keyof G702, string][] = [
  ["originalContract", "Original contract sum"],
  ["netChangeOrders", "Net change by approved change orders"],
  ["contractSumToDate", "Contract sum to date"],
  ["completedStoredToDate", "Total completed and stored to date"],
  ["retainage", "Retainage"],
  ["earnedLessRetainage", "Total earned less retainage"],
  ["previousCertificates", "Less previous certificates for payment"],
  ["currentPaymentDue", "Current payment due"],
  ["balanceToFinish", "Balance to finish, including retainage"],
];

export function G702Summary({ g }: { g: G702 }) {
  return (
    <ol class="g702">
      {G702_LINES.map(([key, label], i) => (
        <li class={key === "currentPaymentDue" ? "g702-due" : undefined}>
          <span class="g702-n">{i + 1}</span>
          <span class="g702-label">{label}</span>
          <span class="g702-val" data-g702={key}>
            {formatMoney(g[key])}
          </span>
        </li>
      ))}
    </ol>
  );
}

const COLS = ["A Item", "B Description", "C Scheduled", "D Previous", "E This period", "% to date", "F Stored", "G Completed and stored", "H Balance", "I Retainage"];

function ReadonlyRow({ r }: { r: G703Row }) {
  return (
    <tr>
      <td data-label="Item">{r.itemNo}</td>
      <td data-label="Description" class="desc">
        {r.description}
      </td>
      <td data-label="C Scheduled">{formatMoney(r.c)}</td>
      <td data-label="D Previous">{formatMoney(r.d)}</td>
      <td data-label="E This period">{formatMoney(r.e)}</td>
      <td data-label="% to date">{formatBp(r.pctBp)}</td>
      <td data-label="F Stored">{formatMoney(r.f)}</td>
      <td data-label="G To date">{formatMoney(r.g)}</td>
      <td data-label="H Balance">{formatMoney(r.h)}</td>
      <td data-label="I Retainage">{formatMoney(r.i)}</td>
    </tr>
  );
}

function EditableRow({ r }: { r: G703Row }) {
  const pct = formatBp(r.pctBp).replace("%", "");
  return (
    <tr data-row={r.sovLineId} data-c={r.c} data-d={r.d} class={(r.c < 0 ? r.g < r.c : r.g > r.c) ? "over" : undefined}>
      <td data-label="Item">{r.itemNo}</td>
      <td data-label="Description" class="desc">
        {r.description}
      </td>
      <td data-label="C Scheduled">{formatMoney(r.c)}</td>
      <td data-label="D Previous">{formatMoney(r.d)}</td>
      <td data-label="E This period">
        <input name={`e_${r.sovLineId}`} value={centsToDecimal(r.e)} inputmode="decimal" aria-label={`Work this period, item ${r.itemNo}`} />
      </td>
      <td data-label="% to date">
        <input name={`pct_${r.sovLineId}`} value={pct} inputmode="decimal" class="pct" aria-label={`Percent complete to date, item ${r.itemNo}`} />
        <input type="hidden" name={`pct0_${r.sovLineId}`} value={pct} />
      </td>
      <td data-label="F Stored">
        <input name={`f_${r.sovLineId}`} value={centsToDecimal(r.f)} inputmode="decimal" aria-label={`Materials stored, item ${r.itemNo}`} />
      </td>
      <td data-label="G To date" data-out="g">
        {formatMoney(r.g)}
      </td>
      <td data-label="H Balance" data-out="h">
        {formatMoney(r.h)}
      </td>
      <td data-label="I Retainage" data-out="i">
        {formatMoney(r.i)}
      </td>
    </tr>
  );
}

function G703Table({ view, editable }: { view: PayAppView; editable: boolean }) {
  const t = view.result.totals;
  return (
    <div class="g703-wrap">
      <table class="g703">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{view.result.rows.map((r) => (editable ? <EditableRow r={r} /> : <ReadonlyRow r={r} />))}</tbody>
        <tfoot>
          <tr>
            <td></td>
            <td data-label="">Totals</td>
            <td data-label="C Scheduled">{formatMoney(t.c)}</td>
            <td data-label="D Previous">{formatMoney(t.d)}</td>
            <td data-label="E This period" data-total="e">
              {formatMoney(t.e)}
            </td>
            <td data-label="% to date" data-total="pct">
              {formatBp(t.pctBp)}
            </td>
            <td data-label="F Stored" data-total="f">
              {formatMoney(t.f)}
            </td>
            <td data-label="G To date" data-total="g">
              {formatMoney(t.g)}
            </td>
            <td data-label="H Balance" data-total="h">
              {formatMoney(t.h)}
            </td>
            <td data-label="I Retainage" data-total="i">
              {formatMoney(t.i)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Issues({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return <p class="notice">Checks passed. The numbers tie and nothing is overbilled.</p>;
  return (
    <div class="error" role="alert">
      <strong>
        Fix {issues.length === 1 ? "this" : `these ${issues.length} problems`} before submitting:
      </strong>
      <ul>
        {issues.map((i) => (
          <li>{issueText(i)}</li>
        ))}
      </ul>
    </div>
  );
}

function ShareBox({ view, shareUrl }: { view: PayAppView; shareUrl?: string }) {
  const id = view.payApp.id;
  return (
    <section class="card">
      <h2>GC share link</h2>
      {shareUrl ? (
        <>
          <p>Send this link to your GC. They can view and download the packet without an account. It is shown only once, so copy it now.</p>
          <input class="share-url" value={shareUrl} readonly aria-label="Share link" />
        </>
      ) : view.payApp.shared ? (
        <p class="muted">A share link is active. For security it is shown only when created. Make a new one if you need to send it again.</p>
      ) : (
        <p class="muted">No share link is active.</p>
      )}
      <div class="row-actions">
        <form method="post" action={`/app/pay-apps/${id}/share`}>
          <button type="submit" class="btn btn-small">
            {view.payApp.shared ? "New link (old one stops working)" : "Create link"}
          </button>
        </form>
        {view.payApp.shared === 1 && (
          <form method="post" action={`/app/pay-apps/${id}/share/revoke`} data-confirm="Turn off the share link?">
            <button type="submit" class="btn btn-small btn-ghost">
              Turn off link
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

export function PayAppPage({ org, user, notice, error, view, shareUrl, today }: ShellProps & { error?: string; view: PayAppView; shareUrl?: string; today: string }) {
  const { project, payApp, result } = view;
  const draft = payApp.status === "draft";
  return (
    <AppShell title={`App #${payApp.number} · ${project.name}`} active="projects" org={org} user={user} notice={notice}>
      <p class="crumbs">
        <a href="/app/projects">Projects</a> / <a href={`/app/projects/${project.id}`}>{project.name}</a>
      </p>
      <div class="page-head">
        <div>
          <h1>Pay application #{payApp.number}</h1>
          <p class="muted">
            {payApp.period_from} to {payApp.period_to} · {project.gc_name || "No GC"}
          </p>
        </div>
        <StatusPill status={payApp.status} />
      </div>
      <ErrorText error={error} />
      <div class="doc-actions">
        <a class="btn btn-small btn-ghost" href={`/app/pay-apps/${payApp.id}/pdf`}>
          Download PDF
        </a>
        <a class="btn btn-small btn-ghost" href={`/app/pay-apps/${payApp.id}/csv`}>
          Continuation sheet CSV
        </a>
      </div>

      {payApp.status === "paid" && (
        <p class="notice">
          Paid {formatMoney(payApp.paid_cents ?? 0)} on {new Date(payApp.paid_at!).toISOString().slice(0, 10)},{" "}
          {daysBetween(payApp.submitted_at!, payApp.paid_at!)} days after submission.
          {(payApp.paid_cents ?? 0) !== result.g702.currentPaymentDue && ` Short by ${formatMoney(result.g702.currentPaymentDue - (payApp.paid_cents ?? 0))}.`}
        </p>
      )}

      {draft ? (
        <form method="post" action={`/app/pay-apps/${payApp.id}`} id="payapp" data-contract={result.g702.contractSumToDate} data-prev={result.g702.previousCertificates}>
          <div class="card">
            <div class="four">
              <Field label="Period from" name="period_from" type="date" value={payApp.period_from} />
              <Field label="Period to" name="period_to" type="date" value={payApp.period_to} />
              <Field label="Retainage on work (%)" name="retainage_work" value={formatBp(payApp.retainage_work_bp).replace("%", "")} />
              <Field label="Retainage on stored (%)" name="retainage_stored" value={formatBp(payApp.retainage_stored_bp).replace("%", "")} />
            </div>
          </div>
          <h2>Continuation sheet</h2>
          <p class="muted small">Enter work completed this period as an amount (E) or as percent complete to date. Stored materials (F) is the balance on hand now.</p>
          <G703Table view={view} editable />
          <h2>Summary</h2>
          <G702Summary g={result.g702} />
          <Issues issues={view.issues} />
          <div class="sticky-actions">
            <button type="submit" name="intent" value="save" class="btn btn-ghost">
              Save draft
            </button>
            <button type="submit" name="intent" value="submit" class="btn" data-confirm="Submit this application? It will be locked and a GC share link will be created.">
              Submit to GC
            </button>
          </div>
        </form>
      ) : (
        <>
          <h2>Summary</h2>
          <G702Summary g={result.g702} />
          {payApp.status === "submitted" && (
            <section class="card">
              <h2>Record payment</h2>
              <form method="post" action={`/app/pay-apps/${payApp.id}/paid`} class="stack">
                <div class="two">
                  <Field label="Amount received" name="amount" value={centsToDecimal(result.g702.currentPaymentDue)} />
                  <Field label="Date received" name="paid_on" type="date" value={today} />
                </div>
                <button type="submit" class="btn btn-block">
                  Mark paid
                </button>
              </form>
              {view.isLatest && (
                <form method="post" action={`/app/pay-apps/${payApp.id}/reopen`} data-confirm="Reopen as a draft? The GC share link will stop working until you submit again.">
                  <button type="submit" class="btn btn-small btn-ghost">
                    Reopen to revise
                  </button>
                </form>
              )}
            </section>
          )}
          <ShareBox view={view} shareUrl={shareUrl} />
          <h2>Continuation sheet</h2>
          <G703Table view={view} editable={false} />
        </>
      )}
      {draft && (
        <form method="post" action={`/app/pay-apps/${payApp.id}/delete`} data-confirm="Delete this draft? Its entries will be lost.">
          <button type="submit" class="btn btn-small btn-danger">
            Delete draft
          </button>
        </form>
      )}
      {draft && <script dangerouslySetInnerHTML={{ __html: PAY_APP_SCRIPT }} />}
    </AppShell>
  );
}

export function SharedPayAppPage({ orgName, view, token }: { orgName: string; view: PayAppView; token: string }) {
  const { project, payApp, result } = view;
  return (
    <Document title={`Pay application #${payApp.number} · ${project.name}`} noindex>
      <header class="topbar">
        <div class="wrap topbar-inner">
          <span class="brand">
            <Mark />
            {orgName}
          </span>
        </div>
      </header>
      <main class="wrap main">
        <p class="eyebrow eyebrow-dark">Application for payment</p>
        <h1>
          {project.name} · App #{payApp.number}
        </h1>
        <p class="muted">
          From {orgName} to {project.gc_name || "the general contractor"} · Period {payApp.period_from} to {payApp.period_to}
          {payApp.submitted_at && ` · Submitted ${new Date(payApp.submitted_at).toISOString().slice(0, 10)}`}
        </p>
        <div class="stats">
          <Stat label="Current payment due" value={formatMoney(result.g702.currentPaymentDue)} />
          <Stat label="Completed and stored to date" value={formatMoney(result.g702.completedStoredToDate)} hint={`${formatBp(result.totals.pctBp)} of ${formatMoney(result.g702.contractSumToDate)}`} />
          <Stat label="Retainage held" value={formatMoney(result.g702.retainage)} />
        </div>
        <p>
          <a href={`/s/${token}/pdf`} class="btn btn-large">
            Download PDF packet
          </a>
        </p>
        <h2>Summary</h2>
        <G702Summary g={result.g702} />
        <h2>Continuation sheet</h2>
        <G703Table view={view} editable={false} />
        <p class="muted small">Read-only copy shared by {orgName}. Sent with Drawbook.</p>
      </main>
    </Document>
  );
}
