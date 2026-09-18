/** Error classification + the callWithPool dispatcher (retry across keys, apply health outcomes). */

import type { Env, Provider, Outcome } from "./types";
import {
  listActiveKeys,
  recordSuccess,
  applyOutcome,
  logRequest,
  reviveExpiredCooldowns,
  updateLogUsage,
  chargeForUsage,
} from "./db";

export const DEFAULT_COOLDOWN_MINUTES = 15;
export const DEFAULT_MAX_RETRIES = 4;
export const MAX_CONSECUTIVE_FAILS = 3;
/** Per-day quota errors won't recover for hours — cool them down this long. */
export const DAILY_COOLDOWN_MINUTES = 360;

const DISABLE_RE =
  /api[_ ]?key.*(not valid|invalid)|invalid.*api[_ ]?key|unauthor|permission denied|API_KEY_INVALID|arrearage|overdue|欠费|account.*(suspend|not in good standing)|insufficient.*(balance|credit|fund)|余额不足/i;
const COOLDOWN_RE =
  /quota|rate.?limit|exhaust|RESOURCE_EXHAUSTED|too many requests/i;

/** Helpers reading env numbers with the defaults above. */
export function cooldownMinutes(env: Env): number {
  const n = Number(env.COOLDOWN_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_MINUTES;
}

export function maxRetries(env: Env): number {
  const n = Number(env.MAX_KEY_RETRIES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RETRIES;
}

/** Classify an upstream HTTP result into a key-health Outcome. */
export function classifyError(status: number, bodyText: string): Outcome {
  if (status >= 200 && status <= 299) {
    return { kind: "ok" };
  }

  const body = bodyText || "";

  if (status === 401 || status === 403 || DISABLE_RE.test(body)) {
    return {
      kind: "disable",
      reason: `http ${status}: ${snippet(body)}`,
    };
  }

  if (status === 429 || (status === 400 && COOLDOWN_RE.test(body))) {
    // A per-DAY quota won't recover for hours; cool it down long so it doesn't
    // flap green->429->green. A per-minute limit uses the short default (minutes:0).
    const daily = /per[\s-]?day|requests per day|daily limit|RPD|per-day/i.test(body);
    return {
      kind: "cooldown",
      minutes: daily ? DAILY_COOLDOWN_MINUTES : 0, // 0 = filled by caller (short)
      reason: `http ${status}: ${snippet(body)}`,
    };
  }

  // Any other 4xx (likely caller error, not key death), 5xx, or network.
  return {
    kind: "transient",
    reason: `http ${status}: ${snippet(body)}`,
  };
}

function snippet(s: string): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > 300 ? t.slice(0, 300) : t;
}

/** Normalized token usage extracted from a response body or a single SSE frame. */
export interface ExtractedUsage {
  prompt: number | null;
  completion: number | null;
  total: number | null;
  /** Cache-hit prompt tokens (OpenAI cached_tokens / Anthropic cache_read /
   *  Gemini cachedContentTokenCount). Null = provider didn't report any. */
  cached: number | null;
  /** True when `prompt` ALREADY includes the cached tokens (OpenAI/Gemini);
   *  false when they are reported separately (Anthropic cache_read). This
   *  decides whether pricing subtracts them from the uncached input bucket. */
  cachedInsidePrompt: boolean;
}

const EMPTY_USAGE: ExtractedUsage = {
  prompt: null,
  completion: null,
  total: null,
  cached: null,
  cachedInsidePrompt: true,
};

/**
 * Pull a usage object out of an OpenAI-shaped body/frame
 * (`usage.{prompt_tokens,completion_tokens,total_tokens}`) or a Gemini-shaped
 * one (`usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount}`).
 * Returns all-null when no usage is present.
 */
export function extractUsage(jsonOrFrame: unknown): ExtractedUsage {
  const o = jsonOrFrame as
    | {
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown } | null;
          // Anthropic usage (also surfaces in Anthropic-stream SSE frames)
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
        } | null;
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
          totalTokenCount?: unknown;
          cachedContentTokenCount?: unknown;
        } | null;
      }
    | null
    | undefined;

  if (o && o.usage) {
    const u = o.usage;
    // OpenAI: cached_tokens is a subset of prompt_tokens (inside).
    const openaiCached =
      u.prompt_tokens_details && typeof u.prompt_tokens_details.cached_tokens === "number"
        ? u.prompt_tokens_details.cached_tokens
        : null;
    // Anthropic: cache_read tokens are reported SEPARATELY from input_tokens.
    const anthropicCached =
      typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : null;
    const hasOpenAI = u.prompt_tokens !== undefined || u.completion_tokens !== undefined;
    const hasAnthropic = u.input_tokens !== undefined || u.output_tokens !== undefined;
    const cached = openaiCached ?? anthropicCached;
    return {
      prompt: typeof u.prompt_tokens === "number"
        ? u.prompt_tokens
        : typeof u.input_tokens === "number"
          ? u.input_tokens
          : null,
      completion: typeof u.completion_tokens === "number"
        ? u.completion_tokens
        : typeof u.output_tokens === "number"
          ? u.output_tokens
          : null,
      total: typeof u.total_tokens === "number" ? u.total_tokens : null,
      cached,
      cachedInsidePrompt: hasOpenAI ? true : hasAnthropic ? false : true,
    };
  }

  if (o && o.usageMetadata) {
    const m = o.usageMetadata;
    const cached = typeof m.cachedContentTokenCount === "number" ? m.cachedContentTokenCount : null;
    return {
      prompt: typeof m.promptTokenCount === "number" ? m.promptTokenCount : null,
      completion: typeof m.candidatesTokenCount === "number" ? m.candidatesTokenCount : null,
      total: typeof m.totalTokenCount === "number" ? m.totalTokenCount : null,
      cached,
      // Gemini's promptTokenCount includes the cached content.
      cachedInsidePrompt: cached !== null,
    };
  }

  return { ...EMPTY_USAGE };
}

/** Merge a later SSE frame's usage into an earlier one, keeping earlier
 *  non-null fields the later frame didn't report (Anthropic streams split
 *  input_tokens into message_start and output_tokens into message_delta —
 *  naive overwrite would silently drop the prompt count). */
export function mergeUsage(prev: ExtractedUsage | null, next: ExtractedUsage): ExtractedUsage {
  if (!prev) return next;
  const cached = next.cached ?? prev.cached;
  return {
    prompt: next.prompt ?? prev.prompt,
    completion: next.completion ?? prev.completion,
    total: next.total ?? prev.total,
    cached,
    cachedInsidePrompt: cached !== null ? next.cachedInsidePrompt : prev.cachedInsidePrompt,
  };
}

/** True when an extracted usage carries at least one token count. */
function hasUsage(u: ExtractedUsage): boolean {
  return u.prompt !== null || u.completion !== null || u.total !== null;
}

/**
 * Core dispatcher. Picks active keys for `provider` and calls `attempt(key)`.
 * For 2xx responses (including streams) the Response is returned untouched —
 * its body is never read here. Only non-2xx responses are cloned and read to
 * classify the key's health.
 */
export async function callWithPool(
  env: Env,
  provider: Provider,
  attempt: (key: string) => Promise<Response>,
  meta?: {
    model?: string;
    tokenId?: number | null;
    ownerSub?: string | null;
    promptChars?: number;
    ctx?: { waitUntil(promise: Promise<unknown>): void };
    /** Max pooled keys to try this call (fallback providers pass a small value). */
    maxKeys?: number;
    /** When false, the terminal FAILURE log row is written final=0 (the caller
     *  owns writing the single final row — used by the fallback chain so one
     *  user request isn't counted once per attempted provider). Default true. */
    finalOnFailure?: boolean;
  }
): Promise<Response> {
  const model = meta?.model ?? null;
  const tokenId = meta?.tokenId ?? null;
  const ownerSub = meta?.ownerSub ?? null;
  const promptChars = meta?.promptChars ?? null;
  const ctx = meta?.ctx ?? null;
  const finalOnFailure = meta?.finalOnFailure ?? true;
  let keys = await listActiveKeys(env, provider);

  // Inline unattended recovery: with no CF cron available, revive any keys whose
  // cooldown has expired and retry once before declaring the pool empty.
  if (keys.length === 0) {
    const revived = await reviveExpiredCooldowns(env, Date.now());
    if (revived > 0) {
      keys = await listActiveKeys(env, provider);
    }
  }

  if (keys.length === 0) {
    await logRequest(env, {
      provider, keyId: null, model, tokenId, ownerSub,
      statusCode: null, latencyMs: null, ok: false, final: finalOnFailure,
    });
    return noKeysResponse(provider);
  }

  // Cap key attempts; a fallback provider passes a smaller maxKeys so it fails
  // fast instead of burning 4 round-trips on a throttled pool.
  const cap = meta?.maxKeys && meta.maxKeys > 0 ? meta.maxKeys : maxRetries(env);
  const limit = Math.max(1, Math.min(cap, maxRetries(env)));
  const coolMins = cooldownMinutes(env);
  const opts = {
    cooldownMinutes: coolMins,
    maxConsecutive: MAX_CONSECUTIVE_FAILS,
  };

  let attempts = 0;
  let lastStatus: number | null = null;

  for (const key of keys) {
    if (attempts >= limit) break;
    attempts++;

    const started = Date.now();
    let res: Response;
    try {
      res = await attempt(key.api_key);
    } catch (err) {
      // Network / fetch failure — treat as transient and try the next key.
      const latencyMs = Date.now() - started;
      const reason = `network error: ${String(
        err instanceof Error ? err.message : err
      )}`;
      await applyOutcome(env, key.id, { kind: "transient", reason }, opts);
      await logRequest(env, {
        provider,
        keyId: key.id,
        model,
        tokenId,
        ownerSub,
        statusCode: null,
        latencyMs,
        ok: false,
        final: false,
      });
      continue;
    }

    const latencyMs = Date.now() - started;
    const status = res.status;

    // Success (including streaming).
    if (status >= 200 && status <= 299) {
      await recordSuccess(env, key.id);
      const ct = res.headers.get("content-type") || "";

      // Streaming (SSE): tee the body so we can return one half to the caller
      // and scan the other half in the background for usage tokens.
      if (ct.includes("text/event-stream") && res.body) {
        const [clientStream, scanStream] = res.body.tee();
        const logId = await logRequest(env, {
          provider,
          keyId: key.id,
          model,
          tokenId,
          ownerSub,
          statusCode: status,
          latencyMs,
          ok: true,
          totalTokens: null,
          final: true,
        });
        const clientResponse = new Response(clientStream, {
          status,
          headers: res.headers,
        });
        const scan = scanStreamForUsage(
          env,
          scanStream,
          logId,
          ownerSub,
          model,
          promptChars
        );
        if (ctx) {
          ctx.waitUntil(scan);
        } else {
          void scan;
        }
        return clientResponse;
      }

      // Non-streaming body: bill from the usage object when present, else
      // estimate from prompt + response character counts (~4 chars/token).
      let usage: ExtractedUsage = { ...EMPTY_USAGE };
      try {
        usage = extractUsage(await res.clone().json());
      } catch {
        // not JSON / parse error — fall through to estimation
      }

      let promptTokens: number;
      let completionTokens: number;
      let estimated: boolean;
      let uncachedPrompt = 0;
      let cachedPrompt = 0;
      if (hasUsage(usage)) {
        promptTokens = usage.prompt ?? 0;
        completionTokens = usage.completion ?? 0;
        estimated = false;
        // Split cache-hit input tokens for tiered pricing. Log the raw counts;
        // bill the cache-hit portion at the cached-input price.
        if (usage.cached && usage.cached > 0) {
          if (usage.cachedInsidePrompt) {
            cachedPrompt = Math.min(usage.cached, promptTokens);
            uncachedPrompt = promptTokens - cachedPrompt;
          } else {
            cachedPrompt = usage.cached;
            uncachedPrompt = promptTokens;
          }
        } else {
          uncachedPrompt = promptTokens;
        }
      } else {
        estimated = true;
        promptTokens = promptChars ? Math.ceil(promptChars / 4) : 0;
        uncachedPrompt = promptTokens;
        let completionChars = 0;
        try {
          completionChars = (await res.clone().text()).length;
        } catch {
          completionChars = 0;
        }
        completionTokens = Math.ceil(completionChars / 4);
      }
      const totalTokens = usage.total ?? promptTokens + completionTokens;

      await logRequest(env, {
        provider,
        keyId: key.id,
        model,
        tokenId,
        ownerSub,
        statusCode: status,
        latencyMs,
        ok: true,
        promptTokens,
        completionTokens,
        totalTokens,
        final: true,
      });
      await chargeForUsage(
        env,
        ownerSub,
        model,
        uncachedPrompt,
        cachedPrompt,
        completionTokens,
        estimated
      );
      return res;
    }

    // Non-2xx: read the body via a clone so we never disturb the original.
    let bodyText = "";
    try {
      bodyText = await res.clone().text();
    } catch {
      bodyText = "";
    }

    let outcome = classifyError(status, bodyText);
    if (outcome.kind === "cooldown" && outcome.minutes <= 0) {
      outcome = { ...outcome, minutes: coolMins };
    }

    await applyOutcome(env, key.id, outcome, opts);
    lastStatus = status;
    await logRequest(env, {
      provider,
      keyId: key.id,
      model,
      tokenId,
      ownerSub,
      statusCode: status,
      latencyMs,
      ok: false,
      final: false,
    });

    // Move on to the next key (re-fetch happens inside attempt()).
  }

  await logRequest(env, {
    provider, keyId: null, model, tokenId, ownerSub,
    statusCode: lastStatus, latencyMs: null, ok: false, final: finalOnFailure,
  });
  return exhaustedResponse(provider);
}

/**
 * Read an SSE stream to its end, parse `data:` lines for a usage frame
 * (OpenAI-shaped `usage` or Gemini `usageMetadata`), accumulate the streamed
 * assistant content, then persist usage to the log row and charge the owner.
 * When no usage frame is present, estimate from the prompt + accumulated
 * content character counts (~4 chars/token). Best-effort: never throws.
 */
export async function scanStreamForUsage(
  env: Env,
  stream: ReadableStream<Uint8Array>,
  logId: number | null,
  ownerSub: string | null,
  model: string | null,
  promptChars: number | null
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: ExtractedUsage | null = null;
  let contentChars = 0; // accumulated delta.content text length
  let totalChars = 0; // fallback proxy: all decoded chars

  const tryParse = (jsonText: string): void => {
    const trimmed = jsonText.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      const u = extractUsage(obj);
      if (hasUsage(u)) {
        // Merge, don't overwrite: Anthropic streams report input_tokens in
        // message_start and output_tokens in message_delta — the last frame
        // alone would drop the prompt count (and its cache split).
        usage = mergeUsage(usage, u);
      }
      // Accumulate streamed assistant content (OpenAI `choices[].delta.content`).
      const choices = (obj as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
      if (Array.isArray(choices)) {
        for (const ch of choices) {
          const dc = ch?.delta?.content;
          if (typeof dc === "string") contentChars += dc.length;
        }
      }
    } catch {
      // non-JSON data line; ignore
    }
  };

  const consumeLines = (): void => {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const t = line.replace(/\r$/, "").trim();
      if (t.startsWith("data:")) {
        tryParse(t.slice(5));
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      totalChars += chunk.length;
      buffer += chunk;
      consumeLines();
    }
    const tail = decoder.decode();
    totalChars += tail.length;
    buffer += tail;
    consumeLines();
  } catch {
    // stream errors are non-fatal for accounting
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  if (usage !== null) {
    const found: ExtractedUsage = usage;
    const prompt = found.prompt ?? 0;
    const completion = found.completion ?? 0;
    const total = found.total ?? prompt + completion;
    let uncachedPrompt = prompt;
    let cachedPrompt = 0;
    if (found.cached && found.cached > 0) {
      if (found.cachedInsidePrompt) {
        cachedPrompt = Math.min(found.cached, prompt);
        uncachedPrompt = prompt - cachedPrompt;
      } else {
        cachedPrompt = found.cached;
      }
    }
    if (logId !== null) {
      await updateLogUsage(env, logId, prompt, completion, total);
    }
    await chargeForUsage(env, ownerSub, model, uncachedPrompt, cachedPrompt, completion, false);
  } else {
    const prompt = promptChars ? Math.ceil(promptChars / 4) : 0;
    const completionChars = contentChars > 0 ? contentChars : totalChars;
    const completion = Math.ceil(completionChars / 4);
    const total = prompt + completion;
    if (logId !== null) {
      await updateLogUsage(env, logId, prompt, completion, total);
    }
    await chargeForUsage(env, ownerSub, model, prompt, 0, completion, true);
  }
}

function jsonError(status: number, message: string, type: string): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noKeysResponse(provider: Provider): Response {
  return jsonError(
    503,
    `no active keys available for provider "${provider}"`,
    "no_keys_available"
  );
}

function exhaustedResponse(provider: Provider): Response {
  return jsonError(
    503,
    `all keys for provider "${provider}" failed or are unavailable`,
    "upstream_unavailable"
  );
}
