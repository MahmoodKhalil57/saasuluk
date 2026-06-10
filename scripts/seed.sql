-- generated from src/server/seed.ts — do not edit by hand. Apply to D1:
--   wrangler d1 execute saasuluk-db --file=./scripts/seed.sql --remote

INSERT OR REPLACE INTO category (id, name, slug) VALUES
  (1, 'Starter Tiers', 'tiers'),
  (2, 'Modules', 'modules'),
  (3, 'Templates', 'templates');

INSERT OR REPLACE INTO product (id, name, slug, description, price_cents, category_id, inventory, image_url, status) VALUES
  (1, 'Frontend Lite', 'frontend-lite', 'The marketing surface — landing, SEO, shadcn UI, light/dark themes, and i18n with RTL. Static, fast, premium.', 2900, 1, 999, NULL, 'published'),
  (2, 'Frontend Pro', 'frontend-pro', 'Everything in Lite plus Better Auth pages, magic-link sign-in, a PWA with an offline shell, and derived avatars.', 9900, 1, 999, NULL, 'published'),
  (3, 'Full-Stack Lite', 'fullstack-lite', 'The backend: the admin cockpit, products, cart and checkout, a Cloudflare D1 database, and the typed v4 contract.', 19900, 1, 999, NULL, 'published'),
  (4, 'Full-Stack Pro', 'fullstack-pro', 'The whole platform: Stripe billing meters, orders, discounts, reviews, the live cost ledger, and the API-token developer portal.', 29900, 1, 999, NULL, 'published'),
  (5, 'Ecommerce Module', 'ecommerce-module', 'Products, variants, carts, orders, discounts, reviews and wishlists — mergeable entities in the contract, not a plugin.', 4900, 2, 999, NULL, 'published'),
  (6, 'Auth Module', 'auth-module', 'Better Auth (email/password, bearer, admin, magic-link) ingested into the v4 contract — securitySchemes + principal.', 3900, 2, 999, NULL, 'published'),
  (7, 'Cost Ledger', 'cost-ledger', 'Meter every request: frontend action to operation to third party. Honest, raw cost at /cost — the moat.', 2900, 2, 999, NULL, 'published'),
  (8, 'Admin Cockpit', 'admin-cockpit', 'The /superadmin panel — the same brain as the Suluk VS Code extension, rendered from the contract.', 5900, 2, 999, NULL, 'published'),
  (9, 'Stripe Billing', 'stripe-billing', 'Billing Meters: usage becomes an invoice. Price is your cost plus your margin — nothing hidden.', 4500, 2, 999, NULL, 'published'),
  (10, 'The saasuluk Starter', 'saasuluk-starter', 'This entire repository — every page, entity, operation and the deploy. The store you are standing in.', 0, 3, 999, NULL, 'published');

INSERT OR REPLACE INTO discount_code (id, code, discount_type, discount_value, is_active, current_uses, max_uses, expires_at) VALUES
  (1, 'SHIP20', 'percent', 20, 1, 0, NULL, NULL),
  (2, 'LAUNCH30', 'percent', 30, 1, 0, 200, NULL),
  (3, 'TENOFF', 'fixed', 1000, 1, 0, NULL, NULL);

INSERT OR REPLACE INTO review (id, product_id, customer_id, rating, title, body, status, helpful_count, created_at) VALUES
  (1, 4, 'ada', 5, 'Shipped in a weekend', 'Auth, payments, admin, docs — all wired. I changed the entities and everything followed.', 'published', 14, 1780000000000),
  (2, 4, 'lin', 5, 'The cost ledger sold me', 'Seeing real per-request cost trace from the button to the third party is something no other starter does.', 'published', 9, 1780000000000),
  (3, 5, 'rob', 4, 'Composes cleanly', 'Installed the ecommerce entities and the whole cockpit lit up. The contract really is one source.', 'published', 5, 1780000000000),
  (4, 3, 'mei', 5, 'D1 + the contract = fast', 'Edge-native out of the box. The generated client and UI matched the API because they are the same source.', 'published', 7, 1780000000000);

INSERT OR REPLACE INTO post (id, title, slug, excerpt, body, status, published_at, author_id, cover_image_url) VALUES
  (1, 'One contract beats a dozen tools', 'one-contract', 'Most starters glue together a dozen tools that each hold their own copy of the truth. They drift. Suluk inverts that.', 'You declare your entities once (Drizzle) and your verbs once (Hono + Zod). The OpenAPI v4 document is derived — and the Scalar docs, the typed client, the shadcn UI, the admin cockpit, the cost meter and the deploy plan all read from that one document. Nothing is hand-synced, so nothing can drift. This post walks through the registry that drives all 15 entities and 12 operations of this very store.', 'published', 1780000000000, 'team', NULL),
  (2, 'Cost as a first-class fact', 'cost-as-a-fact', 'Pricing is the cost plus your margin. So why do most apps hide the cost? saasuluk shows it — raw.', 'Every request is metered: the frontend action that triggered it, the operation it hit, and the third-party resources it consumed. Those events stream to a durable ledger you can read at /cost and meter to Stripe Billing. When the cost is a fact instead of a guess, usage-based pricing stops being spreadsheet math.', 'published', 1780000000000, 'team', NULL),
  (3, 'A store that sells its own source', 'meta-store', 'This site is a demo and a product at the same time: the things in the cart are the code that renders the cart.', 'It sounds like a gimmick, but it is the honest demo. The four tiers in the store are the real slices of this repository. Add Full-Stack Pro to the cart, run the metered checkout, and the order, the cost event, and the admin row are all projected from the same contract you just bought. The medium is the message.', 'published', 1780000000000, 'team', NULL);

INSERT OR REPLACE INTO faq (id, question, answer, sort_order, is_active) VALUES
  (1, 'What is Suluk?', 'A candidate exploration of OpenAPI v4 (the "Moonwalk" SIG direction). It turns one typed contract into every layer of a full-stack app — data, API, docs, client, UI, admin, and cost.', 0, 1),
  (2, 'How is this different from saastarter?', 'saastarter glues a dozen tools together, each holding its own copy of the truth. saasuluk projects every layer from one contract, so they cannot drift — and it ships a live cost ledger no other starter has.', 1, 1),
  (3, 'Can I self-host?', 'Yes. The whole stack is Cloudflare-native: Hono on Workers, Drizzle on D1, the Astro build as static assets. One command deploys it; the deploy target is swappable.', 2, 1),
  (4, 'How does billing work?', 'Each request is metered to a durable cost ledger. Those events become Stripe Billing Meter events; you charge the metered cost plus your margin. See /cost for the raw data.', 3, 1),
  (5, 'Is it production-ready?', 'It is a candidate framework — a serious exploration, fully tested, deployed live. Use it to prototype fast; harden the pieces you ship, as with any starter.', 4, 1);
