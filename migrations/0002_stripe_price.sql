-- Add the Stripe catalog price reference to the existing product table (run once on the remote D1):
--   wrangler d1 execute saasuluk-db --file=./migrations/0002_stripe_price.sql --remote
-- (Fresh DBs already get the column from 0000_domain.sql / schema.ts; this is the in-place ALTER for the live DB.)
ALTER TABLE product ADD COLUMN stripe_price_id TEXT;
