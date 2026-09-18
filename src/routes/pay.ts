/**
 * 易支付回调路由 — mounted at /pay.
 *   GET  /pay/return  — 同步跳转(用户支付完回到本网关), 验签后 302 回首页并标记成功提示
 *   POST /pay/notify  — 异步回调, 验签 + 幂等入账, 回 "success"
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { topUpMicro, getUserBySub, getAllSettings } from "../db";
import { sendMail, parseSmtp } from "../smtp";
import { getPayConfig, verifyCallback } from "../payone";

const app = new Hono<{ Bindings: Env }>();

interface PayOrder {
  id: number;
  order_no: string;
  sub: string;
  amount_micro: number;
  method: string | null;
  status: string;
  trade_no: string | null;
}

/** Idempotently mark an order paid and credit the balance. */
async function settleOrder(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  orderNo: string,
  tradeNo: string
): Promise<"paid" | "new" | "unknown"> {
  const row = await env.DB.prepare(
    `SELECT id, sub, amount_micro, status FROM keypool_gateway_pay_orders WHERE order_no = ?`
  )
    .bind(orderNo)
    .first<PayOrder>();
  if (!row) return "unknown";
  if (row.status === "paid") return "paid"; // idempotent
  const upd = await env.DB.prepare(
    `UPDATE keypool_gateway_pay_orders SET status = 'paid', trade_no = ?, paid_at = ? WHERE id = ? AND status = 'pending'`
  )
    .bind(tradeNo, Date.now(), row.id)
    .run();
  // Concurrent notify/return may both read 'pending'; only the winner credits.
  const changed = upd.meta && typeof upd.meta.changes === "number" ? upd.meta.changes : 1;
  if (changed <= 0) return "paid";
  await topUpMicro(env, row.sub, row.amount_micro, "payone: " + tradeNo);
  ctx.waitUntil(sendInvoiceMail(env, row.sub, row.amount_micro, orderNo, tradeNo).catch(() => {}));
  return "new";
}

/** Best-effort recharge invoice email (fire-and-forget via ctx.waitUntil at call sites). */
async function sendInvoiceMail(
  env: Env,
  sub: string,
  amountMicro: number,
  orderNo: string,
  tradeNo: string
): Promise<void> {
  const s = await getAllSettings(env);
  const smtp = parseSmtp(s.smtp_json);
  if (!smtp) return;
  const user = await getUserBySub(env, sub);
  if (!user?.email) return;
  const brand = s.brand_name || "keypool";
  const usd = (amountMicro / 1e6).toFixed(2);
  const date = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  await sendMail(
    smtp,
    user.email,
    `[${brand}] Recharge invoice · $${usd}`,
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e5e5;border-radius:12px">
      <h2 style="margin:0 0 12px">${brand} · 充值发票 / Recharge Invoice</h2>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr><td style="padding:6px 0;color:#666">金额 / Amount</td><td style="padding:6px 0;text-align:right;font-weight:700">$${usd} USD</td></tr>
        <tr><td style="padding:6px 0;color:#666">订单号 / Order No.</td><td style="padding:6px 0;text-align:right">${orderNo}</td></tr>
        <tr><td style="padding:6px 0;color:#666">交易号 / Trade No.</td><td style="padding:6px 0;text-align:right">${tradeNo}</td></tr>
        <tr><td style="padding:6px 0;color:#666">时间 / Time</td><td style="padding:6px 0;text-align:right">${date}</td></tr>
      </table>
      <p style="margin-top:16px;color:#666;font-size:13px">充值已到账，可在控制台「余额」查看明细。This is an automated invoice, no reply needed.</p>
    </div>`
  );
}

/** POST /pay/notify — async callback from the gateway. */
app.post("/notify", async (c) => {
  const cfg = await getPayConfig(c.env);
  if (!cfg) return c.text("gateway not configured", 400);

  // 易支付 posts application/x-www-form-urlencoded (or JSON on some builds);
  // accept both.
  const params: Record<string, string> = {};
  const ct = (c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body) {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") params[k] = v;
      }
    }
  } else {
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string") params[k] = v;
    }
  }

  if (!verifyCallback(cfg, params)) return c.text("bad signature", 400);
  if (params.trade_status !== "TRADE_SUCCESS") {
    // 未支付/失败的回调 — acknowledge so the gateway stops retrying.
    return c.text("success");
  }
  const orderNo = params.out_trade_no || "";
  const tradeNo = params.trade_no || "";
  if (!orderNo) return c.text("bad request", 400);

  await settleOrder(c.env, c.executionCtx, orderNo, tradeNo);
  return c.text("success");
});

/** GET /pay/return — sync redirect after payment. */
app.get("/return", async (c) => {
  const cfg = await getPayConfig(c.env);
  const base = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  if (!cfg) return c.redirect(base + "/?topup=gateway-not-configured");

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) {
    if (typeof v === "string") params[k] = v;
  }
  if (!verifyCallback(cfg, params)) return c.redirect(base + "/?topup=verify-failed");

  const orderNo = params.out_trade_no || "";
  if (orderNo) {
    const tradeNo = params.trade_no || orderNo;
    await settleOrder(c.env, c.executionCtx, orderNo, tradeNo);
  }
  return c.redirect(base + "/?topup=success");
});

export default app;
