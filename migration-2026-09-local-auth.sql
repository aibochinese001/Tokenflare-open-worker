-- Migration: local (email+password) accounts for the existing remote D1.
-- Idempotent-ish: ALTER ... ADD COLUMN fails if the column already exists;
-- run only once on the live database.
ALTER TABLE keypool_gateway_users ADD COLUMN password_hash TEXT;
ALTER TABLE keypool_gateway_users ADD COLUMN password_salt TEXT;

CREATE TABLE IF NOT EXISTS keypool_gateway_login_attempts (
  k           TEXT PRIMARY KEY,
  fails       INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at  INTEGER NOT NULL
);
