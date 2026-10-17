# Launch checklist

Everything below needs an account owner. The code is ready for each step.

1. **Cloudflare API token.** The token in the build environment can deploy Workers to the Quote Goat account but cannot create D1 databases there (`Authentication error [code: 10000]` on `d1 create`). Add the D1:Edit permission to that token, or create a token with Workers Scripts:Edit and D1:Edit.
2. **Deploy.** Run `scripts/deploy.sh`. It creates the `drawbook` D1 database if it is missing, writes its id into `wrangler.jsonc`, applies migrations, pushes any Stripe and Resend secrets set in the environment, and deploys. Run it again with `APP_URL` set once the URL is known.
3. **Domain.** Pick a domain and add it as a custom domain on the `drawbook` Worker. Set `APP_URL` to it.
4. **Stripe.** Create a product "Drawbook" with a $89/month recurring price. Add a webhook endpoint at `https://<domain>/webhooks/stripe` for `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`. Turn on the Customer Portal with cancellation allowed. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID`.
5. **Email.** Reconnect or create a Resend account, verify the sending domain, set `RESEND_API_KEY`, and change `EMAIL_FROM` in `wrangler.jsonc`. Without it, invites, password resets, and deadline reminders are logged instead of sent.
6. **Legal review.** Have counsel review the generic waiver forms, the unverified Florida conditional riders, and the deadline rules, which carry confidence labels in the app.
7. **Validate demand.** Call ten specialty subs to confirm the pay app hours and rejection rates before spending on acquisition. See section 5 of the problem ranking research.
