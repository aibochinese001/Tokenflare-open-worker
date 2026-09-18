-- System settings (branding / logo / favicon / floating contact / footer social).
CREATE TABLE IF NOT EXISTS keypool_gateway_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
