-- keypool-gateway D1 schema
-- Apply with:  wrangler d1 execute keypool --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS keypool_gateway_api_keys (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT    NOT NULL,                 -- gemini | mistral | openrouter
  api_key           TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active', -- active | cooldown | disabled
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  total_requests    INTEGER NOT NULL DEFAULT 0,
  total_fails       INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_used_at      INTEGER,                           -- epoch ms
  last_probed_at    INTEGER,                           -- epoch ms of last liveness probe (NULL = due now)
  cooldown_until    INTEGER,                           -- epoch ms
  disabled_reason   TEXT,
  created_at        INTEGER NOT NULL,                  -- epoch ms
  project_id        TEXT,                              -- e.g. gemini Google project number
  balance_remaining REAL,                              -- last-probed upstream balance (NULL = unknown / provider has no balance API)
  balance_unit      TEXT,                              -- e.g. "USD" | "credits"
  UNIQUE(provider, api_key)
);

CREATE INDEX IF NOT EXISTS keypool_gateway_idx_keys_provider_status ON keypool_gateway_api_keys(provider, status);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_keys_status_cooldown ON keypool_gateway_api_keys(status, cooldown_until);
-- Rotating-sweep cursor: pick the least-recently-probed keys first, at scale.
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_keys_probed ON keypool_gateway_api_keys(last_probed_at);

CREATE TABLE IF NOT EXISTS keypool_gateway_access_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT    NOT NULL UNIQUE,
  name       TEXT,
  role       TEXT    NOT NULL DEFAULT 'user',          -- user | admin
  enabled    INTEGER NOT NULL DEFAULT 1,
  expires_at     INTEGER,
  rpm_limit      INTEGER,
  quota_requests INTEGER,
  used_requests  INTEGER NOT NULL DEFAULT 0,
  owner_sub  TEXT,                                      -- OIDC subject of owner (NULL = admin-minted)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keypool_gateway_users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sub         TEXT NOT NULL UNIQUE,      -- OIDC subject, or 'local:<email>' for local accounts
  email       TEXT,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'user',     -- admin | user
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | blocked
  created_at  INTEGER NOT NULL,
  approved_at INTEGER,
  balance_micro INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,                    -- PBKDF2-SHA256, base64url (local accounts only)
  password_salt TEXT                     -- per-user random salt, base64url
);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_users_status ON keypool_gateway_users(status);

-- Failed-login lockout for local accounts (keyed on lowercase email).
CREATE TABLE IF NOT EXISTS keypool_gateway_login_attempts (
  k           TEXT PRIMARY KEY,
  fails       INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keypool_gateway_request_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT    NOT NULL,
  key_id      INTEGER,
  model       TEXT,
  status_code INTEGER,
  latency_ms  INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  token_id    INTEGER,
  owner_sub   TEXT,
  total_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  final       INTEGER NOT NULL DEFAULT 0,  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS keypool_gateway_idx_logs_created ON keypool_gateway_request_logs(created_at);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_logs_owner ON keypool_gateway_request_logs(owner_sub, created_at);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_logs_final ON keypool_gateway_request_logs(final, created_at);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_logs_token ON keypool_gateway_request_logs(token_id, created_at);

CREATE TABLE IF NOT EXISTS keypool_gateway_transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sub                 TEXT    NOT NULL,
  kind                TEXT    NOT NULL,           -- topup | charge
  amount_micro        INTEGER NOT NULL,
  balance_after_micro INTEGER NOT NULL,
  model               TEXT,
  tokens              INTEGER,
  note                TEXT,
  estimated           INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_txn_sub ON keypool_gateway_transactions(sub, created_at);

CREATE TABLE IF NOT EXISTS keypool_gateway_prices (
  model                TEXT PRIMARY KEY,
  price_per_mtok_micro INTEGER NOT NULL,
  input_per_mtok_micro INTEGER,
  output_per_mtok_micro INTEGER,         -- micro-USD per 1M tokens
  cached_input_per_mtok_micro INTEGER    -- cache-hit input price; NULL = same as input
);

CREATE TABLE IF NOT EXISTS keypool_gateway_payment_events (
  event_id   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keypool_gateway_model_status (
  model        TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  available    INTEGER NOT NULL DEFAULT 1,
  last_checked INTEGER,
  reason       TEXT
);
