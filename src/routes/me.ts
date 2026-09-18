/**
 * Consumer self-service routes. Mounted at `/me`.
 *
 * Auth is a valid SSO session cookie (via `getSession`), NOT a bearer token.
 * Approved users can list, mint, and delete their own access tokens; pending
 * or blocked users are gated out of minting with a 403.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { getSession } from "../oidc";
import { getPayConfig, enabledMethods, buildSubmitUrl } from "../payone";
import {
  listTokensByOwner,
  createToken,
  deleteOwnedToken,
  getUserBySub,
  usageSummary,
  recentLogs,
  getBalanceMicro,
  listTransactions,
  modelStats,
  billingDiscount,
} from "../db";

const app = new Hono<{ Bindings: Env }>();

/** List the caller's own tokens (full token strings — they're the owner). */
app.get("/tokens", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }
  const tokens = await listTokensByOwner(c.env, session.sub);
  // Bare array — matches the admin /tokens shape and what the console expects.
  return c.json(tokens);
});

/** Mint a token for the caller. Requires an approved account. */
app.post("/tokens", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }

  const user = await getUserBySub(c.env, session.sub);
  if (!user || user.status !== "approved") {
    return c.json(
      {
        error: { message: "账号待开通,请联系管理员", type: "not_approved" },
      },
      403
    );
  }

  let name: string | undefined;
  try {
    const body = (await c.req.json()) as { name?: unknown } | null;
    if (body && typeof body.name === "string") name = body.name;
  } catch {
    // empty / invalid body → unnamed token
  }

  const created = await createToken(c.env, {
    name,
    role: "user",
    ownerSub: session.sub,
  });
  return c.json({ token: created.token, name: created.name });
});

/** Delete one of the caller's own tokens. 404 if not owned. */
app.delete("/tokens/:id", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { message: "无效的令牌 ID", type: "bad_request" } }, 400);
  }

  const ok = await deleteOwnedToken(c.env, id, session.sub);
  if (!ok) {
    return c.json({ error: { message: "令牌不存在", type: "not_found" } }, 404);
  }
  return c.json({ ok: true });
});

// GET /usage — the caller's own usage aggregates (last 30 days).
app.get("/usage", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }
  const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return c.json(await usageSummary(c.env, { ownerSub: session.sub, sinceMs }));
});

// GET /logs — the caller's own recent requests.
app.get("/logs", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }
  return c.json(await recentLogs(c.env, { ownerSub: session.sub, limit: 50 }));
});

// GET /model-stats — global per-model performance leaderboard (last 7 days), so a
// consumer can pick a fast/reliable model. Aggregate-only (no per-user identity).
app.get("/model-stats", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = await modelStats(c.env, { sinceMs, limit: 100 });
  // Apply the billing discount so the price columns show what the consumer pays
  // (micro-USD per 1M tokens). Fall back input/output → legacy → DEFAULT_PRICE.
  const discount = billingDiscount(c.env);
  const fallback = Number(c.env.DEFAULT_PRICE_MICRO ?? "500000");
  const out = rows.map((r) => {
    const legacy = r.legacy_micro ?? fallback;
    const priceInMicro = Math.round((r.in_micro ?? legacy) * discount);
    const priceOutMicro = Math.round((r.out_micro ?? legacy) * discount);
    return {
      model: r.model,
      provider: r.provider,
      n: r.n,
      ok: r.ok,
      avg_latency: r.avg_latency,
      avg_out: r.avg_out,
      price_in_micro: priceInMicro,
      price_out_micro: priceOutMicro,
    };
  });
  return c.json(out);
});

// GET /balance — the caller's own balance in micro-USD.
app.get("/balance", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }
  return c.json({ balance_micro: await getBalanceMicro(c.env, session.sub) });
});

// GET /transactions — the caller's own billing transactions.
app.get("/transactions", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }
  return c.json(await listTransactions(c.env, { sub: session.sub, limit: 50 }));
});

// GET /pay-methods — enabled payment methods for the top-up UI (a disabled
// method is simply not offered; the UI degrades automatically).
app.get("/pay-methods", async (c) => {
  const cfg = await getPayConfig(c.env);
  if (!cfg) {
    return c.json({ enabled: false, methods: [], note: "payment not configured" });
  }
  return c.json({
    enabled: true,
    methods: enabledMethods(cfg).map((m) => ({ key: m.key, label: m.label })),
  });
});

// POST /checkout — create a 易支付 (PayOne) order and return its payment URL.
// Amounts are passed through in USD (merchant-side rate conversion).
app.post("/checkout", async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) {
    return c.json({ error: { message: "未登录", type: "unauthorized" } }, 401);
  }

  const cfg = await getPayConfig(c.env);
  if (!cfg) {
    return c.json(
      { error: { message: "payment not configured", type: "not_configured" } },
      503
    );
  }

  let amountUsd = 0;
  let methodKey = "";
  try {
    const body = (await c.req.json()) as { amount_usd?: unknown; method?: unknown } | null;
    if (body && typeof body.amount_usd === "number") amountUsd = body.amount_usd;
    if (body && typeof body.method === "string") methodKey = body.method;
  } catch {
    // invalid body → amountUsd stays 0 and fails the check below
  }
  if (!(amountUsd >= 0.01)) {
    return c.json({ error: { message: "金额过小（至少 0.01 USD）", type: "bad_request" } }, 400);
  }
  if (amountUsd > 10000) {
    return c.json({ error: { message: "单笔金额过大（上限 10000 USD）", type: "bad_request" } }, 400);
  }
  const method = enabledMethods(cfg).find((m) => m.key === methodKey);
  if (!method) {
    return c.json(
      { error: { message: "请选择可用的支付方式", type: "bad_request" } },
      400
    );
  }

  const amountMicro = Math.round(amountUsd * 1_000_000);
  const orderNo =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + methodKey.slice(0, 4);

  await c.env.DB.prepare(
    `INSERT INTO keypool_gateway_pay_orders (order_no, sub, amount_micro, method, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  )
    .bind(orderNo, session.sub, amountMicro, methodKey, Date.now())
    .run();

  const base = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const url = buildSubmitUrl(cfg, {
    out_trade_no: orderNo,
    method_type: method.type,
    name: "API 额度充值",
    money: amountUsd.toFixed(2),
    notify_url: base + "/pay/notify",
    return_url: base + "/pay/return",
  });
  return c.json({ url, order_no: orderNo });
});

export default app;
