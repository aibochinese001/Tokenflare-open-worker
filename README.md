# cloudflare-llm-gateway

A serverless, **OpenAI-compatible LLM API gateway** for **Cloudflare Workers** — a
[new-api](https://github.com/QuantumNous/new-api) / [one-api](https://github.com/songquanpeng/one-api)
style gateway that runs entirely on the **free tier** (Workers + D1, no server, no Redis).

> 🤖 **AI 部署指南**：仓库根目录的 [`AGENTS.md`](AGENTS.md) 提供了给自动部署 agent 看的
> 确定性执行清单（每一步命令、Token 权限、Secrets 清单、常见报错对照表）。人类部署直接看下方
> [Setup](#setup) 即可；一键脚本：`npm run setup`。

![cloudflare-llm-gateway — pool many AI keys behind one OpenAI-compatible API on Cloudflare](assets/hero.png)

Pool many upstream AI API keys behind one stable OpenAI-compatible endpoint.
Dead keys auto-disable, rate-limited keys cool down with progressive backoff and
auto-revive, requests fall back across providers so callers never see a 503, and
you get a built-in admin/consumer console — all on the free tier.

## Features

- **9 providers, OpenAI-compatible** — Gemini, Mistral, OpenRouter, OpenAI, DeepSeek, Groq, Moonshot (Kimi), GLM (Zhipu), Qwen (DashScope). One `POST /v1/chat/completions` + `GET /v1/models`; route by model name or an explicit `provider:model` prefix. Native passthrough at `/gemini/*`, `/mistral/*`, … too.
- **Self-healing key pool** — round-robin across active keys; `401/403`/arrears → auto-disable, `429`/quota → cooldown with **progressive backoff**, success → revive. Liveness probes use a real 1-token call (not a `/models` endpoint that lies about suspended/throttled accounts).
- **Auto-fallback** — if the chosen provider is down/throttled, the request is transparently served by another provider with live keys (response carries `X-KeyPool-Provider/Model/Fallback`); opt out per request with `{"fallback": false}`. Callers never get a 503.
- **Model-level availability** — models that a key can't actually serve (paid-only, not-found) are probed and hidden from `GET /v1/models`, so users only pick models that work.
- **Per-key console** — every key (masked) with status, stats, last error, and a live "检测全部" batch check (OpenRouter/DeepSeek show real balance); enable/disable/delete; disabled keys hidden by default.
- **Roles + SSO** — optional OIDC SSO (Authorization Code + PKCE) with an admin-approval gate, or simple bearer-token auth. Admins manage the pool and aren't metered; consumers self-serve their own tokens.
- **Metering & billing** — per-request + per-token usage with daily charts and logs; optional credit billing (per-model input/output pricing, a global discount, per-token deduction) with Stripe top-up. Off by default.
- **Token controls** — per-token quota, RPM limit, and expiry.
- **Built-in chat** — consumer chat playground (streaming) and an admin per-key debug chat.
- **$0 to run** — Cloudflare Workers + D1 free tier; unattended health-check via cron or an included GitHub Actions schedule.

## Architecture

```
client ──▶ Worker (Hono) ──▶ pick active key ──▶ upstream provider
                │                                    (Gemini/Mistral/OpenRouter)
                ├─ D1: keys, tokens, users, logs
                └─ cron / POST /admin/probe: revive cooldowns, probe disabled keys
```

Keys self-heal: a `429`/quota error cools a key down, a `401`/`403` disables it,
and both auto-revive (on a successful retry, or via the cron / `/admin/probe`).

![self-healing key pool: active → cooldown on 429, active → disabled on 401, both auto-revive back to active](assets/self-healing.png)

## Setup

```bash
npm install

# 1. create the D1 database, then paste its id into wrangler.toml
npx wrangler d1 create llm-gateway
cp wrangler.toml.example wrangler.toml      # edit database_id (+ optional SSO vars)

# 2. apply the schema
npx wrangler d1 execute llm-gateway --remote --file=./schema.sql

# 3. set secrets
npx wrangler secret put ADMIN_TOKEN         # bearer token for admin/API
npx wrangler secret put SESSION_SECRET      # random 32+ bytes (for SSO sessions)

# 4. deploy
npx wrangler deploy
```

Open the deployed URL to reach the admin console.

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/chat/completions` | user token / session | OpenAI-compatible chat |
| `GET /v1/models` | user token / session | list available models |
| `/gemini/*` `/mistral/*` `/openrouter/*` | user token / session | native passthrough |
| `POST /admin/keys/import` | admin | bulk-import `provider:key` lines |
| `GET /admin/keys/list` | admin | every key + stats |
| `POST /admin/keys/:id/check` | admin | live liveness / balance probe |
| `POST /admin/keys/:id/enable\|disable`, `DELETE /admin/keys/:id` | admin | per-key ops |
| `GET /admin/users`, `POST /admin/users/:id/approve\|block` | admin | approve consumers |
| `GET/POST/DELETE /me/tokens` | session | consumers manage their own tokens |
| `POST /admin/check-all-keys` | admin | batch probe: revive healthy, disable dead |
| `POST /admin/probe-models` / `GET /admin/models-status` | admin | model-level availability |
| `GET /admin/usage` `/admin/logs` `/me/usage` `/me/logs` | admin / session | metering |
| `GET /admin/balances` `POST /admin/balances/:sub/topup` `/admin/prices` | admin | billing |
| `POST /me/checkout` `POST /stripe/webhook` | session / none | Stripe credit top-up |

### Import keys

```bash
curl https://YOUR_WORKER/admin/keys/import \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"keys":"gemini:AIza...\nmistral:...\nopenrouter:sk-or-v1-..."}'
```

### Use it

```bash
curl https://YOUR_WORKER/v1/chat/completions \
  -H "Authorization: Bearer <user-token>" \
  -H 'content-type: application/json' \
  -d '{"model":"mistral-small-latest","messages":[{"role":"user","content":"hi"}]}'
```

## Notes

- **Terms of service:** aggregating / sharing / reselling provider API keys may
  violate the upstream providers' terms. Use it to pool **your own** keys, and
  review each provider's ToS before exposing it to others.
- SSO is optional — leave `OIDC_*` unset to run with `ADMIN_TOKEN` + minted
  tokens only.

## License

MIT
