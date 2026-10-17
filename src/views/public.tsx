import type { Context } from "hono";
import type { PropsWithChildren } from "hono/jsx";
import type { PendingInvite } from "../db";
import { APP_NAME } from "../env";
import { PLAN, TRIAL_DAYS } from "../billing";
import { DevLink, ErrorText, Field, PublicShell, render } from "./layout";

const STATS = [
  {
    figure: "56 days",
    body: "Average wait after a subcontractor submits a pay application. GCs estimate it takes 30.",
    source: "Billd, 2025 National Subcontractor Market Report",
    href: "https://billd.com/resources/2025-market-report",
  },
  {
    figure: "92%",
    body: "of subcontractors floated payroll from their own pockets in the past year.",
    source: "Siteline subcontractor survey, May 2026 (n=492)",
    href: "https://www.siteline.com/blog/92-percent-of-subcontractors-floated-payroll-last-year-new-siteline-report-finds",
  },
  {
    figure: "11+ hours",
    body: "a month spent preparing, submitting, and tracking pay apps, for 67% of subs. Most of it in Excel.",
    source: "Siteline subcontractor survey, May 2026",
    href: "https://www.siteline.com/blog/92-percent-of-subcontractors-floated-payroll-last-year-new-siteline-report-finds",
  },
  {
    figure: "#1",
    body: "internal cause of late payment: errors and omissions on the pay application itself.",
    source: "Siteline subcontractor survey, May 2026",
    href: "https://www.siteline.com/blog/92-percent-of-subcontractors-floated-payroll-last-year-new-siteline-report-finds",
  },
];

const STEPS = [
  ["Set up the job once", "Paste your schedule of values straight from Excel. Add the contract sum, retainage rates, and your GC. Two minutes."],
  [
    "Enter this month's progress",
    "Type an amount or a percent complete on each line. Prior periods, stored materials, change orders, and retainage carry forward on their own. Drawbook flags overbilling and totals that don't tie before you send.",
  ],
  ["Send it and get paid", "Download the PDF packet or send your GC a link. Record the payment when it lands and watch days-to-pay and retainage held across every job."],
];

const PROMISES = [
  ["Flat price, published", `$${PLAN.monthlyUsd} a month per company. The same number for everyone, right here on this page. No quotes, no renewal surprises.`],
  ["Unlimited users", "Add your office manager, PMs, and foremen. Nobody gets billed per seat."],
  ["No contract", "Month to month. Cancel in the app with one click, no phone call."],
  ["One-click full export", "Every project, line, change order, and pay app as JSON and CSV, any time, including after you cancel."],
  ["Free for your GCs", "They open a read-only link and download the packet. No account, no fee, no percentage of your contract."],
];

const FAQ = [
  [
    "Is this an AIA form?",
    "No. Drawbook produces an Application and Certificate for Payment with a continuation sheet in the familiar G702/G703 format: the same columns, the same math, the layout GCs expect. Drawbook is not affiliated with or endorsed by The American Institute of Architects. If your subcontract requires official AIA documents, you can copy Drawbook's numbers onto them.",
  ],
  [
    "My GC makes me use Textura, Procore, or GCPay. Does Drawbook still help?",
    "Yes. The portal is where you submit. Drawbook is where you get the numbers right: build the application, check it, download the PDF and continuation sheet CSV, then upload or key the totals into the portal.",
  ],
  [
    "Can I fix a pay app after I submit it?",
    "Reopen the latest submitted application, make the change, and resubmit. Earlier applications stay locked, so every later period still reconciles.",
  ],
  [
    "How does retainage work?",
    "Each project has a rate for completed work and one for stored materials. Each application starts with those rates and you can change them on a draft, for example when retainage drops to 5% at half complete. Line 7 always uses what the prior application actually certified.",
  ],
  ["Do I need a credit card for the trial?", `No. You get ${TRIAL_DAYS} days with everything. Load the sample project and you'll see a finished pay app in under a minute.`],
  ["What happens to my data if I cancel?", "It stays yours. Export everything as JSON or CSV from Settings, before or after you cancel."],
];

function HeroMock() {
  const lines: [string, string, boolean?][] = [
    ["Contract sum to date", "$504,900.00"],
    ["Completed and stored to date", "$254,700.00"],
    ["Retainage (5%)", "$12,735.00"],
    ["Less previous certificates", "$161,177.50"],
    ["Current payment due", "$80,787.50", true],
  ];
  return (
    <div class="mock" aria-hidden="true">
      <div class="mock-head">
        <span>Riverside Medical Office</span>
        <span class="pill pill-draft">App #3</span>
      </div>
      <div class="mock-bars">
        {[100, 100, 84, 83, 60, 18, 15, 0].map((w) => (
          <span class="mock-bar">
            <span style={`width:${w}%`} />
          </span>
        ))}
      </div>
      <ol class="mock-lines">
        {lines.map(([label, value, strong]) => (
          <li class={strong ? "mock-due" : undefined}>
            <span>{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ol>
      <p class="mock-check">Checks passed. Totals tie, nothing over 100%.</p>
    </div>
  );
}

export function Landing() {
  return (
    <PublicShell>
      <section class="hero">
        <div class="wrap hero-grid">
          <div>
            <p class="eyebrow">Pay applications for specialty subcontractors</p>
            <h1>Get paid faster with pay apps your GC can't kick back.</h1>
            <p class="lede">
              {APP_NAME} builds your G702/G703-format pay application from your schedule of values, carries every prior period forward, does the retainage
              math, and catches overbilling before your GC does.
            </p>
            <div class="hero-actions">
              <a href="/signup" class="btn btn-large">
                Start your {TRIAL_DAYS}-day free trial
              </a>
              <a href="#pricing" class="btn btn-large btn-ghost">
                ${PLAN.monthlyUsd}/month, whole company
              </a>
            </div>
            <p class="fineprint">No credit card. No contract. Unlimited users.</p>
          </div>
          <HeroMock />
        </div>
      </section>

      <section class="wrap section">
        <h2 class="section-title">The pay app is where your cash gets stuck</h2>
        <p class="lede">One wrong number and the application comes back, and your payment slides a full billing cycle while you cover payroll.</p>
        <div class="stat-grid">
          {STATS.map((s) => (
            <figure class="stat-tile">
              <p class="stat-figure">{s.figure}</p>
              <p>{s.body}</p>
              <figcaption>
                <a href={s.href} rel="noopener" target="_blank">
                  {s.source}
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
        <p class="fineprint-dark">These surveys were funded by payment software vendors. We name them so you can judge for yourself.</p>
      </section>

      <section class="band">
        <div class="wrap section">
          <h2 class="section-title">How it works</h2>
          <ol class="steps">
            {STEPS.map(([title, body], i) => (
              <li class="step">
                <span class="step-n">{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section class="wrap section">
        <h2 class="section-title">No lock-in. Ever.</h2>
        <p class="lede">The biggest complaints about construction software are surprise renewals, annual contracts, and data you can't get back out. We built the opposite.</p>
        <ul class="promises">
          {PROMISES.map(([title, body]) => (
            <li>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="pricing" class="band">
        <div class="wrap section pricing">
          <h2 class="section-title">One plan. One price.</h2>
          <div class="plan plan-single">
            <h3>{PLAN.name}</h3>
            <p class="price">
              ${PLAN.monthlyUsd}
              <span>/month per company</span>
            </p>
            <ul>
              {PLAN.features.map((f) => (
                <li>{f}</li>
              ))}
            </ul>
            <a href="/signup" class="btn btn-block btn-large">
              Start free trial
            </a>
            <p class="muted small">
              {TRIAL_DAYS} days free, no card. Per-seat billing tools run $99 to $149 per user per month, and some GC portals charge subs a percentage of the
              contract.
            </p>
          </div>
        </div>
      </section>

      <section class="wrap section faq">
        <h2 class="section-title">Questions</h2>
        {FAQ.map(([q, a]) => (
          <details>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>

      <section class="cta">
        <div class="wrap">
          <h2>Send a pay app your GC approves the first time.</h2>
          <p class="lede center">Set up your first job in minutes, or load the sample and see a finished application right away.</p>
          <a href="/signup" class="btn btn-large">
            Start free trial
          </a>
        </div>
      </section>

      <footer class="wrap footer">
        <p>
          © {new Date().getFullYear()} {APP_NAME}
        </p>
        <p>G702 and G703 are document names of The American Institute of Architects. {APP_NAME} is not affiliated with or endorsed by AIA.</p>
      </footer>
    </PublicShell>
  );
}

function AuthCard({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <PublicShell title={title}>
      <main class="auth">
        <div class="card">
          <h1>{title}</h1>
          {children}
        </div>
      </main>
    </PublicShell>
  );
}

export function SignupPage({ error, values = {} }: { error?: string; values?: Record<string, string> }) {
  return (
    <AuthCard title="Start your free trial">
      <ErrorText error={error} />
      <form method="post" action="/signup" class="stack">
        <Field label="Your name" name="name" value={values.name} autocomplete="name" />
        <Field label="Company name" name="org_name" value={values.org_name} autocomplete="organization" />
        <Field label="Email" name="email" type="email" value={values.email} autocomplete="email" />
        <Field label="Password" name="password" type="password" autocomplete="new-password" minlength={8} hint="At least 8 characters." />
        <button type="submit" class="btn btn-block">
          Create account
        </button>
      </form>
      <p class="muted">
        Already have an account? <a href="/login">Log in</a>
      </p>
    </AuthCard>
  );
}

export function LoginPage({ error, email, next, notice }: { error?: string; email?: string; next?: string; notice?: string }) {
  return (
    <AuthCard title="Log in">
      {notice && <p class="notice">{notice}</p>}
      <ErrorText error={error} />
      <form method="post" action={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} class="stack">
        <Field label="Email" name="email" type="email" value={email} autocomplete="email" />
        <Field label="Password" name="password" type="password" autocomplete="current-password" />
        <button type="submit" class="btn btn-block">
          Log in
        </button>
      </form>
      <p class="muted">
        <a href="/forgot">Forgot your password?</a>
      </p>
      <p class="muted">
        New here? <a href="/signup">Start a free trial</a>
      </p>
    </AuthCard>
  );
}

export function ForgotPage({ sent, devLink }: { sent?: boolean; devLink?: string }) {
  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <p>If an account exists for that email, a reset link is on its way. It expires in one hour.</p>
      ) : (
        <form method="post" action="/forgot" class="stack">
          <Field label="Email" name="email" type="email" autocomplete="email" />
          <button type="submit" class="btn btn-block">
            Send reset link
          </button>
        </form>
      )}
      <DevLink url={devLink} />
      <p class="muted">
        <a href="/login">Back to log in</a>
      </p>
    </AuthCard>
  );
}

export function ResetPage({ token, error }: { token: string; error?: string }) {
  return (
    <AuthCard title="Choose a new password">
      <ErrorText error={error} />
      <form method="post" action={`/reset/${token}`} class="stack">
        <Field label="New password" name="password" type="password" autocomplete="new-password" minlength={8} hint="At least 8 characters." />
        <button type="submit" class="btn btn-block">
          Update password
        </button>
      </form>
    </AuthCard>
  );
}

export function AcceptInvitePage({ invite, token, existingUser, error }: { invite: PendingInvite; token: string; existingUser: boolean; error?: string }) {
  return (
    <AuthCard title={`Join ${invite.org_name}`}>
      <p>
        You were invited as <strong>{invite.role}</strong> using <strong>{invite.email}</strong>.
      </p>
      <ErrorText error={error} />
      <form method="post" action={`/invite/${token}`} class="stack">
        {existingUser ? (
          <Field label="Your password" name="password" type="password" autocomplete="current-password" hint="Log in to your existing account to accept." />
        ) : (
          <>
            <Field label="Your name" name="name" autocomplete="name" />
            <Field label="Choose a password" name="password" type="password" autocomplete="new-password" minlength={8} hint="At least 8 characters." />
          </>
        )}
        <button type="submit" class="btn btn-block">
          Accept invite
        </button>
      </form>
    </AuthCard>
  );
}

export function MessagePage({ title, message, status }: { title: string; message: string; status?: number }) {
  return (
    <AuthCard title={title}>
      {status && <p class="status-code">{status}</p>}
      <p>{message}</p>
      <p>
        <a href="/" class="btn btn-block">
          Go home
        </a>
      </p>
    </AuthCard>
  );
}

export function notFound(c: Context) {
  return render(c, <MessagePage title="Page not found" status={404} message="We couldn't find what you were looking for." />, 404);
}
