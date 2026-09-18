/**
 * Native passthrough routes: /gemini/*, /mistral/*, /openrouter/*.
 *
 * Each prefix proxies the request to the matching provider's upstream API via
 * the key pool. `subPath` is everything after `/<provider>` (keeping the
 * leading `/` and the original query string), e.g.
 * `/v1beta/models/gemini-2.0-flash:generateContent?alt=sse`.
 *
 * This module exports a default Hono instance that handles all three prefixes
 * (via `app.all("/gemini/*", ...)` etc). `index.ts` mounts it at the root with
 * `app.route("/", passthrough)`.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Provider } from "../types";
import { requireUser, resolveCaller } from "../auth";
import { callWithPool } from "../keypool";
import { getAdapter } from "../providers";
import { checkTokenLimits, incrementTokenUse, billingEnabled, estimateMaxCostMicro, reserveBalance, refundBalance , getBalanceMicro } from "../db";

type AppEnv = { Bindings: Env };

/**
 * Compute the subPath after the `/<provider>` segment: the remaining pathname
 * (always starting with `/`) plus the original query string.
 */
function computeSubPath(c: Context<AppEnv>, provider: Provider): string {
  const url = new URL(c.req.url);
  const prefix = `/${provider}`;
  let path = url.pathname;
  if (path.startsWith(prefix)) {
    path = path.slice(prefix.length);
  }
  if (path.length === 0 || !path.startsWith("/")) {
    path = `/${path}`;
  }
  // Drop the gateway auth params so our access token / ADMIN_TOKEN never leaks
  // to the upstream provider (the adapter injects the real upstream key itself).
  url.searchParams.delete("key");
  url.searchParams.delete("token");
  const q = url.searchParams.toString();
  return `${path}${q ? "?" + q : ""}`;
}

function handle(provider: Provider): (c: Context<AppEnv>) => Promise<Response> {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const subPath = computeSubPath(c, provider);
    const req = c.req.raw;
    const caller = await resolveCaller(c.env, req);
    if (caller.tokenId !== null) {
      const chk = await checkTokenLimits(c.env, caller.tokenId);
      if (!chk.ok) {
        return c.json({ error: { message: chk.message, type: "limit_exceeded" } }, chk.status as 429);
      }
    }
    // Price native passthrough at the provider's default model (the raw body
    // isn't parsed here) instead of the global default fallback price.
    const billModel = getAdapter(provider).models()[0] ?? null;

    // Billing: reserve a max-cost hold (concurrency-safe gate), refund after.
    const billing = billingEnabled(c.env) && !!caller.ownerSub;
    let hold = 0;
    if (billing) {
      hold = await estimateMaxCostMicro(c.env, billModel, 0, null);
      const okReserve = await reserveBalance(c.env, caller.ownerSub as string, hold);
      if (!okReserve) {
        const bal = await getBalanceMicro(c.env, caller.ownerSub as string);
        const usd = (m: number): string => { const d = m / 1e6; return d >= 1 ? "$" + d.toFixed(2) : "$" + d.toFixed(4); };
        return c.json(
          {
            error: {
              message: `余额不足,请充值（当前余额 ${usd(bal)}，本次预估 ${usd(hold)}）`,
              type: "insufficient_balance",
              balance_micro: bal,
              required_micro: hold,
            },
          },
          402
        );
      }
    }
    try {
      const res = await callWithPool(
        c.env,
        provider,
        (key: string) => getAdapter(provider).passthrough(subPath, req, key),
        { model: billModel, tokenId: caller.tokenId, ownerSub: caller.ownerSub, ctx: c.executionCtx }
      );
      if (caller.tokenId !== null && res.status >= 200 && res.status <= 299) {
        await incrementTokenUse(c.env, caller.tokenId);
      }
      return res;
    } finally {
      if (billing && hold > 0) await refundBalance(c.env, caller.ownerSub as string, hold);
    }
  };
}

const app = new Hono<AppEnv>();

app.use("/gemini/*", requireUser);
app.use("/mistral/*", requireUser);
app.use("/openrouter/*", requireUser);

app.all("/gemini/*", handle("gemini"));
app.all("/mistral/*", handle("mistral"));
app.all("/openrouter/*", handle("openrouter"));

export default app;
