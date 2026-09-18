/** Admin routes: key import + management + token minting. Mounted at /admin. */

import { Hono } from "hono";
import type { Env, Provider } from "../types";
import { PROVIDERS } from "../types";
import { requireAdmin } from "../auth";
import {
  importKeys,
  statsSummary,
  reactivateKey,
  applyOutcome,
  createToken,
  listTokens,
  listUsers,
  setUserStatus,
  setUserRole,
  disableTokensByOwner,
  listAllKeys,
  getKeyById,
  setKeyBalance,
  deleteKey,
  deleteToken,
  prunePermanentlyDeadKeys,
  usageSummary,
  usageByUser,
  recentLogs,
  listBalances,
  topUpMicro,
  listTransactions,
  billingEnabled,
  billingDiscount,
  listModelStatus,
  allChannelModelIds,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  addChannelModel,
  removeChannelModel,
  getAllSettings,
  applySettingsPatch,
} from "../db";
import { getPayConfig, setPayConfig } from "../payone";
import { cooldownMinutes, MAX_CONSECUTIVE_FAILS } from "../keypool";
import { runHealthCheck } from "../cron";
import { probeKey, runCheckAll, runSweep, sweepProgress, probeModels } from "../probe";
import { getAdapter } from "../providers";
import type { OpenAIChatRequest } from "../providers/types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireAdmin);

function isProvider(value: string): value is Provider {
  return (PROVIDERS as string[]).includes(value);
}

/**
 * Parse `provider:key` lines. Provider is the text before the FIRST colon;
 * the rest (which may itself contain colons) is the key. Unknown providers and
 * malformed lines are collected as `skipped`.
 */
function parseKeyLines(text: string): {
  entries: Array<{ provider: Provider; api_key: string }>;
  skipped: string[];
} {
  const entries: Array<{ provider: Provider; api_key: string }> = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) {
      skipped.push(line);
      continue;
    }
    const provider = line.slice(0, idx).trim().toLowerCase();
    const api_key = line.slice(idx + 1).trim();
    if (api_key.length === 0 || !isProvider(provider)) {
      skipped.push(line);
      continue;
    }
    entries.push({ provider, api_key });
  }
  return { entries, skipped };
}

// POST /keys/import — JSON { keys: "..." } or raw text/plain lines.
app.post("/keys/import", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let text = "";
  if (contentType.includes("application/json")) {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { message: "invalid json body", type: "invalid_request_error" } },
        400
      );
    }
    if (
      body !== null &&
      typeof body === "object" &&
      typeof (body as { keys?: unknown }).keys === "string"
    ) {
      text = (body as { keys: string }).keys;
    } else {
      return c.json(
        {
          error: {
            message: "expected { keys: string }",
            type: "invalid_request_error",
          },
        },
        400
      );
    }
  } else {
    text = await c.req.text();
  }

  const { entries, skipped } = parseKeyLines(text);
  const result = await importKeys(c.env, entries);
  return c.json({
    added: result.added,
    duplicate: result.duplicate,
    skipped,
    byProvider: result.byProvider,
  });
});

// GET /keys — counts by provider/status.
app.get("/keys", async (c) => {
  const summary = await statsSummary(c.env);
  return c.json(summary);
});

// GET /config — billing flags for the console.
app.get("/config", (c) => {
  return c.json({
    billing_enabled: billingEnabled(c.env),
    discount: billingDiscount(c.env),
  });
});

// ---------------- channels (manual provider configuration) ----------------

function maskSecret(s: string): string {
  if (!s) return "";
  return s.length <= 8 ? s.slice(0, 2) + "••••" : s.slice(0, 4) + "••••" + s.slice(-4);
}

// GET /channels — list channels with their models (api key masked).
app.get("/channels", async (c) => {
  const channels = await listChannels(c.env);
  return c.json({
    channels: channels.map((ch) => ({
      ...ch,
      api_key: maskSecret(ch.api_key),
      models: ch.models.map((m) => ({ ...m })),
    })),
  });
});

// POST /channels — create a channel.
app.post("/channels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown; base_url?: unknown; api_key?: unknown; enabled?: unknown;
  } | null;
  if (!body) return c.json({ error: { message: "无效的请求" } }, 400);
  const name = String(body.name || "").trim();
  const baseUrl = String(body.base_url || "").trim();
  const apiKey = String(body.api_key || "").trim();
  if (!name || !baseUrl || !apiKey) {
    return c.json({ error: { message: "渠道名称、接口地址、API Key 均必填" } }, 400);
  }
  const id = await createChannel(c.env, {
    name,
    base_url: baseUrl,
    api_key: apiKey,
    enabled: body.enabled !== false,
  });
  return c.json({ ok: true, id });
});

// PATCH /channels/:id — update name/base_url/api_key/enabled (masked or empty key keeps current).
app.patch("/channels/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: { message: "无效的渠道 ID" } }, 400);
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown; base_url?: unknown; api_key?: unknown; enabled?: unknown;
  } | null;
  if (!body) return c.json({ error: { message: "无效的请求" } }, 400);
  const patch: { name?: string; base_url?: string; api_key?: string; enabled?: boolean } = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.base_url === "string") patch.base_url = body.base_url.trim();
  let key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (key && !key.includes("••••")) patch.api_key = key;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  await updateChannel(c.env, id, patch);
  return c.json({ ok: true });
});

// DELETE /channels/:id — remove channel and its model registrations.
app.delete("/channels/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: { message: "无效的渠道 ID" } }, 400);
  await deleteChannel(c.env, id);
  return c.json({ ok: true });
});

// POST /channels/:id/models — register a model with 3-tier pricing.
app.post("/channels/:id/models", async (c) => {
  const channelId = Number(c.req.param("id"));
  if (!Number.isFinite(channelId) || channelId <= 0) return c.json({ error: { message: "无效的渠道 ID" } }, 400);
  const body = (await c.req.json().catch(() => null)) as {
    model_id?: unknown; input?: unknown; cached?: unknown; output?: unknown;
  } | null;
  if (!body) return c.json({ error: { message: "无效的请求" } }, 400);
  const modelId = String(body.model_id || "").trim();
  const input = Number(body.input);
  const output = Number(body.output);
  const cachedRaw = body.cached === undefined || body.cached === null || body.cached === "" ? null : Number(body.cached);
  if (!modelId || !Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    return c.json({ error: { message: "模型 ID 与有效价格必填" } }, 400);
  }
  if (cachedRaw !== null && (!Number.isFinite(cachedRaw) || cachedRaw < 0)) {
    return c.json({ error: { message: "缓存命中价格无效" } }, 400);
  }
  await addChannelModel(c.env, channelId, {
    model_id: modelId,
    input: Math.round(input),
    cached: cachedRaw === null ? null : Math.round(cachedRaw),
    output: Math.round(output),
  });
  return c.json({ ok: true });
});

// DELETE /channels/:id/models/:modelId — remove a model from a channel.
app.delete("/channels/:id/models/:modelId", async (c) => {
  const channelId = Number(c.req.param("id"));
  if (!Number.isFinite(channelId) || channelId <= 0) return c.json({ error: { message: "无效的渠道 ID" } }, 400);
  const modelId = decodeURIComponent(c.req.param("modelId") || "");
  if (!modelId) return c.json({ error: { message: "无效的模型 ID" } }, 400);
  await removeChannelModel(c.env, channelId, modelId);
  return c.json({ ok: true });
});
// ---------------- system settings ----------------

// GET /settings — all operator settings (logo/favicon are data URIs).
app.get("/settings", async (c) => {
  const s = await getAllSettings(c.env);
  return c.json({ settings: s });
});

// PUT /settings — patch settings; empty string removes the key.
app.put("/settings", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: { message: "无效的请求" } }, 400);
  const applied = await applySettingsPatch(c.env, body);
  return c.json({ ok: true, applied });
});
// GET /pay-config — payment gateway settings (api key masked on read).
app.get("/pay-config", async (c) => {
  const cfg = await getPayConfig(c.env);
  if (!cfg) {
    return c.json({ configured: false, api_url: "", pid: "", key: "", methods: [], method_types: {} });
  }
  const keyMasked = cfg.key ? cfg.key.slice(0, 3) + "••••" + cfg.key.slice(-3) : "";
  return c.json({
    configured: true,
    api_url: cfg.api_url,
    pid: cfg.pid,
    key: keyMasked,
    methods: cfg.methods,
    method_types: cfg.method_types,
  });
});

// POST /pay-config — save payment gateway settings.
app.post("/pay-config", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    api_url?: unknown;
    pid?: unknown;
    key?: unknown;
    methods?: unknown;
    method_types?: unknown;
  } | null;
  if (!body) return c.json({ error: { message: "无效的请求" } }, 400);
  const apiUrl = String(body.api_url || "").trim();
  const pid = String(body.pid || "").trim();
  let key = String(body.key || "").trim();
  if (!apiUrl || !pid) {
    return c.json({ error: { message: "接口地址、商户号均必填" } }, 400);
  }
  // Empty / masked key keeps the existing key; a fresh config requires one.
  const existing = await getPayConfig(c.env);
  if (key.startsWith("••••") || key === "") {
    if (!existing) {
      return c.json({ error: { message: "首次配置必须填写 API Key" } }, 400);
    }
    key = existing.key;
  }

  const rawMethods = Array.isArray(body.methods) ? body.methods.filter((m): m is string => typeof m === "string") : [];
  const methodTypes = (body.method_types && typeof body.method_types === "object")
    ? (body.method_types as Record<string, unknown>)
    : {};
  const types: Record<string, string> = {};
  for (const [k, v] of Object.entries(methodTypes)) {
    if (typeof v === "string" && v.trim()) types[k] = v.trim();
  }
  await setPayConfig(c.env, {
    api_url: apiUrl,
    pid,
    key,
    methods: rawMethods,
    method_types: types,
  });
  return c.json({ ok: true });
});

// GET /usage — global usage aggregates (last 30 days). ?owner=<sub> scopes to one user.
app.get("/usage", async (c) => {
  const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const owner = c.req.query("owner") || undefined;
  return c.json(await usageSummary(c.env, { sinceMs, ownerSub: owner }));
});

// GET /usage/by-user — per-user usage leaderboard (last 30 days), ranked by requests.
app.get("/usage/by-user", async (c) => {
  const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return c.json(await usageByUser(c.env, { sinceMs, limit: 100 }));
});

// GET /logs — recent requests. ?owner=<sub> filters to one user; ?page=N&size=M paginates.
app.get("/logs", async (c) => {
  const owner = c.req.query("owner") || undefined;
  const size = Math.min(200, Math.max(1, parseInt(c.req.query("size") || "50", 10) || 50));
  const page = Math.max(0, parseInt(c.req.query("page") || "0", 10) || 0);
  // Fetch one extra row to tell the UI whether a next page exists.
  const rows = await recentLogs(c.env, { ownerSub: owner, limit: size + 1, offset: page * size });
  const hasMore = rows.length > size;
  return c.json({ rows: hasMore ? rows.slice(0, size) : rows, page, size, hasMore });
});

// POST /probe — run the unattended health check on demand (revive expired
// cooldowns + probe disabled keys). Replaces the CF cron; point a free external
// pinger (cron-job.org, GitHub Actions) at it for fully unattended recovery.
app.post("/probe", async (c) => {
  const result = await runHealthCheck(c.env);
  return c.json({ ok: true, ...result });
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// POST /keys/:id/enable — manual reactivation.
app.post("/keys/:id/enable", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json(
      { error: { message: "invalid key id", type: "invalid_request_error" } },
      400
    );
  }
  await reactivateKey(c.env, id);
  return c.json({ id, status: "active" });
});

// POST /keys/:id/disable — manual disable.
app.post("/keys/:id/disable", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json(
      { error: { message: "invalid key id", type: "invalid_request_error" } },
      400
    );
  }
  await applyOutcome(
    c.env,
    id,
    { kind: "disable", reason: "manual disable" },
    { cooldownMinutes: cooldownMinutes(c.env), maxConsecutive: MAX_CONSECUTIVE_FAILS }
  );
  return c.json({ id, status: "disabled" });
});

// POST /tokens — mint an access token.
app.post("/tokens", async (c) => {
  let opts: {
    name?: string;
    role?: "admin" | "user";
    quotaRequests?: number | null;
    rpmLimit?: number | null;
    expiresAt?: number | null;
  } = {};
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await c.req.json();
      if (body !== null && typeof body === "object") {
        const b = body as {
          name?: unknown;
          role?: unknown;
          quota_requests?: unknown;
          rpm_limit?: unknown;
          expires_in_days?: unknown;
        };
        if (typeof b.name === "string") opts.name = b.name;
        if (b.role === "admin" || b.role === "user") opts.role = b.role;
        if (typeof b.quota_requests === "number" && b.quota_requests > 0) opts.quotaRequests = b.quota_requests;
        if (typeof b.rpm_limit === "number" && b.rpm_limit > 0) opts.rpmLimit = b.rpm_limit;
        if (typeof b.expires_in_days === "number" && b.expires_in_days > 0) {
          opts.expiresAt = Date.now() + b.expires_in_days * 86400000;
        }
      }
    } catch {
      return c.json(
        { error: { message: "invalid json body", type: "invalid_request_error" } },
        400
      );
    }
  }
  const created = await createToken(c.env, opts);
  return c.json(created);
});

// GET /tokens — list access tokens.
app.get("/tokens", async (c) => {
  const tokens = await listTokens(c.env);
  return c.json(tokens);
});

// DELETE /tokens/:id — permanently revoke an access token.
app.delete("/tokens/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: { message: "invalid token id", type: "invalid_request_error" } }, 400);
  }
  const ok = await deleteToken(c.env, id);
  return c.json({ ok }, ok ? 200 : 404);
});

// GET /users — list all users (pending first, newest first within group).
app.get("/users", async (c) => {
  const users = await listUsers(c.env);
  return c.json(users);
});

// POST /users/:id/approve — approve a pending/blocked user.
app.post("/users/:id/approve", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json(
      { error: { message: "invalid user id", type: "invalid_request_error" } },
      400
    );
  }
  await setUserStatus(c.env, id, "approved");
  return c.json({ ok: true });
});

// POST /users/:id/role — promote/demote a user (admin | user). Body { role }.
// Guards: only one super-admin bootstrap via ADMIN_TOKEN in practice; the UI
// hides the "取消管理员" action for the current admin so an admin can't lock
// the console out by demoting themselves.
app.post("/users/:id/role", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: { message: "invalid user id", type: "invalid_request_error" } }, 400);
  }
  let role: "admin" | "user" | null = null;
  try {
    const body: unknown = await c.req.json();
    if (body !== null && typeof body === "object") {
      const b = body as { role?: unknown };
      if (b.role === "admin" || b.role === "user") role = b.role;
    }
  } catch {
    return c.json({ error: { message: "invalid json body", type: "invalid_request_error" } }, 400);
  }
  if (!role) {
    return c.json({ error: { message: "expected { role: 'admin' | 'user' }", type: "invalid_request_error" } }, 400);
  }
  const sub = await setUserRole(c.env, id, role);
  if (!sub) return c.json({ error: { message: "user not found", type: "not_found" } }, 404);
  return c.json({ ok: true, id, role, sub });
});

// POST /users/:id/block — block a user and disable all their tokens.
app.post("/users/:id/block", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json(
      { error: { message: "invalid user id", type: "invalid_request_error" } },
      400
    );
  }
  const sub = await setUserStatus(c.env, id, "blocked");
  if (sub) await disableTokensByOwner(c.env, sub);
  return c.json({ ok: true });
});

/** Mask a secret for display: first 6 + last 4. */
function mask(key: string): string {
  if (key.length <= 12) return key.slice(0, 2) + "…" + key.slice(-2);
  return key.slice(0, 6) + "…" + key.slice(-4);
}

// GET /keys/list — every key (masked) with per-key stats for the list page.
app.get("/keys/list", async (c) => {
  const keys = await listAllKeys(c.env);
  return c.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      masked: mask(k.api_key),
      status: k.status,
      consecutive_fails: k.consecutive_fails,
      total_requests: k.total_requests,
      total_fails: k.total_fails,
      last_error: k.last_error,
      disabled_reason: k.disabled_reason,
      last_used_at: k.last_used_at,
      cooldown_until: k.cooldown_until,
      created_at: k.created_at,
      project_id: k.project_id,
      balance_remaining: k.balance_remaining,
      balance_unit: k.balance_unit,
    })),
  });
});

// GET /keys/:id/reveal — full plaintext key for admin copy. The whole /admin
// router is behind requireAdmin, so this is admin-only. Fetched on-demand per
// click so the list payload stays masked (full keys never sit in the page).
app.get("/keys/:id/reveal", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json(
      { error: { message: "invalid key id", type: "invalid_request_error" } },
      400
    );
  }
  const row = await c.env.DB.prepare(
    `SELECT api_key FROM keypool_gateway_api_keys WHERE id = ?`
  )
    .bind(id)
    .first<{ api_key: string }>();
  if (!row) {
    return c.json({ error: { message: "key not found", type: "not_found" } }, 404);
  }
  return c.json({ id, api_key: row.api_key });
});

// GET /models-status — per-model availability (probed by /probe-models).
app.get("/models-status", async (c) => {
  return c.json(await listModelStatus(c.env));
});

// POST /probe-models — probe one active key per provider against each model
// and record availability. Returns { checked, blocked }.
app.post("/probe-models", async (c) => {
  return c.json(await probeModels(c.env));
});

// POST /check-all-keys — one rotating sweep batch (back-compat alias of /sweep).
// Used by the health-check workflow / external pingers. (Outside /keys/ to avoid
// colliding with the /keys/:id param routes.)
app.post("/check-all-keys", async (c) => {
  return c.json(await runCheckAll(c.env));
});

// POST /sweep — the scale-safe rotating probe. Each call probes one batch of
// due keys and advances the cursor; `?all=1` first marks the WHOLE pool due so
// successive batches re-validate everything (the 检测全部 button), otherwise it
// only touches genuinely-stale keys (cheap background rotation for pingers/cron).
app.post("/sweep", async (c) => {
  const markAll = c.req.query("all") === "1";
  return c.json(await runSweep(c.env, { markAll }));
});

// GET /sweep-status — cheap progress read for the UI bar: { total, due }.
app.get("/sweep-status", async (c) => {
  return c.json(await sweepProgress(c.env));
});

// POST /keys/:id/chat — chat directly through ONE specific key (bypasses the
// pool; no billing, no key-health side effects). For admins to test a key.
app.post("/keys/:id/chat", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: { message: "invalid key id", type: "invalid_request_error" } }, 400);
  }
  const row = await getKeyById(c.env, id);
  if (!row) return c.json({ error: { message: "key not found", type: "not_found" } }, 404);
  const body = (await c.req.json().catch(() => null)) as
    | { messages?: unknown; model?: unknown; max_tokens?: unknown; stream?: unknown }
    | null;
  if (!body || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "messages required", type: "invalid_request_error" } }, 400);
  }
  const adapter = getAdapter(row.provider);
  const model = typeof body.model === "string" && body.model ? body.model : adapter.models()[0];
  const max_tokens = typeof body.max_tokens === "number" ? body.max_tokens : 256;
  const req: OpenAIChatRequest = {
    model,
    messages: body.messages as OpenAIChatRequest["messages"],
    max_tokens,
    stream: body.stream === true ? true : undefined,
  };
  return adapter.chatCompletions(req, row.api_key);
});

// POST /keys/prune — delete only permanently-dead keys (invalid/revoked/404).
// Arrears / 欠费 / 余额不足 are kept (they auto-recover on top-up).
app.post("/keys/prune", async (c) => {
  const removed = await prunePermanentlyDeadKeys(c.env);
  return c.json({ removed });
});

// DELETE /keys/:id — permanently remove a key.
app.delete("/keys/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: { message: "invalid key id", type: "invalid_request_error" } }, 400);
  }
  const ok = await deleteKey(c.env, id);
  return c.json({ ok }, ok ? 200 : 404);
});


// POST /keys/:id/check — live liveness + balance probe. Revives the key if alive.
app.post("/keys/:id/check", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: { message: "invalid key id", type: "invalid_request_error" } }, 400);
  }
  const row = await getKeyById(c.env, id);
  if (!row) return c.json({ error: { message: "key not found", type: "not_found" } }, 404);

  const result = await probeKey(row.provider, row.api_key);
  // A successful check brings a disabled/cooled key back into rotation AND clears
  // any stale last_error (so a "可用" key no longer shows an old error).
  if (result.alive && !result.rateLimited) {
    await reactivateKey(c.env, id);
  }
  // Persist the freshly-probed balance so the list shows it without re-probing.
  if (result.balance && result.balance.remaining != null) {
    await setKeyBalance(c.env, id, result.balance.remaining, result.balance.unit);
  }
  return c.json({ id, provider: row.provider, ...result });
});

// GET /balances — all consumers and their credit balances (admin overview).
app.get("/balances", async (c) => {
  return c.json(await listBalances(c.env));
});

// POST /balances/:sub/topup — credit a consumer's balance. Body { amount_usd, note? }.
app.post("/balances/:sub/topup", async (c) => {
  const sub = decodeURIComponent(c.req.param("sub"));
  let amountUsd = 0;
  let note: string | null = null;
  try {
    const body: unknown = await c.req.json();
    if (body !== null && typeof body === "object") {
      const b = body as { amount_usd?: unknown; note?: unknown };
      if (typeof b.amount_usd === "number" && Number.isFinite(b.amount_usd)) amountUsd = b.amount_usd;
      if (typeof b.note === "string") note = b.note;
    }
  } catch {
    return c.json(
      { error: { message: "invalid json body", type: "invalid_request_error" } },
      400
    );
  }
  if (amountUsd <= 0) {
    return c.json(
      { error: { message: "amount_usd must be positive", type: "invalid_request_error" } },
      400
    );
  }
  const balance_micro = await topUpMicro(c.env, sub, Math.round(amountUsd * 1_000_000), note);
  return c.json({ balance_micro });
});

// GET /transactions — recent transactions. ?owner=<sub> filters to one consumer.
app.get("/transactions", async (c) => {
  const sub = c.req.query("owner") || undefined;
  return c.json(await listTransactions(c.env, { sub, limit: 100 }));
});

// GET /prices — list per-model token prices (micro-USD per 1M tokens, all columns).
app.get("/prices", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT model, price_per_mtok_micro, input_per_mtok_micro, output_per_mtok_micro, cached_input_per_mtok_micro
       FROM keypool_gateway_prices ORDER BY model ASC`
  ).all();
  return c.json(
    (res.results ?? []) as unknown as Array<{
      model: string;
      price_per_mtok_micro: number;
      input_per_mtok_micro: number | null;
      output_per_mtok_micro: number | null;
      cached_input_per_mtok_micro: number | null;
    }>
  );
});

// POST /prices — upsert split input/output prices for a model.
// Body { model, input_per_mtok_micro, output_per_mtok_micro }; legacy
// { model, price_per_mtok_micro } sets both input and output to that value.
app.post("/prices", async (c) => {
  let model = "";
  let input = NaN;
  let output = NaN;
  let legacy = NaN;
  let cachedInput: number | null = null;
  try {
    const body: unknown = await c.req.json();
    if (body !== null && typeof body === "object") {
      const b = body as {
        model?: unknown;
        input_per_mtok_micro?: unknown;
        output_per_mtok_micro?: unknown;
        cached_input_per_mtok_micro?: unknown;
        price_per_mtok_micro?: unknown;
      };
      if (typeof b.model === "string") model = b.model.trim();
      if (typeof b.input_per_mtok_micro === "number" && Number.isFinite(b.input_per_mtok_micro)) {
        input = b.input_per_mtok_micro;
      }
      if (typeof b.output_per_mtok_micro === "number" && Number.isFinite(b.output_per_mtok_micro)) {
        output = b.output_per_mtok_micro;
      }
      if (typeof b.cached_input_per_mtok_micro === "number" && Number.isFinite(b.cached_input_per_mtok_micro)) {
        cachedInput = b.cached_input_per_mtok_micro;
      }
      if (typeof b.price_per_mtok_micro === "number" && Number.isFinite(b.price_per_mtok_micro)) {
        legacy = b.price_per_mtok_micro;
      }
    }
  } catch {
    return c.json(
      { error: { message: "invalid json body", type: "invalid_request_error" } },
      400
    );
  }
  // Legacy single price fills any unspecified side.
  if (Number.isFinite(legacy)) {
    if (!Number.isFinite(input)) input = legacy;
    if (!Number.isFinite(output)) output = legacy;
  }
  if (
    model.length === 0 ||
    !Number.isFinite(input) ||
    input < 0 ||
    !Number.isFinite(output) ||
    output < 0 ||
    (cachedInput !== null && cachedInput < 0)
  ) {
    return c.json(
      {
        error: {
          message:
            "expected { model: string, input_per_mtok_micro: number, output_per_mtok_micro: number, cached_input_per_mtok_micro?: number } (or legacy price_per_mtok_micro)",
          type: "invalid_request_error",
        },
      },
      400
    );
  }
  const inputMicro = Math.round(input);
  const outputMicro = Math.round(output);
  const cachedMicro = cachedInput === null ? null : Math.round(cachedInput);
  // price_per_mtok_micro is NOT NULL legacy column — keep it in sync with input.
  // cached_input_per_mtok_micro: NULL = charge cache hits at the input price;
  // an explicit value overrides on update.
  await c.env.DB.prepare(
    `INSERT INTO keypool_gateway_prices
       (model, price_per_mtok_micro, input_per_mtok_micro, output_per_mtok_micro, cached_input_per_mtok_micro)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET
       price_per_mtok_micro = excluded.price_per_mtok_micro,
       input_per_mtok_micro = excluded.input_per_mtok_micro,
       output_per_mtok_micro = excluded.output_per_mtok_micro,
       cached_input_per_mtok_micro = COALESCE(excluded.cached_input_per_mtok_micro,
                                              keypool_gateway_prices.cached_input_per_mtok_micro)`
  )
    .bind(model, inputMicro, inputMicro, outputMicro, cachedMicro)
    .run();
  return c.json({
    model,
    price_per_mtok_micro: inputMicro,
    input_per_mtok_micro: inputMicro,
    output_per_mtok_micro: outputMicro,
    cached_input_per_mtok_micro: cachedMicro,
  });
});

export default app;
