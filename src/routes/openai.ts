/** OpenAI-compatible routes: `/v1/models` + `/v1/chat/completions`. User auth. */

import { Hono } from "hono";
import type { Env } from "../types";
import { PROVIDERS } from "../types";
import type { OpenAIChatRequest } from "../providers/types";
import { getAdapter } from "../providers";
import { requireUser, resolveCaller } from "../auth";
import { checkTokenLimits, allChannelModelIds, getBalanceMicro, getChargeTotalMicro } from "../db";
import { serveChat } from "../chat";
import { anthropicToOpenAI, openAIToAnthropic, openAIStreamToAnthropic } from "../anthropic";
import type { AnthropicRequest } from "../anthropic";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireUser);

/** GET /models — models registered on enabled channels (manual configuration). */
app.get("/models", async (c) => {
  const ids = await allChannelModelIds(c.env);
  const data: Array<{ id: string; object: "model"; owned_by: string }> = [];
  for (const id of [...ids].sort()) {
    data.push({ id, object: "model", owned_by: "channel" });
  }
  return c.json({ object: "list", data });
});

/** POST /chat/completions — route to a provider and dispatch through the pool. */
app.post("/chat/completions", async (c) => {
  let body: OpenAIChatRequest;
  try {
    body = (await c.req.json()) as OpenAIChatRequest;
  } catch {
    return c.json(
      { error: { message: "invalid json body", type: "invalid_request_error" } },
      400,
    );
  }

  if (!body || typeof body.model !== "string" || !body.model) {
    return c.json(
      { error: { message: "missing required field: model", type: "invalid_request_error" } },
      400,
    );
  }
  if (!Array.isArray(body.messages)) {
    return c.json(
      { error: { message: "messages must be an array", type: "invalid_request_error" } },
      400,
    );
  }

  const caller = await resolveCaller(c.env, c.req.raw);
  if (caller.tokenId !== null) {
    const chk = await checkTokenLimits(c.env, caller.tokenId);
    if (!chk.ok) {
      return c.json({ error: { message: chk.message, type: "limit_exceeded" } }, chk.status as 429);
    }
  }
  return serveChat(c.env, c.executionCtx, body, caller);
});

/**
 * Industry-standard balance endpoints (OpenAI legacy billing shape), the format
 * NewAPI/OneAPI + most clients (ChatGPT-Next-Web, Lobe, Bob, 沉浸式翻译, …) read.
 * Balance = hard_limit_usd − total_usage/100. Authed by the caller's token.
 */
app.get("/dashboard/billing/subscription", async (c) => {
  const caller = await resolveCaller(c.env, c.req.raw);
  let grantedUsd = 999999; // admin / unattributed token => effectively unlimited
  if (caller.ownerSub) {
    const balance = await getBalanceMicro(c.env, caller.ownerSub);
    const spent = await getChargeTotalMicro(c.env, caller.ownerSub);
    grantedUsd = (balance + spent) / 1_000_000; // total granted = remaining + spent
  }
  return c.json({
    object: "billing_subscription",
    has_payment_method: true,
    canceled: false,
    soft_limit_usd: grantedUsd,
    hard_limit_usd: grantedUsd,
    system_hard_limit_usd: grantedUsd,
    access_until: 0,
  });
});

app.get("/dashboard/billing/usage", async (c) => {
  const caller = await resolveCaller(c.env, c.req.raw);
  let spentMicro = 0;
  if (caller.ownerSub) spentMicro = await getChargeTotalMicro(c.env, caller.ownerSub);
  // total_usage is in cents (USD * 100).
  return c.json({ object: "list", total_usage: (spentMicro / 1_000_000) * 100 });
});

/** POST /messages — Anthropic Messages API. Translates to OpenAI, dispatches
 *  through the shared pool, and translates the response back to Anthropic. */
app.post("/messages", async (c) => {
  let a: AnthropicRequest;
  try {
    a = (await c.req.json()) as AnthropicRequest;
  } catch {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "invalid json body" } }, 400);
  }
  if (!a || typeof a.model !== "string" || !a.model || !Array.isArray(a.messages)) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model and messages are required" } }, 400);
  }

  const caller = await resolveCaller(c.env, c.req.raw);
  if (caller.tokenId !== null) {
    const chk = await checkTokenLimits(c.env, caller.tokenId);
    if (!chk.ok) {
      return c.json({ type: "error", error: { type: "rate_limit_error", message: chk.message } }, chk.status as 429);
    }
  }

  const stream = a.stream === true;
  const oai = await serveChat(c.env, c.executionCtx, anthropicToOpenAI(a), caller);

  if (oai.status < 200 || oai.status > 299) {
    const text = await oai.text().catch(() => "");
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* keep text */ }
    const type = oai.status === 402 ? "insufficient_quota" : oai.status === 429 ? "rate_limit_error" : "api_error";
    return c.json({ type: "error", error: { type, message: msg || `upstream ${oai.status}` } }, oai.status as 500);
  }

  const passHeaders: Record<string, string> = {};
  for (const h of ["X-KeyPool-Provider", "X-KeyPool-Model", "X-KeyPool-Fallback"]) {
    const v = oai.headers.get(h);
    if (v) passHeaders[h] = v;
  }

  if (stream && oai.body) {
    return new Response(openAIStreamToAnthropic(oai.body, a.model), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...passHeaders },
    });
  }
  const j = await oai.json().catch(() => ({}));
  return new Response(JSON.stringify(openAIToAnthropic(j as Parameters<typeof openAIToAnthropic>[0], a.model)), {
    status: 200,
    headers: { "content-type": "application/json", ...passHeaders },
  });
});

export default app;
