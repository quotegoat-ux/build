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
  password_reset: "Password updated. Log in with your new password.",
  checkout_done: "Thanks! Your subscription will show here as soon as Stripe confirms it.",
  switched: "Switched organization.",
} as const;

export type NoticeKey = keyof typeof NOTICES;

export function noticeFrom(key: string | undefined): string | undefined {
  return key && key in NOTICES ? NOTICES[key as NoticeKey] : undefined;
}

// Prevents double submits on slow job-site connections and asks before destructive actions.
const ENHANCE = `document.addEventListener("submit",function(e){var f=e.target;var m=f.getAttribute("data-confirm");if(m&&!confirm(m)){e.preventDefault();return}f.querySelectorAll("button").forEach(function(b){setTimeout(function(){b.disabled=true},0)})});`;

export function Document({ title, children }: PropsWithChildren<{ title?: string }>) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#1c1917" />
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

export function Brand() {
  return (
    <a href="/" class="brand">
      <span class="brand-mark" aria-hidden="true">
        ▲
      </span>
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
            <span class="brand-mark" aria-hidden="true">
              ▲
            </span>
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
            Free trial: {trialDaysLeft} {trialDaysLeft === 1 ? "day" : "days"} left. <a href="/app/billing">Choose a plan</a>
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
