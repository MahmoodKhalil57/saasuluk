-- generated from src/server/seed.ts — do not edit by hand. Apply to D1:
--   wrangler d1 execute saasuluk-db --file=./scripts/seed.sql --remote

INSERT OR REPLACE INTO category (id, name, slug) VALUES
  (1, 'Starter Tiers', 'tiers'),
  (2, 'Modules', 'modules'),
  (3, 'Templates', 'templates');

INSERT OR REPLACE INTO product (id, name, slug, description, long_description, price_cents, category_id, inventory, image_url, images, featured, status) VALUES
  (1, 'Frontend Lite', 'frontend-lite', 'The marketing surface — landing, SEO, shadcn UI, light/dark themes, and i18n with RTL. Static, fast, premium.', NULL, 2900, 1, 999, '/img/products/frontend-lite.jpg', '[{"url":"/img/products/frontend-lite.jpg"}]', 0, 'published'),
  (2, 'Frontend Pro', 'frontend-pro', 'Everything in Lite plus Better Auth pages, magic-link sign-in, a PWA with an offline shell, and derived avatars.', NULL, 9900, 1, 999, '/img/products/frontend-pro.jpg', '[{"url":"/img/products/frontend-pro.jpg"}]', 0, 'published'),
  (3, 'Full-Stack Lite', 'fullstack-lite', 'The backend: the admin cockpit, products, cart and checkout, a Cloudflare D1 database, and the typed v4 contract.', NULL, 19900, 1, 999, '/img/products/fullstack-lite.jpg', '[{"url":"/img/products/fullstack-lite.jpg"}]', 0, 'published'),
  (4, 'Full-Stack Pro', 'fullstack-pro', 'The whole platform: Stripe billing meters, orders, discounts, reviews, the live cost ledger, and the API-token developer portal.', NULL, 29900, 1, 999, '/img/products/fullstack-pro.jpg', '[{"url":"/img/products/fullstack-pro.jpg"}]', 0, 'published'),
  (5, 'Ecommerce Module', 'ecommerce-module', 'Products, variants, carts, orders, discounts, reviews and wishlists — mergeable entities in the contract, not a plugin.', NULL, 4900, 2, 999, '/img/products/ecommerce-module.jpg', '[{"url":"/img/products/ecommerce-module.jpg"}]', 0, 'published'),
  (6, 'Auth Module', 'auth-module', 'Better Auth (email/password, bearer, admin, magic-link) ingested into the v4 contract — securitySchemes + principal.', NULL, 3900, 2, 999, '/img/products/auth-module.jpg', '[{"url":"/img/products/auth-module.jpg"}]', 0, 'published'),
  (7, 'Cost Ledger', 'cost-ledger', 'Meter every request: frontend action to operation to third party. Honest, raw cost at /cost — the moat.', NULL, 2900, 2, 999, '/img/products/cost-ledger.jpg', '[{"url":"/img/products/cost-ledger.jpg"}]', 0, 'published'),
  (8, 'Admin Cockpit', 'admin-cockpit', 'The /superadmin panel — the same brain as the Suluk VS Code extension, rendered from the contract.', NULL, 5900, 2, 999, '/img/products/admin-cockpit.jpg', '[{"url":"/img/products/admin-cockpit.jpg"}]', 0, 'published'),
  (9, 'Stripe Billing', 'stripe-billing', 'Billing Meters: usage becomes an invoice. Price is your cost plus your margin — nothing hidden.', NULL, 4500, 2, 999, '/img/products/stripe-billing.jpg', '[{"url":"/img/products/stripe-billing.jpg"}]', 0, 'published'),
  (10, 'The saasuluk Starter', 'saasuluk-starter', 'This entire repository — every page, entity, operation and the deploy. The store you are standing in.', 'The complete platform, free to clone. Every surface in this gallery is one of its modules — the marketing frontend, the auth pages, the full-stack backend, the admin cockpit, and the live cost ledger — all projected from one OpenAPI v4 contract. Add it to your cart and check out for **$0** to see the free-order flow end to end.', 0, 3, 999, '/img/products/saasuluk-starter.jpg', '[{"url":"/img/products/saasuluk-starter.jpg","alt":"The saasuluk storefront"},{"url":"/img/products/frontend-pro.jpg","alt":"Auth + PWA frontend"},{"url":"/img/products/fullstack-pro.jpg","alt":"Orders, billing, reviews"},{"url":"/img/products/admin-cockpit.jpg","alt":"The /superadmin cockpit"},{"url":"/img/products/cost-ledger.jpg","alt":"The live cost ledger"}]', 1, 'published'),
  (11, 'Saasuluk License', 'saasuluk-license', 'Commercial license for the saasuluk platform — pick the tier that matches your team. Personal is free.', 'One product, three tiers. **Personal** is free for solo builders; **Team** unlocks shared seats and priority updates; **Enterprise** adds an SLA and a private support channel. The price you see updates as you pick a tier — a real OpenAPI v4 variant, priced per-variant.', 0, 1, 999, '/img/products/stripe-billing.jpg', '[{"url":"/img/products/stripe-billing.jpg","alt":"Saasuluk License"}]', 1, 'published'),
  (12, 'Founder Tee', 'founder-tee', 'Heavyweight cotton crew-neck with the suluk mark. Pick your colour and size.', '100% combed ring-spun cotton, pre-shrunk, screen-printed suluk mark on the chest. Choose **Black** or **White** and your size — selecting a colour swaps the photo, selecting a size sets availability.', 2900, 3, 0, '/img/products/founder-tee-black.jpg', '[{"url":"/img/products/founder-tee-black.jpg","alt":"Founder Tee — Black"},{"url":"/img/products/founder-tee-white.jpg","alt":"Founder Tee — White"}]', 0, 'published');

INSERT OR REPLACE INTO variant (id, product_id, title, options, images, price_cents, price_cents_enabled, inventory) VALUES
  (1, 11, 'Personal', '[{"label":"Tier","value":"Personal"}]', NULL, 0, 1, 999),
  (2, 11, 'Team', '[{"label":"Tier","value":"Team"}]', NULL, 9900, 1, 999),
  (3, 11, 'Enterprise', '[{"label":"Tier","value":"Enterprise"}]', NULL, 29900, 1, 50),
  (100, 12, 'Black / S', '[{"label":"Color","value":"Black"},{"label":"Size","value":"S"}]', '[{"url":"/img/products/founder-tee-black.jpg","alt":"Founder Tee — Black"}]', 2900, 0, 6),
  (101, 12, 'Black / M', '[{"label":"Color","value":"Black"},{"label":"Size","value":"M"}]', '[{"url":"/img/products/founder-tee-black.jpg","alt":"Founder Tee — Black"}]', 2900, 0, 12),
  (102, 12, 'Black / L', '[{"label":"Color","value":"Black"},{"label":"Size","value":"L"}]', '[{"url":"/img/products/founder-tee-black.jpg","alt":"Founder Tee — Black"}]', 2900, 0, 9),
  (103, 12, 'Black / XL', '[{"label":"Color","value":"Black"},{"label":"Size","value":"XL"}]', '[{"url":"/img/products/founder-tee-black.jpg","alt":"Founder Tee — Black"}]', 2900, 0, 0),
  (104, 12, 'White / S', '[{"label":"Color","value":"White"},{"label":"Size","value":"S"}]', '[{"url":"/img/products/founder-tee-white.jpg","alt":"Founder Tee — White"}]', 2900, 0, 4),
  (105, 12, 'White / M', '[{"label":"Color","value":"White"},{"label":"Size","value":"M"}]', '[{"url":"/img/products/founder-tee-white.jpg","alt":"Founder Tee — White"}]', 2900, 0, 0),
  (106, 12, 'White / L', '[{"label":"Color","value":"White"},{"label":"Size","value":"L"}]', '[{"url":"/img/products/founder-tee-white.jpg","alt":"Founder Tee — White"}]', 2900, 0, 7),
  (107, 12, 'White / XL', '[{"label":"Color","value":"White"},{"label":"Size","value":"XL"}]', '[{"url":"/img/products/founder-tee-white.jpg","alt":"Founder Tee — White"}]', 2900, 0, 5);

INSERT OR REPLACE INTO discount_code (id, code, description, discount_type, discount_value, min_subtotal_cents, max_discount_cents, max_uses, max_uses_per_customer, is_active, current_uses, expires_at) VALUES
  (1, 'SHIP20', '20% off your order', 'percent', 20, NULL, NULL, NULL, NULL, 1, 0, NULL),
  (2, 'LAUNCH30', '30% off — capped at $50, launch promo', 'percent', 30, NULL, 5000, 200, NULL, 1, 0, NULL),
  (3, 'TENOFF', '$10 off orders over $40', 'fixed', 1000, 4000, NULL, NULL, NULL, 1, 0, NULL),
  (4, 'FREEBIE', '100% off — makes any cart free (one per customer)', 'percent', 100, NULL, NULL, NULL, 1, 1, 0, NULL);

INSERT OR REPLACE INTO review (id, product_id, customer_id, rating, title, body, status, helpful_count, created_at) VALUES
  (1, 4, 'ada', 5, 'Shipped in a weekend', 'Auth, payments, admin, docs — all wired. I changed the entities and everything followed.', 'published', 14, 1780000000000),
  (2, 4, 'lin', 5, 'The cost ledger sold me', 'Seeing real per-request cost trace from the button to the third party is something no other starter does.', 'published', 9, 1780000000000),
  (3, 5, 'rob', 4, 'Composes cleanly', 'Installed the ecommerce entities and the whole cockpit lit up. The contract really is one source.', 'published', 5, 1780000000000),
  (4, 3, 'mei', 5, 'D1 + the contract = fast', 'Edge-native out of the box. The generated client and UI matched the API because they are the same source.', 'published', 7, 1780000000000);

INSERT OR REPLACE INTO post (id, title, slug, excerpt, body, status, published_at, author_id, cover_image_url) VALUES
  (1, 'One contract beats a dozen tools', 'one-contract', 'Most starters glue together a dozen tools that each hold their own copy of the truth. They drift. Suluk inverts that.', 'You declare your entities once (Drizzle) and your verbs once (Hono + Zod). The OpenAPI v4 document is **derived** — every layer reads from that one document.

## What''s projected from the contract

- the Scalar docs and the typed client
- the shadcn UI and the admin cockpit
- the cost meter and the deploy plan

Nothing is hand-synced, so nothing can drift. Add an entity to the registry and it appears everywhere downstream:

```ts
{ name: ''Product'', table: products, access: ''public'' }
```

> Three tools holding three copies of the truth is three chances to disagree. One document can''t.', 'published', 1780000000000, 'team', '/img/blog/one-contract.jpg'),
  (2, 'Cost as a first-class fact', 'cost-as-a-fact', 'Pricing is the cost plus your margin. So why do most apps hide the cost? saasuluk shows it — raw.', 'Every request is metered: the **frontend action** that triggered it, the **operation** it hit, and the **third-party resources** it consumed.

## How a cost becomes a fact

- the action tags the request (`x-suluk-action`)
- the operation declares its cost model (`x-suluk-cost`)
- the events stream to a durable ledger at [/cost](/cost)

When the cost is a fact instead of a guess, usage-based pricing stops being spreadsheet math — you charge the metered cost plus your margin, metered straight to Stripe Billing.', 'published', 1780000000000, 'team', '/img/blog/cost-as-a-fact.jpg'),
  (3, 'A store that sells its own source', 'meta-store', 'This site is a demo and a product at the same time: the things in the cart are the code that renders the cart.', 'It sounds like a gimmick, but it is the honest demo. The four tiers in the store are the real slices of **this repository**.

Add *Full-Stack Pro* to the cart, run the metered checkout, and three things are projected from the same contract you just bought:

- the **order** row
- the **cost event**
- the **admin** row

> The medium is the message.

Browse the [store](/products) and watch the [cost ledger](/cost) move as you click.', 'published', 1780000000000, 'team', '/img/blog/meta-store.jpg');

INSERT OR REPLACE INTO faq (id, question, answer, sort_order, is_active) VALUES
  (1, 'What is Suluk?', 'A candidate exploration of OpenAPI v4 (the "Moonwalk" SIG direction). It turns one typed contract into every layer of a full-stack app — data, API, docs, client, UI, admin, and cost.', 0, 1),
  (2, 'How is this different from saastarter?', 'saastarter glues a dozen tools together, each holding its own copy of the truth. saasuluk projects every layer from one contract, so they cannot drift — and it ships a live cost ledger no other starter has.', 1, 1),
  (3, 'Can I self-host?', 'Yes. The whole stack is Cloudflare-native: Hono on Workers, Drizzle on D1, the Astro build as static assets. One command deploys it; the deploy target is swappable.', 2, 1),
  (4, 'How does billing work?', 'Each request is metered to a durable cost ledger. Those events become Stripe Billing Meter events; you charge the metered cost plus your margin. See /cost for the raw data.', 3, 1),
  (5, 'Is it production-ready?', 'It is a candidate framework — a serious exploration, fully tested, deployed live. Use it to prototype fast; harden the pieces you ship, as with any starter.', 4, 1);
