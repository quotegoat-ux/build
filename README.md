# Drawbook

Pay applications for specialty subcontractors, on Cloudflare Workers and D1. The spec is `docs/PRODUCT.md`. Accounts, orgs, sessions, team invites, password reset, and Stripe billing ($89/month per company, one price in `STRIPE_PRICE_ID`) come from the multi-tenant foundation.

## Layout

- `src/payapp.ts` is the G702/G703 math and draft validation. It is pure: no D1, no Hono. Money is integer cents, rates are basis points.
- `src/projectsDb.ts` holds the tenant-scoped queries for projects, schedule of values, change orders, and pay applications.
- `src/ledger.ts` turns one project's rows into `payapp.ts` inputs and folds them into project and dashboard summaries. A submitted or paid application only sees the lines it froze on submit and the change orders approved by then, so a reprint matches what the GC received.
- `src/routes.tsx` serves `/app` product screens, documents, export, and the public `/s/:token` share pages. `src/pdf.ts` draws the PDF with pdf-lib.
- `src/views/payappScript.ts` mirrors the math in the browser for live totals. The server recomputes on every save.
- `src/sample.ts` seeds the sample project used by the "Load sample project" button and the tests.

## Pay application lifecycle

`draft -> submitted -> paid`, with `submitted -> draft` (reopen) allowed only for the latest application on a project. Each transition is one guarded `UPDATE ... WHERE status = <from>` in `src/projectsDb.ts` (`submitPayApp`, `markPayAppPaid`, `reopenPayApp`), called from the matching route in `src/routes.tsx`. Lien waivers hook in there: a conditional waiver on submit, an unconditional one on payment. A partial unique index allows one draft per project.

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
