#!/usr/bin/env bash
# Usage: APP_URL=https://app.example.com scripts/deploy.sh
# Needs CLOUDFLARE_API_TOKEN with Workers Scripts:Edit and D1:Edit, and CLOUDFLARE_ACCOUNT_ID.
# STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID and RESEND_API_KEY are pushed as secrets when set.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
DB_NAME=drawbook

db_id() {
  npx wrangler d1 list --json | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const db = JSON.parse(s).find((d) => d.name === process.argv[1]);
      process.stdout.write(db ? db.uuid : "");
    });' "$DB_NAME"
}

ID="$(db_id)"
if [ -z "$ID" ]; then
  npx wrangler d1 create "$DB_NAME" >/dev/null
  ID="$(db_id)"
fi
echo "D1 $DB_NAME: $ID"
sed -i.bak -E "s/\"database_id\": \"[^\"]*\"/\"database_id\": \"$ID\"/" wrangler.jsonc && rm wrangler.jsonc.bak

npx wrangler d1 migrations apply DB --remote

for name in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID RESEND_API_KEY; do
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}" | npx wrangler secret put "$name"; fi
done

npx wrangler deploy ${APP_URL:+--var "APP_URL:$APP_URL"}
