/** Cron body: revive expired cooldowns + probe disabled keys back to health. */

import type { Env, Provider } from "./types";
import { reviveExpiredCooldowns, listDisabledForProbe, reactivateKey, cleanupOldRecords } from "./db";
import { getAdapter } from "./providers/index";

/** Default minutes between cron probes of a single disabled key. */
const DEFAULT_PROBE_INTERVAL_MINUTES = 60;

/** Max disabled keys to probe in a single cron tick (keep the run cheap). */
const PROBE_BATCH_LIMIT = 20;

/** A lightweight, auth-requiring GET per provider used as the revive probe. */
const PROBE_PATH: Record<Provider, string> = {
  gemini: "/v1beta/models",
  mistral: "/v1/models",
  openrouter: "/v1/models",
  openai: "/v1/models",
  deepseek: "/v1/models",
  groq: "/v1/models",
  moonshot: "/v1/models",
  glm: "/models",
  qwen: "/v1/models",
  deepinfra: "/models",
  fireworks: "/models",
  cerebras: "/models",
  ai21: "/models",
  cohere: "/models",
  elevenlabs: "/v1/user",
  stability: "/v1/user/account",
  channel: "/v1/models", // channels never probed; placeholder keeps Record<Provider> total
};

function probeIntervalMs(env: Env): number {
  const raw = env.PROBE_INTERVAL_MINUTES;
  const minutes = raw != null ? Number.parseInt(raw, 10) : NaN;
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PROBE_INTERVAL_MINUTES;
  return safe * 60000;
}

/**
 * Bump a disabled key's `last_used_at` so `listDisabledForProbe` backs it off
 * until the next probe interval. Best-effort; never throws.
 */
async function backOffKey(env: Env, keyId: number, now: number): Promise<void> {
  try {
    await env.DB.prepare(`UPDATE keypool_gateway_api_keys SET last_used_at = ? WHERE id = ?`)
      .bind(now, keyId)
      .run();
  } catch {
    // Backing off is best-effort; a failed write just means it retries sooner.
  }
}

/**
 * Runs on the cron trigger.
 *  1) reviveExpiredCooldowns(env, now)
 *  2) for each disabled key eligible for a probe, send the provider's cheapest
 *     auth-requiring GET with that key; 2xx -> reactivateKey, else back off.
 * Each probe is wrapped in try/catch; this never throws out of scheduled().
 */
export async function runHealthCheck(
  env: Env
): Promise<{ revived: number; probed: number; reactivated: number; cleaned: { transactions: number; orders: number; logs: number } }> {
  const now = Date.now();

  // Retention cleanup (transactions / orders / logs) — throttled to 1x/day.
  let cleaned = { transactions: 0, orders: 0, logs: 0 };
  try {
    cleaned = await cleanupOldRecords(env);
  } catch {
    // A failed cleanup must not abort the revive/probe phases.
  }

  let revived = 0;
  try {
    revived = await reviveExpiredCooldowns(env, now);
  } catch {
    // A failed revive sweep must not abort the probe phase.
  }

  let probed = 0;
  let reactivated = 0;

  let candidates: Awaited<ReturnType<typeof listDisabledForProbe>> = [];
  try {
    candidates = await listDisabledForProbe(env, now, probeIntervalMs(env), PROBE_BATCH_LIMIT);
  } catch {
    candidates = [];
  }

  for (const key of candidates) {
    probed++;
    try {
      const adapter = getAdapter(key.provider);
      const subPath = PROBE_PATH[key.provider];
      const probeReq = new Request(`https://probe.invalid${subPath}`, { method: "GET" });
      const res = await adapter.passthrough(subPath, probeReq, key.api_key);

      // Drain the body so the upstream connection can be released.
      try {
        await res.body?.cancel();
      } catch {
        // ignore body-cancel failures
      }

      if (res.status >= 200 && res.status < 300) {
        await reactivateKey(env, key.id);
        reactivated++;
      } else {
        await backOffKey(env, key.id, now);
      }
    } catch {
      // Network error / adapter throw: treat as still-unhealthy and back off.
      await backOffKey(env, key.id, now);
    }
  }

  return { revived, probed, reactivated, cleaned };
}
