-- The whole saasuluk domain — kept in lockstep with src/server/schema.ts (SCHEMA_SQL). Apply to D1 with:
--   wrangler d1 execute saasuluk-db --file=./migrations/0000_domain.sql --remote
-- Better Auth owns its own users/sessions tables (migrations/0001_better_auth.sql).

CREATE TABLE IF NOT EXISTS category (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS product (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL DEFAULT 0, category_id INTEGER, inventory INTEGER NOT NULL DEFAULT 0, image_url TEXT, status TEXT NOT NULL DEFAULT 'draft');
CREATE TABLE IF NOT EXISTS variant (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, title TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, inventory INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS discount_code (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, current_uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS cart (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, items TEXT NOT NULL DEFAULT '[]', discount_code TEXT, status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS "order" (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, items TEXT NOT NULL DEFAULT '[]', total_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', discount_code TEXT, stripe_payment_intent_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS review (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, customer_id TEXT, rating INTEGER NOT NULL DEFAULT 5, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'pending', helpful_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS wishlist_item (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, product_id INTEGER NOT NULL, variant_id INTEGER, added_at INTEGER);
CREATE TABLE IF NOT EXISTS post (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL, excerpt TEXT, body TEXT, status TEXT NOT NULL DEFAULT 'draft', published_at INTEGER, author_id TEXT, cover_image_url TEXT);
CREATE TABLE IF NOT EXISTS faq (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS newsletter_subscriber (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, subscribed_at INTEGER);
CREATE TABLE IF NOT EXISTS contact_submission (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, alt TEXT NOT NULL, width INTEGER, height INTEGER);
CREATE TABLE IF NOT EXISTS report (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT, url TEXT NOT NULL, selector TEXT, element_html TEXT, element_css TEXT, page_info TEXT, user_info TEXT, build_id TEXT, screenshot TEXT, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER);
CREATE TABLE IF NOT EXISTS api_token (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT NOT NULL, prefix TEXT NOT NULL, hashed_key TEXT NOT NULL, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id TEXT, status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS billing_account (id INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, stripe_customer_id TEXT, subscription_id TEXT, last_reported_micro_usd INTEGER, last_reported_at INTEGER, created_at INTEGER);

CREATE TABLE IF NOT EXISTS cost_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  principal TEXT,
  operation TEXT NOT NULL,
  action TEXT,
  total_micro_usd INTEGER NOT NULL,
  breakdown TEXT NOT NULL
);
