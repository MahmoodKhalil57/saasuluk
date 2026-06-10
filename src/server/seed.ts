/**
 * The meta seed — the store sells the code that renders it. ONE structured source: the typed arrays below ARE
 * the demo content, and SEED_SQL is GENERATED from them (no hand-written SQL to drift). The dev DB runs SEED_SQL
 * on boot; `scripts/seed.sql` (from `gen:seed`) is applied to the remote D1; and the static detail pages
 * (products/[slug], blogs/[slug]) import the same arrays to SERVER-RENDER real content (premium + SEO).
 * Idempotent — fixed ids + INSERT OR REPLACE.
 */
const T = 1780000000000; // a fixed timestamp so the seed is deterministic

export interface SeedProduct { id: number; name: string; slug: string; description: string; priceCents: number; categoryId: number; inventory: number; status: "draft" | "published" }
export interface SeedPost { id: number; title: string; slug: string; excerpt: string; body: string; author: string }
export interface SeedFaq { id: number; question: string; answer: string }
export interface SeedReview { id: number; productId: number; customerId: string; rating: number; title: string; body: string; helpfulCount: number }
export interface SeedDiscount { id: number; code: string; discountType: "percent" | "fixed"; discountValue: number; maxUses: number | null }

export const SEED_CATEGORIES = [
  { id: 1, name: "Starter Tiers", slug: "tiers" },
  { id: 2, name: "Modules", slug: "modules" },
  { id: 3, name: "Templates", slug: "templates" },
];

export const SEED_PRODUCTS: SeedProduct[] = [
  { id: 1, name: "Frontend Lite", slug: "frontend-lite", description: "The marketing surface — landing, SEO, shadcn UI, light/dark themes, and i18n with RTL. Static, fast, premium.", priceCents: 2900, categoryId: 1, inventory: 999, status: "published" },
  { id: 2, name: "Frontend Pro", slug: "frontend-pro", description: "Everything in Lite plus Better Auth pages, magic-link sign-in, a PWA with an offline shell, and derived avatars.", priceCents: 9900, categoryId: 1, inventory: 999, status: "published" },
  { id: 3, name: "Full-Stack Lite", slug: "fullstack-lite", description: "The backend: the admin cockpit, products, cart and checkout, a Cloudflare D1 database, and the typed v4 contract.", priceCents: 19900, categoryId: 1, inventory: 999, status: "published" },
  { id: 4, name: "Full-Stack Pro", slug: "fullstack-pro", description: "The whole platform: Stripe billing meters, orders, discounts, reviews, the live cost ledger, and the API-token developer portal.", priceCents: 29900, categoryId: 1, inventory: 999, status: "published" },
  { id: 5, name: "Ecommerce Module", slug: "ecommerce-module", description: "Products, variants, carts, orders, discounts, reviews and wishlists — mergeable entities in the contract, not a plugin.", priceCents: 4900, categoryId: 2, inventory: 999, status: "published" },
  { id: 6, name: "Auth Module", slug: "auth-module", description: "Better Auth (email/password, bearer, admin, magic-link) ingested into the v4 contract — securitySchemes + principal.", priceCents: 3900, categoryId: 2, inventory: 999, status: "published" },
  { id: 7, name: "Cost Ledger", slug: "cost-ledger", description: "Meter every request: frontend action to operation to third party. Honest, raw cost at /cost — the moat.", priceCents: 2900, categoryId: 2, inventory: 999, status: "published" },
  { id: 8, name: "Admin Cockpit", slug: "admin-cockpit", description: "The /superadmin panel — the same brain as the Suluk VS Code extension, rendered from the contract.", priceCents: 5900, categoryId: 2, inventory: 999, status: "published" },
  { id: 9, name: "Stripe Billing", slug: "stripe-billing", description: "Billing Meters: usage becomes an invoice. Price is your cost plus your margin — nothing hidden.", priceCents: 4500, categoryId: 2, inventory: 999, status: "published" },
  { id: 10, name: "The saasuluk Starter", slug: "saasuluk-starter", description: "This entire repository — every page, entity, operation and the deploy. The store you are standing in.", priceCents: 0, categoryId: 3, inventory: 999, status: "published" },
];

export const SEED_DISCOUNTS: SeedDiscount[] = [
  { id: 1, code: "SHIP20", discountType: "percent", discountValue: 20, maxUses: null },
  { id: 2, code: "LAUNCH30", discountType: "percent", discountValue: 30, maxUses: 200 },
  { id: 3, code: "TENOFF", discountType: "fixed", discountValue: 1000, maxUses: null },
];

export const SEED_REVIEWS: SeedReview[] = [
  { id: 1, productId: 4, customerId: "ada", rating: 5, title: "Shipped in a weekend", body: "Auth, payments, admin, docs — all wired. I changed the entities and everything followed.", helpfulCount: 14 },
  { id: 2, productId: 4, customerId: "lin", rating: 5, title: "The cost ledger sold me", body: "Seeing real per-request cost trace from the button to the third party is something no other starter does.", helpfulCount: 9 },
  { id: 3, productId: 5, customerId: "rob", rating: 4, title: "Composes cleanly", body: "Installed the ecommerce entities and the whole cockpit lit up. The contract really is one source.", helpfulCount: 5 },
  { id: 4, productId: 3, customerId: "mei", rating: 5, title: "D1 + the contract = fast", body: "Edge-native out of the box. The generated client and UI matched the API because they are the same source.", helpfulCount: 7 },
];

export const SEED_POSTS: SeedPost[] = [
  { id: 1, title: "One contract beats a dozen tools", slug: "one-contract", excerpt: "Most starters glue together a dozen tools that each hold their own copy of the truth. They drift. Suluk inverts that.", body: "You declare your entities once (Drizzle) and your verbs once (Hono + Zod). The OpenAPI v4 document is derived — and the Scalar docs, the typed client, the shadcn UI, the admin cockpit, the cost meter and the deploy plan all read from that one document. Nothing is hand-synced, so nothing can drift. This post walks through the registry that drives all 15 entities and 12 operations of this very store.", author: "team" },
  { id: 2, title: "Cost as a first-class fact", slug: "cost-as-a-fact", excerpt: "Pricing is the cost plus your margin. So why do most apps hide the cost? saasuluk shows it — raw.", body: "Every request is metered: the frontend action that triggered it, the operation it hit, and the third-party resources it consumed. Those events stream to a durable ledger you can read at /cost and meter to Stripe Billing. When the cost is a fact instead of a guess, usage-based pricing stops being spreadsheet math.", author: "team" },
  { id: 3, title: "A store that sells its own source", slug: "meta-store", excerpt: "This site is a demo and a product at the same time: the things in the cart are the code that renders the cart.", body: "It sounds like a gimmick, but it is the honest demo. The four tiers in the store are the real slices of this repository. Add Full-Stack Pro to the cart, run the metered checkout, and the order, the cost event, and the admin row are all projected from the same contract you just bought. The medium is the message.", author: "team" },
];

export const SEED_FAQS: SeedFaq[] = [
  { id: 1, question: "What is Suluk?", answer: "A candidate exploration of OpenAPI v4 (the \"Moonwalk\" SIG direction). It turns one typed contract into every layer of a full-stack app — data, API, docs, client, UI, admin, and cost." },
  { id: 2, question: "How is this different from saastarter?", answer: "saastarter glues a dozen tools together, each holding its own copy of the truth. saasuluk projects every layer from one contract, so they cannot drift — and it ships a live cost ledger no other starter has." },
  { id: 3, question: "Can I self-host?", answer: "Yes. The whole stack is Cloudflare-native: Hono on Workers, Drizzle on D1, the Astro build as static assets. One command deploys it; the deploy target is swappable." },
  { id: 4, question: "How does billing work?", answer: "Each request is metered to a durable cost ledger. Those events become Stripe Billing Meter events; you charge the metered cost plus your margin. See /cost for the raw data." },
  { id: 5, question: "Is it production-ready?", answer: "It is a candidate framework — a serious exploration, fully tested, deployed live. Use it to prototype fast; harden the pieces you ship, as with any starter." },
];

// ── SQL generation (one source → the DDL inserts) ────────────────────────────────────────────────────────────
const q = (s: string) => "'" + String(s ?? "").replace(/'/g, "''") + "'";
const nq = (v: number | null) => (v == null ? "NULL" : String(v));

export const SEED_SQL = [
  "INSERT OR REPLACE INTO category (id, name, slug) VALUES\n  " +
    SEED_CATEGORIES.map((c) => `(${c.id}, ${q(c.name)}, ${q(c.slug)})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO product (id, name, slug, description, price_cents, category_id, inventory, image_url, status) VALUES\n  " +
    SEED_PRODUCTS.map((p) => `(${p.id}, ${q(p.name)}, ${q(p.slug)}, ${q(p.description)}, ${p.priceCents}, ${p.categoryId}, ${p.inventory}, NULL, ${q(p.status)})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO discount_code (id, code, discount_type, discount_value, is_active, current_uses, max_uses, expires_at) VALUES\n  " +
    SEED_DISCOUNTS.map((d) => `(${d.id}, ${q(d.code)}, ${q(d.discountType)}, ${d.discountValue}, 1, 0, ${nq(d.maxUses)}, NULL)`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO review (id, product_id, customer_id, rating, title, body, status, helpful_count, created_at) VALUES\n  " +
    SEED_REVIEWS.map((r) => `(${r.id}, ${r.productId}, ${q(r.customerId)}, ${r.rating}, ${q(r.title)}, ${q(r.body)}, 'published', ${r.helpfulCount}, ${T})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO post (id, title, slug, excerpt, body, status, published_at, author_id, cover_image_url) VALUES\n  " +
    SEED_POSTS.map((p) => `(${p.id}, ${q(p.title)}, ${q(p.slug)}, ${q(p.excerpt)}, ${q(p.body)}, 'published', ${T}, ${q(p.author)}, NULL)`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO faq (id, question, answer, sort_order, is_active) VALUES\n  " +
    SEED_FAQS.map((f, i) => `(${f.id}, ${q(f.question)}, ${q(f.answer)}, ${i}, 1)`).join(",\n  ") + ";",
].join("\n\n");
