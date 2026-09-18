/**
 * Shared key probing. `probeKey` does a per-provider liveness/balance check
 * (chat-based where /models would lie about a suspended/arrears account);
 * `runCheckAll` probes every key and auto-revives the healthy ones / auto-
 * disables the dead ones. Used by the admin "检测全部" button, the per-key
 * "测活", and the scheduled (cron) auto health-check.
 */

import type { Env, Provider } from "./types";
import { PROVIDERS } from "./types";
import { listDueForProbe, markProbed, markAllDueForProbe, getProbeProgress, reactivateKey, applyOutcome, setKeyProjectId, setKeyBalance, setModelStatus, oneActiveKey } from "./db";
import { getAdapter } from "./providers";
import { cooldownMinutes, MAX_CONSECUTIVE_FAILS } from "./keypool";

/** Truncate an upstream error body for a compact status reason. */
function snippet(body: string, max = 200): string {
  const s = (body || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export interface KeyBalance {
  remaining: number | null;
  total: number | null;
  usage: number | null;
  unit: string;
}

export interface ProbeResult {
  alive: boolean;
  status: number;
  rateLimited: boolean;
  balance: KeyBalance | null;
  error?: string;
  /** Google project number parsed from a gemini error body, when present. */
  projectId?: string;
}

/** Live-probe one key. OpenRouter/DeepSeek also return real balance. */
export async function probeKey(provider: Provider, key: string): Promise<ProbeResult> {
  try {
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${key}` } });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      const j = (await r.json().catch(() => null)) as { data?: { total_credits?: number; total_usage?: number } } | null;
      const total = j?.data?.total_credits ?? null;
      const usage = j?.data?.total_usage ?? null;
      const remaining = total !== null && usage !== null ? total - usage : null;
      const alive = r.ok && (remaining === null || remaining > 0);
      return { alive, status: r.status, rateLimited: false, balance: { remaining, total, usage, unit: "credits" }, error: alive ? undefined : "余额不足" };
    }
    if (provider === "mistral") {
      const r = await fetch("https://api.mistral.ai/v1/models", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "deepseek") {
      const r = await fetch("https://api.deepseek.com/user/balance", { headers: { authorization: `Bearer ${key}` } });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      if (!r.ok) return { alive: false, status: r.status, rateLimited: r.status === 429, balance: null, error: `http ${r.status}` };
      const j = (await r.json().catch(() => null)) as { balance_infos?: Array<{ total_balance?: string | number; currency?: string }> } | null;
      const info = j?.balance_infos?.[0] ?? null;
      const remaining = info && info.total_balance != null ? Number(info.total_balance) : null;
      const unit = info?.currency ?? "USD";
      return { alive: true, status: r.status, rateLimited: false, balance: { remaining, total: null, usage: null, unit } };
    }
    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "moonshot") {
      const r = await fetch("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshot-v1-8k", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const arrears = /insufficient|balance|余额|exceeded_current_quota/i.test(t);
        return { alive: false, status: r.status, rateLimited: r.status === 429 && !arrears, balance: null, error: arrears ? "欠费/余额不足" : `http ${r.status}` };
      }
      return { alive: true, status: r.status, rateLimited: false, balance: null };
    }
    if (provider === "qwen") {
      const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen-turbo", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const arrears = /arrearage|overdue|欠费|insufficient/i.test(t);
        return { alive: false, status: r.status, rateLimited: r.status === 429, balance: null, error: arrears ? "欠费/余额不足" : `http ${r.status}` };
      }
      return { alive: true, status: r.status, rateLimited: false, balance: null };
    }
    if (provider === "glm") {
      const r = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "deepinfra") {
      // GET /models returns 200 even for an account with no payment method, so it
      // lies about usability. Probe real inference: 402 = 欠费/需付款, 401/403 =
      // dead key. DeepInfra exposes no balance API (only the web console does), so
      // balance stays null — we can only surface the usable/unusable verdict.
      const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-llama/Meta-Llama-3.1-8B-Instruct", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      if (r.status === 402) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "欠费/需付款" };
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const arrears = /payment|insufficient|balance|欠费|prohibited/i.test(t);
        return { alive: false, status: r.status, rateLimited: r.status === 429 && !arrears, balance: null, error: arrears ? "欠费/需付款" : `http ${r.status}` };
      }
      return { alive: true, status: r.status, rateLimited: false, balance: null };
    }
    if (provider === "fireworks") {
      const r = await fetch("https://api.fireworks.ai/inference/v1/models", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "cerebras") {
      const r = await fetch("https://api.cerebras.ai/v1/models", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "cohere") {
      const r = await fetch("https://api.cohere.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "ai21") {
      const r = await fetch("https://api.ai21.com/studio/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jamba-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key" };
      // 400/422 = auth ok, body quibble; still a live key.
      const alive = r.ok || r.status === 400 || r.status === 422 || r.status === 429;
      return { alive, status: r.status, rateLimited: r.status === 429, balance: null, error: alive ? undefined : `http ${r.status}` };
    }
    if (provider === "elevenlabs") {
      const r = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": key } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    if (provider === "stability") {
      const r = await fetch("https://api.stability.ai/v1/user/account", { headers: { authorization: `Bearer ${key}` } });
      return { alive: r.ok, status: r.status, rateLimited: r.status === 429, balance: null, error: r.ok ? undefined : `http ${r.status}` };
    }
    // gemini — /v1beta/models is NOT rate-limited and lies about usability, so
    // probe the actual generateContent path with a 1-token request.
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      }
    );
    const rateLimited = r.status === 429; // valid key, just throttled (per-minute/day)
    const alive = r.ok || rateLimited;
    let projectId: string | undefined;
    if (!r.ok) {
      // Read the body once: parse the Google project number out of the error.
      const body = await r.text().catch(() => "");
      const m = /project_number:(\d+)/.exec(body);
      if (m) projectId = m[1];
    }
    if (r.status === 401 || r.status === 403) return { alive: false, status: r.status, rateLimited: false, balance: null, error: "invalid key", projectId };
    return { alive, status: r.status, rateLimited, balance: null, error: r.ok ? undefined : rateLimited ? "限流" : `http ${r.status}`, projectId };
  } catch (err) {
    return { alive: false, status: 0, rateLimited: false, balance: null, error: String(err instanceof Error ? err.message : err) };
  }
}

/** Default minutes before a probed key becomes "due" for another probe. */
const DEFAULT_PROBE_INTERVAL_MINUTES = 60;

function probeIntervalMs(env: Env): number {
  const raw = env.PROBE_INTERVAL_MINUTES;
  const m = raw != null ? Number.parseInt(raw, 10) : NaN;
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_PROBE_INTERVAL_MINUTES) * 60000;
}

export interface SweepResult {
  checked: number;
  alive: number;
  dead: number;
  /** total keys in the pool */
  total: number;
  /** keys still due for a probe after this batch (0 = pool fully swept) */
  due: number;
  /** true while keys remain due (more batches needed to cover the pool) */
  capped: boolean;
}

/**
 * One rotating sweep batch — the scale-safe primitive that both the
 * 检测全部 button (polled) and the external pinger / cron tick call.
 *
 * A single Worker invocation can't probe an unbounded pool (free tier caps
 * outbound subrequests at ~50), so each call probes at most `limit` keys that
 * are *due* (never probed, or probed > PROBE_INTERVAL ago), least-recently-
 * probed first, spread across providers. It advances `last_probed_at` for the
 * whole batch so successive calls roll through the rest. With `markAll`, every
 * key is first marked due (the button) so the next batches re-validate the
 * entire pool; without it, only genuinely-stale keys are touched (cheap
 * background rotation — active keys are validated for free by real traffic).
 */
export async function runSweep(
  env: Env,
  opts: { markAll?: boolean; limit?: number } = {}
): Promise<SweepResult> {
  const limit = opts.limit ?? 48;
  if (opts.markAll) await markAllDueForProbe(env);
  const now = Date.now();
  const intervalMs = probeIntervalMs(env);
  const subset = await listDueForProbe(env, { limit, intervalMs, now });
  const results = await Promise.all(
    subset.map(async (k) => {
      try {
        const r = await probeKey(k.provider, k.api_key);
        if (r.projectId) await setKeyProjectId(env, k.id, r.projectId);
        if (r.balance && r.balance.remaining != null) {
          await setKeyBalance(env, k.id, r.balance.remaining, r.balance.unit);
        }
        if (r.alive && !r.rateLimited) {
          // Healthy: ensure active AND clear any stale last_error (e.g. a glm key
          // that errored on a paid model but works for the free one).
          await reactivateKey(env, k.id);
        } else if (r.rateLimited && k.status === "active") {
          // Valid key but can't serve right now — cool it down so it shows as
          // 'cooldown' (not a misleading green 'active') and is skipped until it
          // recovers; inline revive brings it back when cooldown_until passes.
          await applyOutcome(
            env,
            k.id,
            { kind: "cooldown", minutes: cooldownMinutes(env), reason: r.error || "rate limited" },
            { cooldownMinutes: cooldownMinutes(env), maxConsecutive: MAX_CONSECUTIVE_FAILS }
          );
        } else if (!r.alive && !r.rateLimited && k.status === "active") {
          await applyOutcome(
            env,
            k.id,
            { kind: "disable", reason: r.error || `http ${r.status}` },
            { cooldownMinutes: cooldownMinutes(env), maxConsecutive: MAX_CONSECUTIVE_FAILS }
          );
        }
        return r.alive && !r.rateLimited;
      } catch {
        return false;
      }
    })
  );
  // Advance the cursor for the whole batch (alive or dead) so the next sweep
  // rotates to the next slice instead of re-probing these.
  await markProbed(env, subset.map((k) => k.id), now);
  const alive = results.filter(Boolean).length;
  const { total, due } = await getProbeProgress(env, intervalMs, now);
  return { checked: results.length, alive, dead: results.length - alive, total, due, capped: due > 0 };
}

/** Back-compat alias: one rotating batch. Used by the cron tick and the
 *  /admin/check-all-keys endpoint (external pingers / health-check workflow). */
export function runCheckAll(env: Env): Promise<SweepResult> {
  return runSweep(env, {});
}

/** Cheap read for the UI progress bar / pinger: { total, due }. */
export function sweepProgress(env: Env): Promise<{ total: number; due: number }> {
  return getProbeProgress(env, probeIntervalMs(env), Date.now());
}

/**
 * Probe model-level availability: for each provider with an active key, send a
 * 1-token chat to each model. 2xx or 429 means the model itself works (just
 * throttled); any other non-2xx marks the model unavailable with a reason
 * snippet (e.g. glm '余额不足/无资源包', or a 404/400 model-not-found). Capped at
 * ~40 upstream calls and each call is isolated in try/catch so one failure
 * never aborts the sweep. Cheap enough to run from the health check.
 */
export async function probeModels(env: Env): Promise<{ checked: number; blocked: number }> {
  const MAX_CALLS = 40;
  let checked = 0;
  let blocked = 0;
  for (const provider of PROVIDERS) {
    if (checked >= MAX_CALLS) break;
    const key = await oneActiveKey(env, provider);
    if (!key) continue;
    const adapter = getAdapter(provider);
    const models = adapter.models().slice(0, Math.max(0, MAX_CALLS - checked));
    for (const model of models) {
      if (checked >= MAX_CALLS) break;
      checked++;
      try {
        const r = await adapter.chatCompletions(
          { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
          key
        );
        if (r.ok || r.status === 429) {
          await setModelStatus(env, model, provider, true, null);
        } else {
          const body = await r.text().catch(() => "");
          await setModelStatus(env, model, provider, false, snippet(body) || `http ${r.status}`);
          blocked++;
        }
      } catch (err) {
        await setModelStatus(env, model, provider, false, snippet(String(err instanceof Error ? err.message : err)));
        blocked++;
      }
    }
  }
  return { checked, blocked };
}
