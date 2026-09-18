-- Migration 2026-09-18: payment gateway config + orders.
CREATE TABLE IF NOT EXISTS keypool_gateway_pay_config (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS keypool_gateway_pay_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no    TEXT NOT NULL UNIQUE,
  sub         TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  method      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | paid
  trade_no    TEXT,
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER
);
CREATE INDEX IF NOT EXISTS keypool_gateway_idx_pay_orders_sub ON keypool_gateway_pay_orders(sub, created_at);
