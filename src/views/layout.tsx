import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Child, PropsWithChildren } from "hono/jsx";
import type { Org, User } from "../db";
import { APP_NAME } from "../env";
import { hasAccess } from "../billing";

export async function render(c: Context, node: Child, status: ContentfulStatusCode = 200) {
  return c.html(`<!doctype html>${await node}`, status);
}

const NOTICES = {
  invited: "Invite sent.",
  invite_revoked: "Invite revoked.",
  member_removed: "Member removed.",
  saved: "Saved.",
  project_created: "Project created. Add your schedule of values next.",
  lines_added: "Schedule of values updated.",
  line_deleted: "Line deleted.",
  co_added: "Change order added.",
  co_approved: "Change order approved and added to the schedule of values.",
  co_rejected: "Change order rejected.",
  draft_saved: "Draft saved.",
  draft_deleted: "Draft deleted.",
  marked_paid: "Payment recorded.",
  reopened: "Reopened as a draft. The old share link no longer works.",
  share_revoked: "Share link turned off.",
  sample_loaded: "Sample project loaded. Open the draft pay application to see how billing works.",
  password_reset: "Password updated. Log in with your new password.",
  checkout_done: "Thanks! Your subscription will show here as soon as Stripe confirms it.",
  switched: "Switched organization.",
} as const;

export type NoticeKey = keyof typeof NOTICES;

export function noticeFrom(key: string | undefined): string | undefined {
  return key && key in NOTICES ? NOTICES[key as NoticeKey] : undefined;
}

// Prevents double submits on slow job-site connections and asks before destructive actions.
const ENHANCE = `document.addEventListener("submit",function(e){var f=e.target;var s=e.submitter;var m=(s&&s.getAttribute("data-confirm"))||f.getAttribute("data-confirm");if(m&&!confirm(m)){e.preventDefault();return}f.querySelectorAll("button").forEach(function(b){setTimeout(function(){b.disabled=true},0)})});`;

export function Document({ title, noindex, children }: PropsWithChildren<{ title?: string; noindex?: boolean }>) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#1c1917" />
        {noindex && <meta name="robots" content="noindex, nofollow" />}
        <title>{title ? `${title} | ${APP_NAME}` : APP_NAME}</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: ENHANCE }} />
      </body>
    </html>
  );
}

export function Mark() {
  return (
    <svg class="brand-mark" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="2" width="18" height="22" rx="3" fill="currentColor" />
      <path d="M8 9h9M8 13h9M8 17h5" stroke="#1c1917" stroke-width="2" stroke-linecap="round" />
      <circle cx="20" cy="19" r="5" fill="#16a34a" stroke="#1c1917" stroke-width="2" />
      <path d="M17.8 19.2l1.5 1.5 2.9-3" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <a href="/" class="brand">
      <Mark />
      {APP_NAME}
    </a>
  );
}

export function PublicShell({ title, children }: PropsWithChildren<{ title?: string }>) {
  return (
    <Document title={title}>
      <header class="topbar">
        <div class="wrap topbar-inner">
          <Brand />
          <nav class="topbar-links">
            <a href="/login">Log in</a>
            <a href="/signup" class="btn btn-small">
              Start free trial
            </a>
          </nav>
        </div>
      </header>
      {children}
    </Document>
  );
}

const NAV = [
  { key: "dashboard", href: "/app", label: "Dashboard" },
  { key: "projects", href: "/app/projects", label: "Projects" },
  { key: "team", href: "/app/team", label: "Team" },
  { key: "billing", href: "/app/billing", label: "Billing" },
  { key: "settings", href: "/app/settings", label: "Settings" },
] as const;

export type NavKey = (typeof NAV)[number]["key"];

export function AppShell({
  title,
  active,
  org,
  user,
  notice,
  children,
}: PropsWithChildren<{ title: string; active: NavKey; org: Org; user: User; notice?: string }>) {
  const now = Date.now();
  const trialDaysLeft = Math.max(0, Math.ceil((org.trial_ends_at - now) / 86_400_000));
  return (
    <Document title={title}>
      <header class="topbar">
        <div class="wrap topbar-inner">
          <a href="/app" class="brand">
            <Mark />
            <span class="org-name">{org.name}</span>
          </a>
          <form method="post" action="/logout">
            <button type="submit" class="link-button" title={`Signed in as ${user.email}`}>
              Log out
            </button>
          </form>
        </div>
        <nav class="wrap tabs" aria-label="Main">
          {NAV.map((n) => (
            <a href={n.href} class={n.key === active ? "tab active" : "tab"} aria-current={n.key === active ? "page" : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
      </header>
      {org.subscription_status !== "active" && hasAccess(org, now) && (
        <div class="banner">
          <div class="wrap">
            Free trial: {trialDaysLeft} {trialDaysLeft === 1 ? "day" : "days"} left. <a href="/app/billing">Subscribe</a>
          </div>
        </div>
      )}
      <main class="wrap main">
        {notice && (
          <p class="notice" role="status">
            {notice}
          </p>
        )}
        {children}
      </main>
    </Document>
  );
}

export function Field({
  label,
  name,
  type = "text",
  value,
  autocomplete,
  required = true,
  minlength,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  value?: string;
  autocomplete?: string;
  required?: boolean;
  minlength?: number;
  hint?: string;
}) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      <input name={name} type={type} value={value} autocomplete={autocomplete} required={required} minlength={minlength} />
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

export function ErrorText({ error }: { error?: string }) {
  return error ? (
    <p class="error" role="alert">
      {error}
    </p>
  ) : null;
}

export function DevLink({ url }: { url?: string }) {
  return url ? (
    <div class="devlink">
      <strong>Dev mode:</strong> email is not configured, so here is the link that would have been sent.
      <a href={url}>{url}</a>
    </div>
  ) : null;
}
