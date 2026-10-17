import { hmacSha256Hex, timingSafeEqual } from "./crypto";
import { linkCheckout, syncSubscription, type Org, type SubscriptionStatus } from "./db";
import type { Env } from "./env";

export const TRIAL_DAYS = 14;

export const PLANS = [
  {
    id: "starter",
    name: "Starter",
    monthlyUsd: 49,
    priceEnv: "STRIPE_PRICE_STARTER",
    blurb: "For small crews getting organized.",
    features: ["Up to 5 team members", "Mobile-friendly on the job site", "Email support"],
  },
  {
    id: "pro",
    name: "Pro",
    monthlyUsd: 149,
    priceEnv: "STRIPE_PRICE_PRO",
    blurb: "For growing contractors running several jobs at once.",
    features: ["Unlimited team members", "Everything in Starter", "Priority support"],
  },
] as const satisfies readonly { id: string; priceEnv: Extract<keyof Env, `STRIPE_PRICE_${string}`>; [k: string]: unknown }[];

export type Plan = (typeof PLANS)[number];

export function findPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function billingConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function hasAccess(org: Pick<Org, "subscription_status" | "trial_ends_at">, now: number): boolean {
  return org.subscription_status === "active" || now < org.trial_ends_at;
}

async function stripe<T>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`Stripe ${path} failed (${res.status}): ${body.error?.message ?? "unknown error"}`);
  return body;
}

export async function createCheckoutUrl(env: Env, org: Org, plan: Plan, customerEmail: string): Promise<string> {
  const price = env[plan.priceEnv];
  if (!price) throw new Error(`${plan.priceEnv} is not set`);
  const params: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    client_reference_id: org.id,
    "subscription_data[metadata][org_id]": org.id,
    success_url: `${env.APP_URL}/app/billing?notice=checkout_done`,
    cancel_url: `${env.APP_URL}/app/billing`,
  };
  if (org.stripe_customer_id) params.customer = org.stripe_customer_id;
  else params.customer_email = customerEmail;
  const session = await stripe<{ url: string }>(env, "checkout/sessions", params);
  return session.url;
}

export async function createPortalUrl(env: Env, customerId: string): Promise<string> {
  const session = await stripe<{ url: string }>(env, "billing_portal/sessions", {
    customer: customerId,
    return_url: `${env.APP_URL}/app/billing`,
  });
  return session.url;
}

const SIGNATURE_TOLERANCE_S = 300;

export async function verifyStripeSignature(secret: string, payload: string, header: string | undefined, nowMs: number): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((kv) => kv.split("=", 2) as [string, string | undefined]);
  const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v as string);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((s) => timingSafeEqual(s, expected));
}

const STRIPE_STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "past_due",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  canceled: "canceled",
};

type StripeEvent =
  | { type: "checkout.session.completed"; created: number; data: { object: { client_reference_id: string | null; customer: string | null; subscription: string | null } } }
  | {
      type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";
      created: number;
      data: { object: { id: string; customer: string; status: string; metadata?: Record<string, string> } };
    };

const HANDLED = new Set<string>(["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

function isHandled(event: { type?: unknown }): event is StripeEvent {
  return typeof event.type === "string" && HANDLED.has(event.type);
}

/** Every write sets absolute values, so replays and retries converge on the same org row. */
export async function handleStripeEvent(db: D1Database, raw: unknown): Promise<"applied" | "ignored"> {
  const event = raw as { type?: unknown };
  if (!isHandled(event)) return "ignored";
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      if (!s.client_reference_id || !s.customer) return "ignored";
      await linkCheckout(db, s.client_reference_id, s.customer, s.subscription);
      return "applied";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const deleted = event.type === "customer.subscription.deleted";
      const applied = await syncSubscription(db, {
        orgId: sub.metadata?.org_id ?? null,
        customerId: sub.customer,
        subscriptionId: sub.id,
        status: deleted ? "canceled" : (STRIPE_STATUS[sub.status] ?? "incomplete"),
        eventCreated: event.created,
        deleted,
      });
      return applied ? "applied" : "ignored";
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
