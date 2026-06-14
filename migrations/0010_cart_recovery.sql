-- Abandoned-cart recovery: stamp when the one-time "you left items in your cart" email is sent, so the hourly cron
-- never re-emails a given pending order. Additive, ledger-tracked. "order" is a reserved word → quoted.
ALTER TABLE "order" ADD COLUMN recovery_emailed_at INTEGER;
