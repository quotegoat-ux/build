import type { Org, User } from "../db";
import { DEADLINE_LABEL, type DeadlineReport, type UpcomingDeadline } from "../deadlines";
import { formatMoney } from "../money";
import type { WaiverRow } from "../projectsDb";
import { DEADLINE_DISCLAIMER } from "../reminders";
import { UNVERIFIED_BADGE, WAIVER_DISCLAIMER, WAIVER_KIND_LABEL, type WaiverStatus, type WaiverView } from "../waivers";
import { AppShell, ErrorText, Field } from "./layout";

const WAIVER_STATUS: Record<WaiverStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "pill-draft" },
  sent: { label: "Sent", cls: "pill-submitted" },
  signed: { label: "Signed", cls: "pill-paid" },
};

function WaiverStatusPill({ status }: { status: WaiverStatus }) {
  return <span class={`pill ${WAIVER_STATUS[status].cls}`}>{WAIVER_STATUS[status].label}</span>;
}

export function WaiverList({ waivers, appNumbers, empty }: { waivers: WaiverRow[]; appNumbers: Map<string, number>; empty: string }) {
  if (waivers.length === 0) return <p class="muted">{empty}</p>;
  return (
    <ul class="list">
      {waivers.map((w) => (
        <li>
          <a class="list-row row-link" href={`/app/waivers/${w.id}`}>
            <div>
              <strong>{WAIVER_KIND_LABEL[w.kind]} waiver</strong>
              <div class="muted">
                {w.pay_app_id && appNumbers.has(w.pay_app_id) ? `App #${appNumbers.get(w.pay_app_id)} · ` : ""}through {w.through_date}
              </div>
            </div>
            <div class="row-figures">
              <strong>{formatMoney(w.amount_cents)}</strong>
              <WaiverStatusPill status={w.status} />
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Confidence({ value }: { value: string }) {
  return <span class={value === "high" ? "pill pill-conf" : "pill pill-conf pill-conf-low"}>{value} confidence</span>;
}

export function DeadlinesSection({ report, today }: { report: DeadlineReport; today: string }) {
  return (
    <section>
      <h2>Lien deadlines</h2>
      {report.deadlines.length > 0 && (
        <ul class="list">
          {report.deadlines.map((d) => (
            <li class="list-row">
              <div>
                <strong>{DEADLINE_LABEL[d.kind]}</strong>
                <div class="muted small">{d.basis}</div>
              </div>
              <div class="row-figures">
                <strong class={d.dueOn < today ? "overdue" : undefined}>
                  {d.dueOn < today ? "Overdue " : ""}
                  {d.dueOn}
                </strong>
                <Confidence value={d.confidence} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {report.notes.map((n) => (
        <p class="muted">{n}</p>
      ))}
      <p class="muted small">
        {DEADLINE_DISCLAIMER}
        {report.citation && ` Source: ${report.citation}.`}
      </p>
    </section>
  );
}

export function UpcomingDeadlinesCard({ upcoming }: { upcoming: UpcomingDeadline[] }) {
  return (
    <section class="card">
      <h2>Upcoming deadlines</h2>
      {upcoming.length === 0 ? (
        <p class="muted">No lien deadlines in the next 60 days.</p>
      ) : (
        <ul class="list">
          {upcoming.map((d) => (
            <li>
              <a class="list-row row-link" href={`/app/projects/${d.projectId}`}>
                <div>
                  <strong>{DEADLINE_LABEL[d.kind]}</strong>
                  <div class="muted">{d.projectName}</div>
                </div>
                <div class="row-figures">
                  <strong class={d.overdue ? "overdue" : undefined}>
                    {d.overdue ? "Overdue " : ""}
                    {d.dueOn}
                  </strong>
                  <Confidence value={d.confidence} />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p class="muted small">{DEADLINE_DISCLAIMER}</p>
    </section>
  );
}

export function WaiverText({ view }: { view: WaiverView }) {
  const d = view.document;
  return (
    <article class="waiver">
      <div class="waiver-flags">
        {!d.verified && <p class="badge-warn">{UNVERIFIED_BADGE}</p>}
        {d.source === "generic" ? (
          <p class="warn">
            {d.reason}
            {d.detail && <span class="small"> {d.detail}</span>}
          </p>
        ) : (
          <p class="muted small">Statutory form: {d.citation}</p>
        )}
        {d.notarize && <p class="small"><strong>Notarization required.</strong> Sign in front of a notary.</p>}
        {d.witness && <p class="small"><strong>Witness required.</strong> Sign in front of a witness.</p>}
      </div>
      <pre class="waiver-body">{d.body}</pre>
      <p class="muted small waiver-disclaimer">{WAIVER_DISCLAIMER}</p>
    </article>
  );
}

export function WaiverPage({ org, user, notice, error, view, today }: { org: Org; user: User; notice?: string; error?: string; view: WaiverView; today: string }) {
  const w = view.waiver;
  const base = `/app/waivers/${w.id}`;
  return (
    <AppShell title={`${WAIVER_KIND_LABEL[w.kind]} waiver · ${view.project.name}`} active="projects" org={org} user={user} notice={notice}>
      <p class="crumbs">
        <a href="/app/projects">Projects</a> / <a href={`/app/projects/${view.project.id}`}>{view.project.name}</a>
        {view.payAppNumber !== null && (
          <>
            {" "}
            / <a href={`/app/pay-apps/${w.pay_app_id}`}>App #{view.payAppNumber}</a>
          </>
        )}
      </p>
      <div class="page-head">
        <div>
          <h1>{WAIVER_KIND_LABEL[w.kind]} lien waiver</h1>
          <p class="muted">
            {formatMoney(w.amount_cents)} through {w.through_date}
            {w.state && ` · ${w.state}`}
          </p>
        </div>
        <WaiverStatusPill status={w.status} />
      </div>
      <ErrorText error={error} />
      <div class="doc-actions">
        <a class="btn btn-small btn-ghost" href={`${base}/pdf`}>
          Download PDF
        </a>
      </div>
      {w.status === "signed" && (
        <p class="notice">
          Signed by {w.signer_name}
          {w.signer_title && `, ${w.signer_title}`}, on {new Date(w.signed_at!).toISOString().slice(0, 10)}.
        </p>
      )}
      {w.status === "draft" && (
        <form method="post" action={base} class="card stack">
          <h2>Fill in the form</h2>
          <p class="muted small">Project, payment, and company details fill in automatically. Fields stay editable until you mark the waiver sent or signed.</p>
          {view.fields.length > 0 && (
            <div class="two">
              {view.fields.map((f) => (
                <Field label={f.label} name={`field_${f.key}`} value={f.value} required={false} autocomplete="off" />
              ))}
            </div>
          )}
          <label class="field">
            <span class="field-label">Exceptions</span>
            <textarea name="exceptions" rows={2} placeholder="None">
              {w.exceptions_text}
            </textarea>
            <span class="field-hint">Disputed claims or amounts this waiver does not cover.</span>
          </label>
          <button type="submit" class="btn btn-block">
            Save waiver
          </button>
        </form>
      )}
      <WaiverText view={view} />
      {w.status !== "signed" && (
        <section class="card">
          <h2>Record signature</h2>
          <form method="post" action={`${base}/signed`} class="stack">
            <div class="three">
              <Field label="Signer name" name="signer_name" autocomplete="name" />
              <Field label="Title" name="signer_title" required={false} autocomplete="organization-title" />
              <Field label="Date signed" name="signed_on" type="date" value={today} />
            </div>
            <button type="submit" class="btn btn-block" data-confirm="Mark this waiver signed? The text locks as shown.">
              Mark signed
            </button>
          </form>
          {w.status === "draft" && (
            <form method="post" action={`${base}/sent`}>
              <p class="muted small">Sent but not signed yet? Marking it sent adds it to the GC share page and locks the fields.</p>
              <button type="submit" class="btn btn-small btn-ghost">
                Mark sent
              </button>
            </form>
          )}
        </section>
      )}
    </AppShell>
  );
}

export function SharedWaivers({ views, token }: { views: WaiverView[]; token: string }) {
  if (views.length === 0) return null;
  return (
    <section>
      <h2>Lien waivers</h2>
      {views.map((v) => (
        <details class="card">
          <summary class="summary-btn">
            {WAIVER_KIND_LABEL[v.waiver.kind]} waiver · {formatMoney(v.waiver.amount_cents)} · {WAIVER_STATUS[v.waiver.status].label}
          </summary>
          <p>
            <a class="btn btn-small btn-ghost" href={`/s/${token}/waivers/${v.waiver.id}/pdf`}>
              Download waiver PDF
            </a>
          </p>
          <WaiverText view={v} />
        </details>
      ))}
    </section>
  );
}
