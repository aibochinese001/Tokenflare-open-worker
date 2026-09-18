/** Shared domain types — authoritative contract. Do not change signatures. */

export type Provider =
  | "gemini"
  | "mistral"
  | "openrouter"
  | "openai"
  | "deepseek"
  | "groq"
  | "moonshot"
  | "glm"
  | "qwen"
  | "deepinfra"
  | "fireworks"
  | "cerebras"
  | "ai21"
  | "cohere"
  | "elevenlabs"
  | "stability"
  | "channel"; // manual channel routing (base_url + api_key)

export const PROVIDERS: Provider[] = [
  "gemini",
  "mistral",
  "openrouter",
  "openai",
  "deepseek",
  "groq",
  "moonshot",
  "glm",
  "qwen",
  "deepinfra",
  "fireworks",
  "cerebras",
  "ai21",
  "cohere",
  "elevenlabs",
  "stability",
];

export interface Env {
  DB: D1Database;
  /** Master admin token (Worker secret). Grants admin + user access. */
  ADMIN_TOKEN: string;
  /** Minutes a key stays in cooldown after a rate-limit error. */
  COOLDOWN_MINUTES?: string;
  /** Max pooled keys to try per request. */
  MAX_KEY_RETRIES?: string;
  /** Minutes between cron probes of a disabled key. */
  PROBE_INTERVAL_MINUTES?: string;
  /** OIDC issuer base, e.g. https://your-idp.example.com */
  OIDC_ISSUER?: string;
  /** OIDC public client id registered for this gateway. */
  OIDC_CLIENT_ID?: string;
  /** Email granted admin role on SSO login; everyone else logs in as user. */
  ADMIN_EMAIL?: string;
  /** HMAC secret for signing session + PKCE cookies (Worker secret). */
  SESSION_SECRET?: string;
  /** Console branding (optional). */
  BRAND_NAME?: string;
  SSO_LABEL?: string;
  SSO_NOTE?: string;
  /** Set to "1" to enforce credit balances + charge per token. */
  BILLING_ENABLED?: string;
  /** Fallback price (micro-USD per 1M tokens) when a model isn't in the prices table. */
  DEFAULT_PRICE_MICRO?: string;
  /** Global sell discount on market prices (e.g. "0.1" = 1折). Default 1. */
  DISCOUNT?: string;
  /** Campaign signup bonus in USD granted once on a consumer's first login. */
  SIGNUP_BONUS_USD?: string;
  /** Stripe (Worker secrets) — online top-up; unset = payment disabled. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Public base URL for Stripe success/cancel redirects, e.g. https://ai.example.com */
  PUBLIC_BASE_URL?: string;
  /** ISO currency for top-ups (default "usd"). */
  CURRENCY?: string;
  /** Retention in days for transactions and paid orders (default 90). */
  TRANSACTION_RETENTION_DAYS?: string;
  /** Retention in days for unpaid pending orders (default 30). */
  PENDING_ORDER_RETENTION_DAYS?: string;
  /** Retention in days for request logs and payment events (default 30). */
  LOG_RETENTION_DAYS?: string;
}

export interface ApiKeyRow {
  id: number;
  provider: Provider;
  api_key: string;
  status: "active" | "cooldown" | "disabled";
  consecutive_fails: number;
  total_requests: number;
  total_fails: number;
  last_error: string | null;
  last_used_at: number | null;
  /** epoch ms of the last liveness probe (NULL = never / due now). Separate from
   *  last_used_at so the rotating sweep advances independently of real traffic. */
  last_probed_at: number | null;
  cooldown_until: number | null;
  disabled_reason: string | null;
  created_at: number;
  /** Provider account/project identifier (e.g. gemini Google project number). */
  project_id: string | null;
  /** Last-probed upstream balance (NULL = unknown / provider exposes none). */
  balance_remaining: number | null;
  /** Unit for `balance_remaining`, e.g. "USD" | "credits". */
  balance_unit: string | null;
}

/** Result of evaluating a single upstream call against one key. */
export type Outcome =
  | { kind: "ok" }
  | { kind: "disable"; reason: string }
  | { kind: "cooldown"; minutes: number; reason: string }
  | { kind: "transient"; reason: string };

export type Role = "admin" | "user";
