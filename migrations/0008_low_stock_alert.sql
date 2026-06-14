-- Low-stock alert latch: a once-only flag so the owner is emailed exactly once when a product/variant crosses
-- below the threshold (re-armed on restock). Additive, ledger-tracked, runs once on prod D1. Mirrored in
-- schema.ts (Drizzle tables + SCHEMA_SQL) for the dev in-memory DB. Seeded rows reset to DEFAULT 0 on re-seed,
-- which re-arms the latch in lockstep with inventory being reset — consistent (see operations.ts markOrderPaid).
ALTER TABLE product ADD COLUMN low_stock_alerted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE variant ADD COLUMN low_stock_alerted INTEGER NOT NULL DEFAULT 0;
