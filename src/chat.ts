/**
 * Shared chat dispatch (manual-channel mode): a request's `model` resolves to
 * every enabled channel that registered it; channels are tried in order until
 * one returns 2xx. The winning response is billed from upstream usage (streamed
 * usage scanned in the background), with a balance reserve/refund hold.
 * Returns an OpenAI-shaped Response (stream or JSON) with X-KeyPool-* headers.
 * Used by both the OpenAI route (/v1/chat/completions) and the Anthropic route
 * (/v1/messages, which translates around it).
 */

import type { Env } from "./types";
import { listChannelRoutes } from "./db";
import { extractUsage, scanStreamForUsage } from "./keypool";
import type { ExtractedUsage } from "./keypool";
import type { OpenAIChatRequest } from "./providers/types";
import {
  incrementTokenUse,
  billingEnabled,
  logRequest,
  estimateMaxCostMicro,
  reserveBalance,
  refundBalance,
  chargeForUsage,
  getBalanceMicro,
} from "./db";

export interface Caller {
  tokenId: number | null;
  ownerSub: string | null;
}

export interface ChannelRoute {
  channel_id: number;
  name: string;
  base_url: string;
  api_key: string;
  model_id: string;
}

const EMPTY_USAGE: ExtractedUsage = {
  prompt: null,
  completion: null,
  total: null,
  cached: null,
  cachedInsidePrompt: true,
};

function hasUsage(u: ExtractedUsage): boolean {
  return u.prompt !== null || u.completion !== null || u.total !== null;
}

function jsonError(status: number, message: string, type: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: { message, type, ...extra } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Render micro-USD as a compact $ amount for error hints. */
function usdMicro(m: number): string {
  const d = m / 1e6;
  return d >= 1 ? "$" + d.toFixed(2) : "$" + d.toFixed(4);
}

/** Build the upstream URL. Accepted base_url shapes:
 *  - "https://api.example.com"            → + /v1/chat/completions
 *  - "https://api.example.com/v1"         → + /chat/completions
 *  - "https://api.example.com/v1/chat/completions" → used as-is
 */
function upstreamUrl(baseUrl: string): string {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * Fire one channel attempt. On success (2xx) it bills from usage (streaming:
 * background scan; non-streaming: inline) and returns the untouched Response.
 * On failure it logs a non-final row and returns the upstream Response so the
 * caller can try the next channel.
 */
async function channelAttempt(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  route: ChannelRoute,
  body: OpenAIChatRequest,
  caller: Caller,
  promptChars: number,
  final: boolean
): Promise<Response> {
  const started = Date.now();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${route.api_key}`,
  };
  let res: Response;
  try {
    res = await fetch(upstreamUrl(route.base_url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    await logRequest(env, {
      provider: "channel",
      keyId: null,
      model: body.model,
      statusCode: null,
      latencyMs: Date.now() - started,
      ok: false,
      tokenId: caller.tokenId,
      ownerSub: caller.ownerSub,
      final,
    });
    return jsonError(
      502,
      `渠道「${route.name}」网络错误: ${String(err instanceof Error ? err.message : err)}`,
      "upstream_error"
    );
  }

  const latencyMs = Date.now() - started;
  const status = res.status;

  if (status >= 200 && status <= 299) {
    const ct = res.headers.get("content-type") || "";

    // Streaming (SSE): return one half, scan the other for usage.
    if (ct.includes("text/event-stream") && res.body) {
      const [clientStream, scanStream] = res.body.tee();
      const logId = await logRequest(env, {
        provider: "channel",
        keyId: null,
        model: body.model,
        statusCode: status,
        latencyMs,
        ok: true,
        totalTokens: null,
        tokenId: caller.tokenId,
        ownerSub: caller.ownerSub,
        final: true,
      });
      ctx.waitUntil(
        scanStreamForUsage(env, scanStream, logId, caller.ownerSub, body.model, promptChars)
      );
      return new Response(clientStream, { status, headers: res.headers });
    }

    // Non-streaming: bill from the usage object when present, else estimate.
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
      provider: "channel",
      keyId: null,
      model: body.model,
      statusCode: status,
      latencyMs,
      ok: true,
      promptTokens,
      completionTokens,
      totalTokens,
      tokenId: caller.tokenId,
      ownerSub: caller.ownerSub,
      final: true,
    });
    await chargeForUsage(env, caller.ownerSub, body.model, uncachedPrompt, cachedPrompt, completionTokens, estimated);
    return res;
  }

  // Failure — try the next channel.
  await logRequest(env, {
    provider: "channel",
    keyId: null,
    model: body.model,
    statusCode: status,
    latencyMs,
    ok: false,
    tokenId: caller.tokenId,
    ownerSub: caller.ownerSub,
    final,
  });
  return res;
}

export async function serveChat(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  body: OpenAIChatRequest,
  caller: Caller
): Promise<Response> {
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) {
    return jsonError(400, "missing required field: model", "invalid_request_error");
  }

  const routes = await listChannelRoutes(env, model);
  if (routes.length === 0) {
    return jsonError(
      503,
      `模型「${model}」未配置，或所在渠道已停用`,
      "model_not_configured"
    );
  }

  const promptChars = (body.messages ?? []).reduce((sum, m) => {
    const content: unknown = m.content;
    return sum + (typeof content === "string" ? content.length : JSON.stringify(content).length);
  }, 0);

  // Channels receive the request as-is (no cross-provider fallback rewriting).
  if ("fallback" in body) delete (body as { fallback?: unknown }).fallback;

  const billing = billingEnabled(env) && !!caller.ownerSub;
  const maxTokens =
    typeof (body as { max_tokens?: unknown }).max_tokens === "number"
      ? (body as { max_tokens: number }).max_tokens
      : null;
  let hold = 0;
  if (billing) {
    hold = await estimateMaxCostMicro(env, model, promptChars, maxTokens);
    if (!(await reserveBalance(env, caller.ownerSub as string, hold))) {
      const bal = await getBalanceMicro(env, caller.ownerSub as string);
      return jsonError(
        402,
        `余额不足,请充值（当前余额 ${usdMicro(bal)}，本次预估 ${usdMicro(hold)}）`,
        "insufficient_balance",
        { balance_micro: bal, required_micro: hold }
      );
    }
  }

  try {
    let res: Response | null = null;
    let lastStatus: number | null = null;
    for (let i = 0; i < routes.length; i++) {
      res = await channelAttempt(env, ctx, routes[i], body, caller, promptChars, i === routes.length - 1);
      if (res.status >= 200 && res.status <= 299) break;
      lastStatus = res.status;
    }

    if (!res) {
      return jsonError(503, "no channels available", "upstream_unavailable");
    }
    const ok = res.status >= 200 && res.status <= 299;
    if (caller.tokenId !== null && ok) {
      await incrementTokenUse(env, caller.tokenId);
    }
    if (ok) {
      const safeModel = String(model).replace(/[^\x20-\x7E]/g, "").slice(0, 200);
      const out = new Response(res.body, res);
      out.headers.set("X-KeyPool-Provider", "channel");
      out.headers.set("X-KeyPool-Model", safeModel);
      return out;
    }
    // All channels failed: return the last upstream error, mapped to a 502/503.
    return jsonError(
      lastStatus !== null && lastStatus >= 400 && lastStatus < 500 ? 502 : 503,
      `所有渠道调用失败（${lastStatus ?? "unknown"}）`,
      "upstream_unavailable"
    );
  } finally {
    if (billing && hold > 0) await refundBalance(env, caller.ownerSub as string, hold);
  }
}
