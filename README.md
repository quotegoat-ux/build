# Groundwork

Multi-tenant foundation for a construction-contractor SaaS on Cloudflare Workers: accounts, orgs, sessions, team invites, password reset, and Stripe billing. The product name lives in `APP_NAME` in `src/env.ts`.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # every value is optional
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

Without `RESEND_API_KEY`, emails are logged and invite and reset links appear on screen in local dev. Without `STRIPE_SECRET_KEY`, the billing page says billing is not configured and the rest of the app works.

## Check

```sh
npm run typecheck
npm test
```

## Tenant scoping

Handlers under `/app` receive `c.var.tenant`, a `Tenant` that only `loadSession` in `src/db.ts` can produce. Tenant-scoped data functions take it as their first argument and filter by `t.orgId`. New domain tables carry `org_id` and follow the same pattern.

## Deploy

Create the D1 database, put its id in `wrangler.jsonc`, set `APP_URL` and the secrets in `.dev.vars.example` with `wrangler secret put`, then `npm run deploy`. Point a Stripe webhook at `/webhooks/stripe` for `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`.
