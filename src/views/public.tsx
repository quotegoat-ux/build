import type { PropsWithChildren } from "hono/jsx";
import type { PendingInvite } from "../db";
import { APP_NAME } from "../env";
import { PLANS, TRIAL_DAYS } from "../billing";
import { DevLink, ErrorText, Field, PublicShell } from "./layout";

export function Landing() {
  return (
    <PublicShell>
      <section class="hero">
        <div class="wrap">
          <p class="eyebrow">Built for contractors</p>
          <h1>Run the office from the job site.</h1>
          <p class="lede">
            {APP_NAME} keeps your crew, paperwork, and cash flow in one place that works on the phone in your pocket. Less time at
            the desk, more time on the job.
          </p>
          <div class="hero-actions">
            <a href="/signup" class="btn btn-large">
              Start your {TRIAL_DAYS}-day free trial
            </a>
            <a href="#pricing" class="btn btn-large btn-ghost">
              See pricing
            </a>
          </div>
          <p class="fineprint">No credit card required.</p>
        </div>
      </section>

      <section class="wrap features">
        {[
          ["Works on your phone", "Big buttons and readable type, designed for gloves, glare, and one bar of signal."],
          ["Your whole team", "Invite your office manager, PMs, and foremen. Everyone sees the same numbers."],
          ["Set up in minutes", "Sign up, invite your team, and get going today. No consultants, no training days."],
        ].map(([title, body]) => (
          <div class="feature">
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <section id="pricing" class="wrap pricing">
        <h2>Simple monthly pricing</h2>
        <p class="lede">Every plan starts with a {TRIAL_DAYS}-day free trial. Cancel anytime.</p>
        <div class="plans">
          {PLANS.map((plan) => (
            <div class="plan">
              <h3>{plan.name}</h3>
              <p class="price">
                ${plan.monthlyUsd}
                <span>/month</span>
              </p>
              <p>{plan.blurb}</p>
              <ul>
                {plan.features.map((f) => (
                  <li>{f}</li>
                ))}
              </ul>
              <a href="/signup" class="btn btn-block">
                Start free trial
              </a>
            </div>
          ))}
        </div>
      </section>

      <section class="cta">
        <div class="wrap">
          <h2>Ready to spend less time on paperwork?</h2>
          <a href="/signup" class="btn btn-large">
            Get started free
          </a>
        </div>
      </section>

      <footer class="wrap footer">
        © {new Date().getFullYear()} {APP_NAME}
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
