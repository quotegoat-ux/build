import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { get, orgIdFor, ORIGIN, signup } from "./helpers";
import { exports } from "cloudflare:workers";

async function sign(payload: string, timestamp: number, secret = "whsec_test"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

function webhook(payload: string, signature: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) headers["Stripe-Signature"] = signature;
  return exports.default.fetch(`${ORIGIN}/webhooks/stripe`, { method: "POST", headers, body: payload });
}

function subscriptionEvent(type: string, orgId: string, status: string, created: number) {
  return JSON.stringify({ type, created, data: { object: { id: "sub_123", customer: `cus_${orgId}`, status, metadata: { org_id: orgId } } } });
}

const orgRow = (orgId: string) =>
  env.DB.prepare("SELECT stripe_customer_id, stripe_subscription_id, subscription_status FROM orgs WHERE id = ?").bind(orgId).first();

const now = () => Math.floor(Date.now() / 1000);

describe("Stripe webhook", () => {
  it("rejects missing, wrong, and stale signatures without touching the org", async () => {
    await signup("Lou", "lou@example.com", "Lou HVAC");
    const orgId = await orgIdFor("lou@example.com");
    const payload = subscriptionEvent("customer.subscription.updated", orgId, "active", now());

    expect((await webhook(payload, null)).status).toBe(400);
    expect((await webhook(payload, await sign(payload, now(), "whsec_wrong"))).status).toBe(400);
    expect((await webhook(payload, await sign(payload, now() - 600))).status).toBe(400);
    expect((await webhook(payload.replace("active", "trialing"), await sign(payload, now()))).status).toBe(400);
    expect(await orgRow(orgId)).toEqual({ stripe_customer_id: null, stripe_subscription_id: null, subscription_status: "trialing" });
  });

  it("applies subscription updates idempotently, ignores stale events, and cancels on delete", async () => {
    await signup("Max", "max@example.com", "Max Siding");
    const orgId = await orgIdFor("max@example.com");
    const t = now();

    const checkout = JSON.stringify({ type: "checkout.session.completed", created: t, data: { object: { client_reference_id: orgId, customer: `cus_${orgId}`, subscription: "sub_123" } } });
    expect(await (await webhook(checkout, await sign(checkout, t))).json()).toEqual({ received: true, result: "applied" });
    expect(await orgRow(orgId)).toEqual({ stripe_customer_id: `cus_${orgId}`, stripe_subscription_id: "sub_123", subscription_status: "trialing" });

    const active = subscriptionEvent("customer.subscription.updated", orgId, "active", t + 10);
    for (let i = 0; i < 2; i++) {
      const res = await webhook(active, await sign(active, t));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, result: "applied" });
    }
    expect(await orgRow(orgId)).toEqual({ stripe_customer_id: `cus_${orgId}`, stripe_subscription_id: "sub_123", subscription_status: "active" });

    const stale = subscriptionEvent("customer.subscription.updated", orgId, "past_due", t + 5);
    expect(await (await webhook(stale, await sign(stale, t))).json()).toEqual({ received: true, result: "ignored" });
    expect((await orgRow(orgId))!.subscription_status).toBe("active");

    const deleted = subscriptionEvent("customer.subscription.deleted", orgId, "canceled", t + 20);
    expect(await (await webhook(deleted, await sign(deleted, t))).json()).toEqual({ received: true, result: "applied" });
    expect((await orgRow(orgId))!.subscription_status).toBe("canceled");
  });
});

describe("trial gate", () => {
  it("redirects an expired trial to billing, keeps billing and team reachable, and unlocks once active", async () => {
    const cookie = await signup("Ned", "ned@example.com", "Ned Paving");
    const orgId = await orgIdFor("ned@example.com");
    await env.DB.prepare("UPDATE orgs SET trial_ends_at = ? WHERE id = ?").bind(Date.now() - 1000, orgId).run();

    const blocked = await get("/app", cookie);
    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("Location")).toBe("/app/billing");
    expect((await get("/app/team", cookie)).status).toBe(200);
    const billing = await get("/app/billing", cookie);
    expect(billing.status).toBe(200);
    const html = await billing.text();
    expect(html).toContain("Your free trial has ended.");
    expect(html).toContain("Billing is not configured yet.");

    const active = subscriptionEvent("customer.subscription.created", orgId, "active", now());
    await webhook(active, await sign(active, now()));
    expect((await get("/app", cookie)).status).toBe(200);
  });
});
