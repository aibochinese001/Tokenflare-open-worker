# AGENTS.md — AI deployment guide for cloudflare-llm-gateway

This file is written for AI agents and CI bots that deploy this Worker. Follow
it literally — do not improvise commands, do not invent secrets, and do not
guess values.

## Quick deploy (3 commands, ~3 minutes)

```bash
npm install
npm run setup          # logs you in → creates/reuses D1 `llm-gateway` →
                       # writes its id into wrangler.toml → applies schema.sql
npx wrangler secret put ADMIN_TOKEN   # required; anything long & random
npx wrangler deploy    # prints your *.workers.dev URL
```

`npm run setup` is deterministic: it verifies login, creates the D1 database
(or reuses it), backfills `database_id`, applies `schema.sql`, and prints the
remaining secret/deploy commands. Run it first; if it fails, fix what it
reports and re-run.

## Required Cloudflare API token permissions

Create the token in **Cloudflare Dashboard → My Profile → API Tokens → Create
Token** with at least these permissions (Account scope):

| Permission | Needed for |
|---|---|
| Workers Scripts Edit | deploy the Worker |
| D1 Edit | create/execute the database & schema |
| R2 Edit | (not used by this repo; include for future media buckets) |
| Workers KV Storage Edit | (not used by this repo; include for future KV caches) |
| Workers AI Edit | (not used by this repo; include for future AI bindings) |

The token itself must **never** be committed. Store it as a repo/CI secret
(`CF_API_TOKEN`) or your local shell — the same applies to every secret below.

## Secrets & variables checklist

| Name | Required? | Purpose | Where to get it |
|---|---|---|---|
| `ADMIN_TOKEN` | **Required** | Bearer token for admin/API routes (`/admin/*`) and minted consumer tokens | Generate: `openssl rand -hex 32` |
| `SESSION_SECRET` | Only for SSO | Signs session cookies (OIDC login) | `openssl rand -hex 32`; skip if not using OIDC |
| `STRIPE_SECRET_KEY` | Only for billing | Stripe server-side charges | Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | Only for billing | Verifies `checkout.session.completed` webhooks | Stripe dashboard → webhooks |
| `OIDC_ISSUER` (var) | Only for SSO | OIDC issuer URL | Your IdP (e.g. `https://your-idp.example.com`) |
| `OIDC_CLIENT_ID` (var) | Only for SSO | OIDC client id | Your IdP |
| `ADMIN_EMAIL` (var) | Only for SSO | First email = admin; others pending | Your email |

**Degradation behavior when optional secrets are unset** (nothing crashes):

- No `SESSION_SECRET`/OIDC vars → SSO login disabled; `ADMIN_TOKEN`-only auth
  still works.
- No Stripe keys → `/me/checkout` returns 503 "Payments not configured";
  admin top-up (`/admin/balances/:sub/topup`) still works.
- No `BILLING_ENABLED` → metering runs, but balances are not enforced.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `✘ [ERROR] A request to the Cloudflare API (...) failed` during `setup` | Not logged in or bad token | `npx wrangler login` (browser) or set `CLOUDFLARE_API_TOKEN`; verify permissions (Workers Scripts Edit + D1 Edit) |
| `Error: D1 database "llm-gateway" already exists` | DB created on a previous run | Fine — `setup.mjs` detects it and reuses it; just re-run |
| `✘ The request to the Cloudflare API was unauthorized` on deploy | Token lacks Workers Scripts Edit | Update the token permissions and re-login |
| `✘ Raw SQL Error` on schema apply | Schema ran twice (table exists) | `npx wrangler d1 execute llm-gateway --remote --command "DROP TABLE IF EXISTS keypool_gateway_api_keys"` then re-run setup (or ignore: schema is idempotent-safe per table) |
| `Error: You are not logged in` | No wrangler session | `npx wrangler login` |
| `Missing secret ADMIN_TOKEN` at runtime | Secret never set | `npx wrangler secret put ADMIN_TOKEN` |
| 503 from `/me/checkout` | Stripe not configured | Set Stripe secrets or use admin top-up |

## Repo layout

```
src/index.ts            Worker entrypoint (Hono wiring, PWA manifest/sw)
src/routes/             admin.ts · me.ts · openai.ts · passthrough.ts · pay.ts
src/providers/          18 upstream adapters + types
src/                    db.ts · keypool.ts · probe.ts · cron.ts · oidc.ts · ui.ts · ...
scripts/setup.mjs       deterministic bootstrap (npm run setup)
scripts/formal_secret_scan.mjs   secret scanner (npm run scan:secrets)
schema.sql              D1 schema (applied by setup)
wrangler.toml.example   safe template — copy to wrangler.toml
```

## Before pushing anything

```bash
npm run scan:secrets    # must exit 0 (no secrets found)
```

Never commit `wrangler.toml` (real D1 id), `.admin-token.txt`,
`.session-secret.txt`, or any `*.log`.
