-- 0006: compare-at (was/MSRP) price for sale pricing. When compare_at_cents > price_cents the storefront shows a
-- strikethrough + a "Save N%" badge. Nullable (null ⇒ not on sale). D1 ALTER TABLE ADD COLUMN.
ALTER TABLE product ADD COLUMN compare_at_cents INTEGER;
