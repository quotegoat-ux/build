export const APP_NAME = "Drawbook";

export interface Env {
  DB: D1Database;
  APP_URL: string;
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
}

export function isLocalDev(env: Env): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.APP_URL);
}
