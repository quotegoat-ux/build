import type { Env } from "./env";

export type EmailResult = { status: "sent" } | { status: "logged" };

export async function sendEmail(env: Env, msg: { to: string; subject: string; html: string }): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email not sent: RESEND_API_KEY unset] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.html}`);
    return { status: "logged" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
  return { status: "sent" };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function linkEmail(o: { heading: string; body: string; cta: string; url: string; footer: string }): string {
  const url = escapeHtml(o.url);
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c1917">
<h1 style="font-size:20px">${escapeHtml(o.heading)}</h1>
<p style="font-size:16px;line-height:1.5">${escapeHtml(o.body)}</p>
<p><a href="${url}" style="display:inline-block;background:#ea580c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(o.cta)}</a></p>
<p style="font-size:13px;color:#57534e">${escapeHtml(o.footer)}<br>${url}</p>
</div>`;
}
