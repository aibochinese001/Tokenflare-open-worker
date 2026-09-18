/** Hono auth middleware: `requireUser`, `requireAdmin`. */

import type { MiddlewareHandler } from "hono";
import type { Env, Role } from "./types";
import { resolveToken, resolveTokenFull, getUserBySub } from "./db";
import { getSession } from "./oidc";

/**
 * Identify the caller of a request for usage attribution: a bearer token maps to
 * its token id + owner; an SSO session cookie maps to the user's sub (no token).
 */
export async function resolveCaller(
  env: Env,
  req: Request
): Promise<{ tokenId: number | null; ownerSub: string | null }> {
  const token = extractToken(req);
  if (token) {
    const full = await resolveTokenFull(env, token);
    if (full) {
      // Admins are operators, not consumers: never metered or billed.
      if (full.role === "admin") return { tokenId: null, ownerSub: null };
      return { tokenId: full.id, ownerSub: full.ownerSub };
    }
  }
  const sess = await getSession(env, req);
  if (sess) {
    if (sess.role === "admin") return { tokenId: null, ownerSub: null };
    return { tokenId: null, ownerSub: sess.sub };
  }
  return { tokenId: null, ownerSub: null };
}

/** OpenAI-shaped 403 for a logged-in-but-not-approved consumer. */
function forbidden(message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "account_not_approved" } }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}

/** Hono generics shared by auth-protected routes (exposes `role` via c.get). */
type AuthEnv = { Bindings: Env; Variables: { role: Role } };

/** OpenAI-shaped 401 JSON body. */
const UNAUTHORIZED_BODY = {
  error: {
    message: "missing or invalid api key",
    type: "auth_error",
  },
} as const;

/**
 * Extract a bearer token from the request, in priority order:
 *  1. `Authorization: Bearer <token>` header.
 *  2. `x-goog-api-key` header (Gemini passthrough convenience).
 *  3. `?key=` query parameter (Gemini passthrough convenience).
 */
function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const match = /^\s*Bearer\s+(.+)\s*$/i.exec(auth);
    if (match && match[1]) return match[1].trim();
  }

  const goog = req.headers.get("x-goog-api-key");
  if (goog && goog.trim()) return goog.trim();

  // Anthropic-native clients (Claude Code / SDK) send the key as `x-api-key`.
  const anthropic = req.headers.get("x-api-key");
  if (anthropic && anthropic.trim()) return anthropic.trim();

  try {
    const url = new URL(req.url);
    const key = url.searchParams.get("key");
    if (key && key.trim()) return key.trim();
  } catch {
    // malformed URL — fall through to null
  }

  return null;
}

function unauthorized(): Response {
  return new Response(JSON.stringify(UNAUTHORIZED_BODY), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build a middleware that authenticates the request and stashes the resolved
 * role on `c.set("role", role)`. If `adminOnly` is true, a `user` role is
 * rejected with 401.
 */
function makeAuth(adminOnly: boolean): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // Bearer token (API clients) first — these are enabled-checked in the DB and
    // are disabled when a user is blocked, so no extra status check is needed.
    let role: Role | null = null;
    const token = extractToken(c.req.raw);
    if (token) role = await resolveToken(c.env, token);

    // Else fall back to the SSO session cookie (browser). A non-admin session
    // must belong to an APPROVED user — this enforces the admin-approval gate
    // and instantly cuts off a blocked user (the JWT alone is not enough).
    if (!role) {
      const sess = await getSession(c.env, c.req.raw);
      if (sess) {
        if (sess.role === "admin") {
          role = "admin";
        } else {
          const u = await getUserBySub(c.env, sess.sub);
          if (!u || u.status !== "approved") {
            return forbidden(
              u && u.status === "blocked" ? "账号已停用" : "账号待开通,请联系管理员"
            );
          }
          role = "user";
        }
      }
    }

    if (!role) return unauthorized();
    if (adminOnly && role !== "admin") return unauthorized();

    c.set("role", role);
    await next();
  };
}

/** Any valid token (user or admin). */
export const requireUser: MiddlewareHandler<AuthEnv> = makeAuth(false);

/** Admin tokens only. */
export const requireAdmin: MiddlewareHandler<AuthEnv> = makeAuth(true);
