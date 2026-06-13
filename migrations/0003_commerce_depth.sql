-- Wave 1 — commerce data floor: the relational/array shapes the flat projection dropped (galleries, variant
-- options/images, rich discount rules, order address + email snapshot, address book, idempotent helpful votes).
-- D1 supports ALTER TABLE ADD COLUMN; new columns carry defaults so existing rows stay valid.

ALTER TABLE product ADD COLUMN long_description TEXT;
ALTER TABLE product ADD COLUMN images TEXT;
ALTER TABLE product ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;

ALTER TABLE variant ADD COLUMN options TEXT;
ALTER TABLE variant ADD COLUMN images TEXT;
ALTER TABLE variant ADD COLUMN price_cents_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE discount_code ADD COLUMN description TEXT;
ALTER TABLE discount_code ADD COLUMN min_subtotal_cents INTEGER;
ALTER TABLE discount_code ADD COLUMN max_discount_cents INTEGER;
ALTER TABLE discount_code ADD COLUMN max_uses_per_customer INTEGER;
ALTER TABLE discount_code ADD COLUMN applies_to_product_ids TEXT;
ALTER TABLE discount_code ADD COLUMN starts_at INTEGER;

ALTER TABLE "order" ADD COLUMN customer_email TEXT;
ALTER TABLE "order" ADD COLUMN shipping_address TEXT;

ALTER TABLE review ADD COLUMN verified_purchase INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS review_helpful_vote (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER NOT NULL, principal TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS review_helpful_vote_uniq ON review_helpful_vote (review_id, principal);

CREATE TABLE IF NOT EXISTS address (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, name TEXT, line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, state TEXT, postal_code TEXT, country TEXT NOT NULL DEFAULT 'US', is_default INTEGER NOT NULL DEFAULT 0);
