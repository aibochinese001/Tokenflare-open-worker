/**
 * OIDC SSO (any OIDC provider) — Authorization Code + PKCE, public client
 * (no client secret). Issues an HS256 session cookie after a successful login.
 *
 *   GET /auth/login    -> redirect to the IdP authorize endpoint
 *   GET /auth/callback -> exchange code, fetch userinfo, set session cookie
 *   GET /auth/me       -> { email, role } from the session cookie (401 if none)
 *   GET /auth/logout   -> clear the session cookie
 *
 * Role: email === ADMIN_EMAIL -> "admin", any other logged-in user -> "user".
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Role } from "./types";
import { getAllSettings } from "./db";
import { translateAll, i18nScript, langFromCookie } from "./i18n";
import {
  upsertUser,
  getUserBySub,
  topUpMicro,
  createLocalUser,
  getLocalUserByEmail,
  getLocalUserBySub,
  updateLocalUserProfile,
  updateLocalUserPassword,
  loginLockedUntil,
  recordLoginFail,
  clearLoginFails,
  setSetting,
  deleteSetting,
} from "./db";
import { sendMail, parseSmtp } from "./smtp";
import { generateSalt, hashPassword, verifyPassword } from "./passwords";

const DEFAULT_ISSUER = ""; // set OIDC_ISSUER; empty => SSO disabled
const SESSION_COOKIE = "kp_session";
const PKCE_COOKIE = "kp_oidc";
// One-shot marker so a missing/expired PKCE cookie restarts login exactly once
// instead of either dead-ending or looping forever.
const RETRY_COOKIE = "kp_oidc_retry";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
// The PKCE/state cookie has to outlive the whole round-trip, which on the SSO
// includes registering + signing in on a mobile / in-app browser. 10 min was
// too tight and produced "invalid state" dead-ends; give it real headroom.
const PKCE_TTL = 60 * 30; // 30 minutes

export interface Session {
  sub: string;
  email: string;
  role: Role;
  name?: string;
}

// ---------- base64url + HMAC (WebCrypto) ----------

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeStr(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}
function b64urlDecodeStr(s: string): string {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return b;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Minimal HS256 JWT sign. */
async function jwtSign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64urlEncodeStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncodeStr(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))
  );
  return `${data}.${b64urlEncode(sig)}`;
}

/** Verify + decode an HS256 JWT. Returns the payload or null. */
async function jwtVerify(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const key = await hmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${b}`))
  );
  let given: Uint8Array;
  try {
    given = Uint8Array.from(b64urlDecodeStr(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (expected.length !== given.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
  if (diff !== 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecodeStr(b));
  } catch {
    return null;
  }
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp && Date.now() / 1000 > exp) return null;
  return payload;
}

// ---------- PKCE ----------

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64urlEncode(a);
}
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );
  return b64urlEncode(digest);
}

// ---------- cookies ----------

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

/** Friendly fallback shown only when a restarted login still has no PKCE cookie
 *  (cookies blocked). Offers a manual retry instead of a bare "invalid state". */
function invalidStatePage(lang = "en"): string {
  const tpl = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录已过期</title><style>:root{color-scheme:light}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#fcfbf4;color:#1a1a1a;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:24px}main{max-width:360px;text-align:center}h1{font-size:20px;margin:0 0 12px}p{color:#555;line-height:1.6;margin:0 0 24px}a{display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:999px;font-weight:600}small{display:block;margin-top:16px;color:#999}</style></head><body><main><h1>登录会话已过期</h1><p>登录耗时过长或浏览器拦截了 Cookie，请重新登录一次。</p><a href="/auth/login">重新登录</a><small>若反复出现，请在系统浏览器（Safari / Chrome）中打开，或允许本站 Cookie。</small></main></body></html>`;
  return translateAll(tpl, lang);
}

// ---------- config ----------

function issuer(env: Env): string {
  return (env.OIDC_ISSUER || DEFAULT_ISSUER).replace(/\/$/, "");
}
function configured(env: Env): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.SESSION_SECRET);
}
function redirectUri(req: Request): string {
  return new URL(req.url).origin + "/auth/callback";
}

/** Resolve the session role from the request's session cookie, if any. */
export async function sessionRole(env: Env, req: Request): Promise<Role | null> {
  if (!env.SESSION_SECRET) return null;
  const tok = readCookie(req, SESSION_COOKIE);
  if (!tok) return null;
  const p = await jwtVerify(tok, env.SESSION_SECRET);
  if (!p) return null;
  return p.role === "admin" ? "admin" : p.role === "user" ? "user" : null;
}

/** Resolve the full verified session payload from the kp_session cookie, if any. */
export async function getSession(
  env: Env,
  req: Request
): Promise<{ sub: string; email: string; role: Role; name: string | null } | null> {
  if (!env.SESSION_SECRET) return null;
  const tok = readCookie(req, SESSION_COOKIE);
  if (!tok) return null;
  const p = await jwtVerify(tok, env.SESSION_SECRET);
  if (!p) return null;
  const sub = typeof p.sub === "string" ? p.sub : null;
  const email = typeof p.email === "string" ? p.email : null;
  if (!sub || !email) return null;
  const role: Role = p.role === "admin" ? "admin" : "user";
  const name = typeof p.name === "string" ? p.name : null;
  return { sub, email, role, name };
}

// ---------- routes ----------

const app = new Hono<{ Bindings: Env }>();

/** Issue the session cookie for a logged-in user (local or OIDC). */
async function issueSession(
  c: Context<{ Bindings: Env }>,
  u: { sub: string; email: string; name: string | null; role: Role }
): Promise<void> {
  const secret = c.env.SESSION_SECRET as string;
  const session = await jwtSign(
    {
      sub: u.sub,
      email: u.email,
      role: u.role,
      name: u.name,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    },
    secret
  );
  c.header("Set-Cookie", cookie(SESSION_COOKIE, session, SESSION_TTL, true));
}

app.get("/login", async (c) => {
  if (!configured(c.env)) {
    return c.json({ error: "sso not configured (set OIDC_CLIENT_ID + SESSION_SECRET)" }, 503);
  }
  const verifier = randomString(32);
  const state = randomString(16);
  const challenge = await pkceChallenge(verifier);
  const stateJwt = await jwtSign(
    { v: verifier, s: state, exp: Math.floor(Date.now() / 1000) + PKCE_TTL },
    c.env.SESSION_SECRET as string
  );
  const u = new URL(issuer(c.env) + "/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.env.OIDC_CLIENT_ID as string);
  u.searchParams.set("redirect_uri", redirectUri(c.req.raw));
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  c.header("Set-Cookie", cookie(PKCE_COOKIE, stateJwt, PKCE_TTL, true));
  return c.redirect(u.toString());
});

app.get("/callback", async (c) => {
  if (!configured(c.env)) return c.json({ error: "sso not configured" }, 503);
  const secret = c.env.SESSION_SECRET as string;
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("missing code/state", 400);

  const pkceTok = readCookie(c.req.raw, PKCE_COOKIE);
  const pkce = pkceTok ? await jwtVerify(pkceTok, secret) : null;
  if (!pkce || pkce.s !== state || typeof pkce.v !== "string") {
    // The PKCE/state cookie is missing, expired, or mismatched — in practice
    // because the login round-trip outlived the cookie or it didn't survive the
    // hop through the IdP (common on mobile / in-app browsers). Don't dead-end
    // on a cryptic "invalid state": restart the flow once. By the retry the user
    // already has an IdP session, so the second pass is instant and lands a
    // fresh cookie. The one-shot marker stops an infinite loop if cookies truly
    // can't be stored (the browser also caps redirect loops as a backstop).
    const alreadyRetried = readCookie(c.req.raw, RETRY_COOKIE) === "1";
    if (!alreadyRetried) {
      c.header("Set-Cookie", cookie(RETRY_COOKIE, "1", 120, true), { append: true });
      return c.redirect("/auth/login");
    }
    c.header("Set-Cookie", cookie(RETRY_COOKIE, "", 0, true), { append: true });
    return c.html(invalidStatePage(langFromCookie(c.req.header("cookie"))), 400);
  }
  // Good state — drop any leftover retry marker so the next login starts clean.
  c.header("Set-Cookie", cookie(RETRY_COOKIE, "", 0, true), { append: true });

  // Exchange the code (public client + PKCE, no secret).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(c.req.raw),
    client_id: c.env.OIDC_CLIENT_ID as string,
    code_verifier: pkce.v,
  });
  const tokRes = await fetch(issuer(c.env) + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokRes.ok) {
    return c.text(`token exchange failed: ${tokRes.status} ${await tokRes.text()}`, 502);
  }
  const tok = (await tokRes.json()) as { access_token?: string };
  if (!tok.access_token) return c.text("no access_token", 502);

  // The tokens came straight from the issuer over TLS (back-channel), so the
  // userinfo response is trustworthy without separately verifying the id_token.
  const uiRes = await fetch(issuer(c.env) + "/userinfo", {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  if (!uiRes.ok) return c.text(`userinfo failed: ${uiRes.status}`, 502);
  const info = (await uiRes.json()) as { sub?: string; email?: string; name?: string; email_verified?: boolean };
  const email = (info.email || "").toLowerCase();
  if (!email) return c.text("no email in profile", 403);

  // Admin is granted ONLY to the configured email, and never when the IdP
  // explicitly marks the email unverified (email_verified === false) — that
  // blocks a spoofed/unverified profile email on a permissive IdP. A first-party
  // IdP that omits the field is still trusted (avoids locking out the sole admin).
  const admin = (c.env.ADMIN_EMAIL || "").toLowerCase();
  const isAdmin = email === admin && info.email_verified !== false;
  const sub = info.sub || email;
  const name = info.name || null;
  // Campaign signup bonus: grant SIGNUP_BONUS_USD once, on a consumer's FIRST
  // login (detected before the upsert). Admins don't get a balance.
  const isNew = !(await getUserBySub(c.env, sub));
  const row = await upsertUser(c.env, { sub, email, name, isAdmin });
  if (isNew && !isAdmin) {
    const bonusUsd = Number(c.env.SIGNUP_BONUS_USD);
    if (Number.isFinite(bonusUsd) && bonusUsd > 0) {
      await topUpMicro(c.env, sub, Math.round(bonusUsd * 1_000_000), "新用户活动赠送");
    }
  }
  const session = await jwtSign(
    {
      sub,
      email,
      role: row.role,
      name,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    },
    secret
  );
  c.header("Set-Cookie", cookie(SESSION_COOKIE, session, SESSION_TTL, true), { append: true });
  // clear the pkce cookie
  c.header("Set-Cookie", cookie(PKCE_COOKIE, "", 0, true), { append: true });
  return c.redirect("/");
});


// ---------- local account management (change email/name, change password) ----------
// Both require an active session and only apply to local (email+password)
// accounts. sub is immutable; only email/name are editable.

/** POST /auth/account — update own profile: { name?, email? }. */
app.post("/account", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "sso not configured" }, 503);
  const sess = await getSession(c.env, c.req.raw);
  if (!sess) return c.json({ error: "not logged in" }, 401);
  if (!sess.sub.startsWith("local:")) {
    return c.json({ error: { message: "该账号为 SSO 账号，不支持修改资料", type: "not_local" } }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    email?: unknown;
    code?: unknown;
  } | null;
  if (!body) return c.json({ error: { message: "无效的请求体", type: "invalid_request_error" } }, 400);
  const patch: { name?: string | null; email?: string } = {};
  let changed = false;
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    patch.name = name || null;
    changed = true;
  }
  if (body.email !== undefined) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: { message: "邮箱格式不正确", type: "invalid_email" } }, 400);
    }
    patch.email = email;
    changed = true;
  }
  if (!changed) {
    return c.json({ error: { message: "没有需要修改的内容", type: "invalid_request_error" } }, 400);
  }
  // Email uniqueness (excluding self). sub stays put — token ownership and
  // usage history remain attached to the same account.
  if (patch.email) {
    const me = await getLocalUserBySub(c.env, sess.sub);
    const clash = await getLocalUserByEmail(c.env, patch.email);
    if (clash && clash.sub !== sess.sub) {
      return c.json({ error: { message: "该邮箱已被其他账号使用", type: "email_taken" } }, 409);
    }
    if (!me) return c.json({ error: { message: "账号不存在", type: "not_found" } }, 404);
    // Changing the mailbox requires a code that was sent to the NEW address.
    if (patch.email !== me.email) {
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!code) {
        return c.json({ error: { message: "修改邮箱需要邮箱验证码", type: "code_missing" } }, 400);
      }
      const s = await getAllSettings(c.env);
      const stored = s[`emailcode:${sess.sub}`];
      const parts = stored ? stored.split("|") : [];
      const expected = parts[2];
      if (!expected || expected !== code) {
        return c.json({ error: { message: "验证码不正确", type: "bad_code" } }, 401);
      }
      if (Date.now() > Number(parts[1])) {
        await deleteSetting(c.env, `emailcode:${sess.sub}`);
        return c.json({ error: { message: "验证码已过期，请重新获取", type: "code_expired" } }, 401);
      }
      const target = parts[3] || me.email;
      if (target !== patch.email) {
        return c.json({ error: { message: "验证码与目标邮箱不匹配，请重新发送到新邮箱", type: "bad_target" } }, 400);
      }
      await deleteSetting(c.env, `emailcode:${sess.sub}`);
    }
  }
  const user = await updateLocalUserProfile(c.env, sess.sub, patch);
  if (!user) return c.json({ error: { message: "账号不存在", type: "not_found" } }, 404);
  return c.json({ ok: true, email: user.email, name: user.name });
});

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_RESEND_MS = 5 * 60 * 1000;

/** POST /auth/send-code — email a 6-digit change-password code to the signed-in
 *  user's mailbox. Requires SMTP configured in system settings. */
app.post("/send-code", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "sso not configured" }, 503);
  const sess = await getSession(c.env, c.req.raw);
  if (!sess) return c.json({ error: "not logged in" }, 401);
  const user = await getLocalUserBySub(c.env, sess.sub);
  if (!user || !user.email) return c.json({ error: { message: "账号不存在", type: "not_found" } }, 404);
  const smtp = parseSmtp((await getAllSettings(c.env)).smtp_json);
  if (!smtp) {
    return c.json({ error: { message: "邮件服务未配置，请联系管理员", type: "smtp_not_configured" } }, 503);
  }
  // Optional { email } target — used when changing the account mailbox, where
  // the code must go to the NEW address to prove ownership of it. Omitted for
  // the password-change flow (goes to the login mailbox).
  const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
  let to = user.email;
  if (body && typeof body.email === "string" && body.email.trim()) {
    const cand = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(cand)) {
      return c.json({ error: { message: "邮箱格式不正确", type: "invalid_email" } }, 400);
    }
    to = cand;
  }
  const key = `emailcode:${sess.sub}`;
  const s = await getAllSettings(c.env);
  const existing = s[key];
  if (existing) {
    const [prevTs] = existing.split("|");
    const prev = Number(prevTs) || 0;
    if (Date.now() - prev < EMAIL_CODE_RESEND_MS) {
      return c.json({ error: { message: "验证码已发送，请稍后再试", type: "too_frequent" } }, 429);
    }
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await setSetting(c.env, key, `${Date.now()}|${Date.now() + EMAIL_CODE_TTL_MS}|${code}|${to}`);
  const brand = (await getAllSettings(c.env)).brand_name || "keypool";
  try {
    await sendMail(
      smtp,
      to,
      `[${brand}] Verification code`,
      `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e5e5;border-radius:12px">
        <h2 style="margin:0 0 8px">${brand} · 邮箱验证码</h2>
        <p>你的验证码是：</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#1a1a1a">${code}</p>
        <p style="color:#666">10 分钟内有效。如果不是你本人操作，请忽略此邮件。</p>
      </div>`
    );
  } catch (e) {
    await deleteSetting(c.env, key);
    return c.json({ error: { message: "邮件发送失败，请检查 SMTP 配置", type: "mail_failed" } }, 502);
  }
  return c.json({ ok: true, sent_to: String(to).replace(/^(.{2}).*@/, "$1***@") });
});

/** POST /auth/password — change own password: { code, new_password }. */
app.post("/password", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "sso not configured" }, 503);
  const sess = await getSession(c.env, c.req.raw);
  if (!sess) return c.json({ error: "not logged in" }, 401);
  if (!sess.sub.startsWith("local:")) {
    return c.json({ error: { message: "该账号为 SSO 账号，无本地密码", type: "not_local" } }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as {
    code?: unknown;
    new_password?: unknown;
  } | null;
  if (!body) return c.json({ error: { message: "无效的请求体", type: "invalid_request_error" } }, 400);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";
  if (newPassword.length < 8 || newPassword.length > 128) {
    return c.json({ error: { message: "新密码长度需为 8-128 位", type: "invalid_password" } }, 400);
  }
  const user = await getLocalUserBySub(c.env, sess.sub);
  if (!user || !user.password_hash || !user.password_salt) {
    return c.json({ error: { message: "账号不存在", type: "not_found" } }, 404);
  }
  // Email-verification-code gate (replaces the old-password check).
  const key = `emailcode:${sess.sub}`;
  const s = await getAllSettings(c.env);
  const stored = s[key];
  if (!stored) {
    return c.json({ error: { message: "请先获取邮箱验证码", type: "code_missing" } }, 400);
  }
  const [_sentAt, exp, expected] = stored.split("|");
  if (!expected || expected !== code) {
    return c.json({ error: { message: "验证码不正确", type: "bad_code" } }, 401);
  }
  if (Date.now() > Number(exp)) {
    await deleteSetting(c.env, key);
    return c.json({ error: { message: "验证码已过期，请重新获取", type: "code_expired" } }, 401);
  }
  const salt = generateSalt();
  const passwordHash = await hashPassword(newPassword, salt);
  await updateLocalUserPassword(c.env, sess.sub, passwordHash, salt);
  await deleteSetting(c.env, key);
  // Existing sessions stay valid until they expire (stateless JWT); the new
  // password takes effect on the next sign-in.
  return c.json({ ok: true });
});app.get("/me", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "sso not configured" }, 503);
  const sess = await getSession(c.env, c.req.raw);
  if (!sess) return c.json({ error: "not logged in" }, 401);
  const user = await getUserBySub(c.env, sess.sub);
  const status = user
    ? user.status
    : sess.role === "admin"
      ? "approved"
      : "pending";
  return c.json({
    email: user?.email ?? sess.email,
    name: user?.name ?? null,
    role: user?.role ?? sess.role,
    status,
    sub: sess.sub,
  });
});

app.get("/logout", (c) => {
  c.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, true));
  return c.redirect("/");
});

app.post("/logout", (c) => {
  c.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, true));
  return c.json({ ok: true });
});

// ---------- local (email + password) accounts ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface AuthBody {
  email: string;
  password: string;
  name: string | null;
  isJson: boolean;
}

/** Read an auth request body: JSON (API clients) or form-urlencoded (native
 *  sign-in/sign-up pages). */
async function readAuthBody(c: Context<{ Bindings: Env }>): Promise<AuthBody> {
  const ct = (c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const b = (await c.req.json().catch(() => null)) as {
      email?: unknown;
      password?: unknown;
      name?: unknown;
    } | null;
    return {
      email: b && typeof b.email === "string" ? b.email.trim().toLowerCase() : "",
      password: b && typeof b.password === "string" ? b.password : "",
      name: b && typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : null,
      isJson: true,
    };
  }
  const b = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = str(b.name).trim();
  return {
    email: str(b.email).trim().toLowerCase(),
    password: str(b.password),
    name: name ? name.slice(0, 60) : null,
    isJson: false,
  };
}

/** JSON API callers get an error object; native form posts get a redirect
 *  back to the auth page with the message in ?error=. */
function authFail(
  c: Context<{ Bindings: Env }>,
  isJson: boolean,
  err: { message: string; type: string },
  status: 400 | 401 | 409 | 429 | 503,
  page: string
): Response {
  if (isJson) return c.json({ error: err }, status);
  return c.redirect(page + "?error=" + encodeURIComponent(err.message));
}

/** Server-rendered sign-in / sign-up page. Plain HTML form + POST redirect —
 *  no JS, no inline handlers, works in any browser/embedding context. */
async function authPage(
  c: Context<{ Bindings: Env }>,
  mode: "signin" | "signup",
  error: string | null,
  lang = "en"
): Promise<string> {
  let s: Record<string, string> = {};
  try { if (c.env.DB) s = await getAllSettings(c.env); } catch { s = {}; }
  const brand = escHtml(s.brand_name || c.env.BRAND_NAME || "keypool");
  const logo = s.logo || "";
  const favicon = s.favicon || "";
  const favHtml = favicon ? '<link rel="icon" href="' + escHtml(favicon) + '">' : '<link rel="icon" href="data:,">';
  const logoHtml = logo ? '<img class="logo-img" src="' + escHtml(logo) + '" alt="logo">' : '<span class="logo-dot"></span>';
  const isLogin = mode === "signin";
  const title = isLogin ? "登录" : "注册";
  const action = isLogin ? "/auth/login" : "/auth/register";
  const altHref = isLogin ? "/auth/signup" : "/auth/signin";
  const altLabel = isLogin ? "没有账号？" : "已有账号？";
  const altLink = isLogin ? "去注册" : "去登录";
  const errHtml = error ? '<div class="err">' + escHtml(error) + "</div>" : "";
  const nameField = isLogin
    ? ""
    : '<label>用户名（可选）<input type="text" name="name" maxlength="60" placeholder="怎么称呼你"></label>';
  const passHint = isLogin ? "" : '<div class="hint">密码至少 8 位。注册后即可开始使用。</div>';
  const autocomplete = isLogin ? "current-password" : "new-password";
  const langSwitchHtml = '<button type="button" onclick="setLang(\'' + (lang === "en" ? "zh" : "en") + '\')" style="margin-left:auto;background:none;border:none;color:#1a1a1a;font-weight:700;cursor:pointer;text-decoration:underline;padding:0;font-size:13px">' + (lang === "en" ? "中文" : "EN") + "</button>";
  const tpl = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${brand} · ${title}</title>${favHtml}<link rel="manifest" href="/manifest.json">${i18nScript(lang)}
<style>:root{color-scheme:light}body{margin:0;background:#fcfbf4;background-image:radial-gradient(#00000014 1px,transparent 1px);background-size:18px 18px;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}.wrap{max-width:440px;margin:0 auto;padding:48px 20px}.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px}.logo-dot{width:18px;height:18px;background:#e5484d;border:2px solid #1a1a1a;border-radius:55% 45% 60% 40%;display:inline-block}.logo-img{width:22px;height:22px;object-fit:contain;border-radius:5px;display:inline-block;vertical-align:middle}.card{background:#fffdf6;border:2.5px solid #1a1a1a;border-radius:16px 18px 14px 17px/17px 14px 18px 16px;box-shadow:3px 3px 0 #1a1a1a;padding:26px 24px;margin-top:18px}.card h2{margin:0 0 16px;font-size:20px}label{display:block;font-size:13px;font-weight:700;margin:12px 0 5px}input{width:100%;box-sizing:border-box;border:2px solid #1a1a1a;border-radius:8px;background:#fff;padding:10px 12px;font-size:14px}button{width:100%;margin-top:18px;background:#e5484d;color:#fff;border:2.5px solid #1a1a1a;border-radius:12px;box-shadow:2px 2px 0 #1a1a1a;padding:11px;font-size:15px;font-weight:800;cursor:pointer}button:hover{transform:translate(-1px,-1px)}.err{background:#fdecec;border:2px solid #e5484d;color:#b02318;border-radius:10px;padding:10px 12px;font-size:13.5px;font-weight:700;margin-bottom:6px}.hint{color:#777;font-size:12.5px;margin-top:12px;text-align:center}.hint a{color:#1a1a1a;font-weight:700}.back{display:inline-block;margin-top:16px;color:#777;font-size:13px;text-decoration:none}.back:hover{color:#1a1a1a}</style></head><body><div class="wrap"><div class="brand">${logoHtml}${brand}${langSwitchHtml}</div><div class="card"><h2>${title}</h2>${errHtml}<form method="post" action="${action}"><label>邮箱<input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label>${nameField}<label>密码<input type="password" name="password" required autocomplete="${autocomplete}"></label>${passHint}<button type="submit">${title}</button></form><div class="hint">${altLabel} <a href="${altHref}">${altLink}</a></div></div><a class="back" href="/">← 返回首页</a></div></body></html>`;  return translateAll(tpl, lang);
}

/** Server-rendered auth pages (native links + form POST, no JS required). */
app.get("/signin", async (c) => c.html(await authPage(c, "signin", c.req.query("error") ?? null, langFromCookie(c.req.header("cookie")))));
app.get("/signup", async (c) => c.html(await authPage(c, "signup", c.req.query("error") ?? null, langFromCookie(c.req.header("cookie")))));

/** Local registration. Creates a pending account (admin-approval gate, same as
 *  SSO signups) and auto-logs the user in. Accepts JSON (API) and
 *  form-urlencoded (native page) bodies; forms get a 302 redirect. */
app.post("/register", async (c) => {
  if (!c.env.SESSION_SECRET) {
    return c.json({ error: { message: "注册暂不可用", type: "not_configured" } }, 503);
  }
  const { email, password, name, isJson } = await readAuthBody(c);
  if (!EMAIL_RE.test(email)) {
    return authFail(c, isJson, { message: "邮箱格式不正确", type: "invalid_email" }, 400, "/auth/signup");
  }
  if (password.length < 8 || password.length > 128) {
    return authFail(c, isJson, { message: "密码长度需为 8-128 位", type: "invalid_password" }, 400, "/auth/signup");
  }
  if (await getLocalUserByEmail(c.env, email)) {
    return authFail(c, isJson, { message: "该邮箱已注册，请直接登录", type: "email_taken" }, 409, "/auth/signup");
  }
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  let user;
  try {
    user = await createLocalUser(c.env, { email, name, passwordHash, passwordSalt: salt });
  } catch {
    return authFail(c, isJson, { message: "该邮箱已注册，请直接登录", type: "email_taken" }, 409, "/auth/signup");
  }
  await issueSession(c, { sub: user.sub, email: user.email ?? email, name: user.name, role: user.role });
  if (!isJson) return c.redirect("/");
  return c.json({ ok: true, role: user.role, status: user.status, email: user.email ?? email });
});

/** Local login. Sets the kp_session cookie on success. Failed attempts are
 *  tracked per email; 5 consecutive failures lock the account for 15 minutes.
 *  Accepts JSON (API) and form-urlencoded (native page) bodies; forms get a
 *  302 redirect to "/" on success. */
app.post("/login", async (c) => {
  if (!c.env.SESSION_SECRET) {
    return c.json({ error: { message: "登录暂不可用", type: "not_configured" } }, 503);
  }
  const { email, password, isJson } = await readAuthBody(c);
  if (!email || !password) {
    return authFail(c, isJson, { message: "请输入邮箱和密码", type: "missing_fields" }, 400, "/auth/signin");
  }

  const lockedUntil = await loginLockedUntil(c.env, email);
  if (lockedUntil) {
    return authFail(c, isJson, { message: "尝试次数过多，请 15 分钟后再试", type: "locked" }, 429, "/auth/signin");
  }

  const user = await getLocalUserByEmail(c.env, email);
  let ok = false;
  if (user && user.password_hash && user.password_salt) {
    ok = await verifyPassword(password, user.password_salt, user.password_hash);
  } else {
    // Burn comparable work for unknown accounts to blunt user-enumeration timing.
    await hashPassword(password, generateSalt());
  }
  if (!ok) {
    await recordLoginFail(c.env, email);
    return authFail(c, isJson, { message: "邮箱或密码错误", type: "bad_credentials" }, 401, "/auth/signin");
  }
  await clearLoginFails(c.env, email);
  await issueSession(c, { sub: user!.sub, email: user!.email ?? email, name: user!.name, role: user!.role });
  if (!isJson) return c.redirect("/");
  return c.json({ ok: true, role: user!.role, status: user!.status, email: user!.email ?? email });
});

export default app;