-- Migration 2026-09-18: add cache-hit input price column to the prices table.
-- NULL means "same as uncached input price" (backward compatible).
ALTER TABLE keypool_gateway_prices ADD COLUMN cached_input_per_mtok_micro INTEGER;
