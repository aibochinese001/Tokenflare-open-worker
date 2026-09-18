-- Migration 2026-09-18: manual channel + channel model configuration.
CREATE TABLE IF NOT EXISTS keypool_gateway_channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  api_key    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS keypool_gateway_channel_models (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL,
  model_id      TEXT NOT NULL,
  input_per_mtok_micro        INTEGER NOT NULL DEFAULT 0,
  cached_input_per_mtok_micro INTEGER,
  output_per_mtok_micro       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE(channel_id, model_id)
);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_channel_models_model ON keypool_gateway_channel_models(model_id);
