/**
 * Worker entrypoint: Hono app wiring + `export default { fetch, scheduled }`.
 *
 * Mounts the admin sub-app at `/admin`, the OpenAI-compatible sub-app at `/v1`,
 * and the native passthrough sub-app at the root (it self-prefixes its routes
 * with `/gemini/*`, `/mistral/*`, `/openrouter/*`). `GET /healthz` is unauthed
 * and returns a stats summary. The cron trigger runs the key-pool health check.
 */

import { Hono } from "hono";
import type { Env } from "./types";
import { runCheckAll, probeModels } from "./probe";
import { cleanupOldRecords, getAllSettings } from "./db";
import { adminPage } from "./ui";
import { langFromCookie } from "./i18n";
import auth from "./oidc";
import admin from "./routes/admin";
import me from "./routes/me";
import openai from "./routes/openai";
import passthrough from "./routes/passthrough";
import pay from "./routes/pay";

// strict:false so a trailing slash (e.g. `/v1/chat/completions/` sent by some
// OpenAI-compatible clients) still matches the route instead of 404ing.
const app = new Hono<{ Bindings: Env }>({ strict: false });

// Role-routed admin/consumer console (self-contained HTML). Auth is enforced
// by the API routes it calls (SSO session or bearer token).
app.get("/", async (c) => c.html(await adminPage(c.env, langFromCookie(c.req.header("cookie")))));

// Public liveness probe — intentionally minimal (no pool inventory leak).
app.get("/healthz", (c) => c.json({ ok: true }));

// PWA: web app manifest (installable app metadata, icons from site settings).
app.get("/manifest.json", async (c) => {
  const s = await getAllSettings(c.env);
  const brand = s.brand_name || c.env.BRAND_NAME || "keypool";
  const logo = s.logo || s.favicon || "";
  const icons = logo
    ? [
        { src: logo, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: logo, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]
    : [];
  return c.json({
    name: brand,
    short_name: (brand || "keypool").slice(0, 12),
    description: "Multi-model API Key gateway",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fcfbf4",
    theme_color: "#fcfbf4",
    icons,
  });
});

// PWA: minimal service worker — network-first for navigation (offline fallback
// to the last cached page), cache-first for same-origin static assets.
const SW_SOURCE = String.raw`var V='llm-v1';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  var r=e.request;
  if(r.method!=='GET'||r.url.indexOf(self.location.origin)!==0)return;
  if(r.url.indexOf('/sw.js')>=0||r.url.indexOf('/manifest.json')>=0||r.url.indexOf('/auth/')>=0||r.url.indexOf('/admin/')>=0||r.url.indexOf('/me/')>=0||r.url.indexOf('/v1/')>=0||r.url.indexOf('/pay/')>=0)return;
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).then(function(res){
      var cl=res.clone();
      caches.open(V).then(function(c){c.put(r,cl);});
      return res;
    }).catch(function(){return caches.match(r).then(function(m){return m||caches.match('/');});}));
  } else {
    e.respondWith(caches.match(r).then(function(m){
      return m||fetch(r).then(function(res){
        var cl=res.clone();
        caches.open(V).then(function(c){c.put(r,cl);});
        return res;
      });
    }));
  }
});`;
app.get("/sw.js", (c) =>
  new Response(SW_SOURCE, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
    },
  })
);

// RFC 9728 — OAuth 2.0 Protected Resource Metadata. This gateway is a
// token-protected API (an OIDC relying party, NOT an authorization server), so
// it advertises itself as a protected resource and points agents at its
// authorization server (the SSO IdP) to obtain tokens.
app.get("/.well-known/oauth-protected-resource", (c) => {
  const as = (c.env.OIDC_ISSUER || "https://your-idp.example.com").replace(/\/$/, "");
  return c.json({
    resource: new URL(c.req.url).origin,
    authorization_servers: [as],
    scopes_supported: ["openid", "profile", "email"],
    bearer_methods_supported: ["header"],
  });
});

app.route("/pay", pay);
app.route("/auth", auth);
app.route("/admin", admin);
app.route("/me", me);
app.route("/v1", openai);
app.route("/", passthrough);

const scheduled = (
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): void => {
  // Automatic health-check on the cron tick: revive recovered keys, disable
  // dead, then refresh per-model availability.
  ctx.waitUntil(runCheckAll(env).then(() => probeModels(env)));
  // Retention cleanup (transactions / orders / logs) — throttled to 1x/day.
  ctx.waitUntil(cleanupOldRecords(env));
};

export default {
  fetch: app.fetch,
  scheduled,
};
