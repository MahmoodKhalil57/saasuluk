-- 0005: shipping + tax (computed by the @suluk/stripe adapters). product.requires_shipping marks a PHYSICAL good;
-- the order records the shipping fee, tax, and chosen method so the total = subtotal − discount + shipping + tax
-- is reproducible. D1 ALTER TABLE ADD COLUMN; new columns carry defaults so existing rows stay valid. "order" quoted.
ALTER TABLE product ADD COLUMN requires_shipping INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order" ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order" ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order" ADD COLUMN shipping_method TEXT;
