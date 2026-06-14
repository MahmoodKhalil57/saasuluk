-- Back-in-stock waitlist: a shopper subscribes (email) to be notified when a sold-out product is restocked.
-- notified_at is stamped once the email is sent so a row is never re-notified. Additive, ledger-tracked, runs once.
-- Mirrored in schema.ts (Drizzle table + SCHEMA_SQL) for the dev in-memory DB.
CREATE TABLE IF NOT EXISTS stock_notification (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, email TEXT NOT NULL, created_at INTEGER, notified_at INTEGER);
