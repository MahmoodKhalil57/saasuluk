/**
 * The meta seed — the store sells the code that renders it. ONE structured source: the typed arrays below ARE
 * the demo content, and SEED_SQL is GENERATED from them (no hand-written SQL to drift). The dev DB runs SEED_SQL
 * on boot; `scripts/seed.sql` (from `gen:seed`) is applied to the remote D1; and the static detail pages
 * (products/[slug], blogs/[slug]) import the same arrays to SERVER-RENDER real content (premium + SEO).
 * Idempotent — fixed ids + INSERT OR REPLACE.
 */
const T = 1780000000000; // a fixed timestamp so the seed is deterministic

export interface SeedImage { url: string; alt?: string }
export interface SeedProduct { id: number; name: string; slug: string; description: string; longDescription?: string; priceCents: number; categoryId: number; inventory: number; status: "draft" | "published"; featured?: boolean; images?: SeedImage[] }
export interface SeedVariant { id: number; productId: number; title: string; options: { label: string; value: string }[]; priceCents: number; priceCentsEnabled: boolean; inventory: number; images?: SeedImage[] }
export interface SeedPost { id: number; title: string; slug: string; excerpt: string; body: string; author: string }
export interface SeedFaq { id: number; question: string; answer: string }
export interface SeedReview { id: number; productId: number; customerId: string; rating: number; title: string; body: string; helpfulCount: number }
export interface SeedDiscount { id: number; code: string; description?: string; discountType: "percent" | "fixed"; discountValue: number; maxUses: number | null; minSubtotalCents?: number; maxDiscountCents?: number; maxUsesPerCustomer?: number }

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
  { id: 10, name: "The saasuluk Starter", slug: "saasuluk-starter", description: "This entire repository — every page, entity, operation and the deploy. The store you are standing in.", priceCents: 0, categoryId: 3, inventory: 999, status: "published", featured: true,
    longDescription: "The complete platform, free to clone. Every surface in this gallery is one of its modules — the marketing frontend, the auth pages, the full-stack backend, the admin cockpit, and the live cost ledger — all projected from one OpenAPI v4 contract. Add it to your cart and check out for **$0** to see the free-order flow end to end.",
    images: [
      { url: "/img/products/saasuluk-starter.jpg", alt: "The saasuluk storefront" },
      { url: "/img/products/frontend-pro.jpg", alt: "Auth + PWA frontend" },
      { url: "/img/products/fullstack-pro.jpg", alt: "Orders, billing, reviews" },
      { url: "/img/products/admin-cockpit.jpg", alt: "The /superadmin cockpit" },
      { url: "/img/products/cost-ledger.jpg", alt: "The live cost ledger" },
    ] },
  // a TIER-variant product: one product, three priced variants (Personal $0 / Team $99 / Enterprise $299).
  { id: 11, name: "Saasuluk License", slug: "saasuluk-license", description: "Commercial license for the saasuluk platform — pick the tier that matches your team. Personal is free.", priceCents: 0, categoryId: 1, inventory: 999, status: "published", featured: true,
    longDescription: "One product, three tiers. **Personal** is free for solo builders; **Team** unlocks shared seats and priority updates; **Enterprise** adds an SLA and a private support channel. The price you see updates as you pick a tier — a real OpenAPI v4 variant, priced per-variant.",
    images: [{ url: "/img/products/stripe-billing.jpg", alt: "Saasuluk License" }] },
  // a SIZE × COLOR merch product: physical good, multiple option dimensions, per-color image swap.
  { id: 12, name: "Founder Tee", slug: "founder-tee", description: "Heavyweight cotton crew-neck with the suluk mark. Pick your colour and size.", priceCents: 2900, categoryId: 3, inventory: 0, status: "published",
    longDescription: "100% combed ring-spun cotton, pre-shrunk, screen-printed suluk mark on the chest. Choose **Black** or **White** and your size — selecting a colour swaps the photo, selecting a size sets availability.",
    images: [
      { url: "/img/products/founder-tee-black.jpg", alt: "Founder Tee — Black" },
      { url: "/img/products/founder-tee-white.jpg", alt: "Founder Tee — White" },
    ] },
];

// SIZE × COLOR variants for the Founder Tee (id 12) + the three license tiers (id 11). Generated below.
const TEE_BLACK = [{ url: "/img/products/founder-tee-black.jpg", alt: "Founder Tee — Black" }];
const TEE_WHITE = [{ url: "/img/products/founder-tee-white.jpg", alt: "Founder Tee — White" }];
function teeVariants(): SeedVariant[] {
  const out: SeedVariant[] = [];
  const colors = [{ value: "Black", img: TEE_BLACK, inv: { S: 6, M: 12, L: 9, XL: 0 } }, { value: "White", img: TEE_WHITE, inv: { S: 4, M: 0, L: 7, XL: 5 } }];
  const sizes = ["S", "M", "L", "XL"] as const;
  let id = 100;
  for (const c of colors) for (const s of sizes) {
    out.push({ id: id++, productId: 12, title: `${c.value} / ${s}`, options: [{ label: "Color", value: c.value }, { label: "Size", value: s }], priceCents: 2900, priceCentsEnabled: false, inventory: c.inv[s], images: c.img });
  }
  return out;
}
export const SEED_VARIANTS: SeedVariant[] = [
  { id: 1, productId: 11, title: "Personal", options: [{ label: "Tier", value: "Personal" }], priceCents: 0, priceCentsEnabled: true, inventory: 999 },
  { id: 2, productId: 11, title: "Team", options: [{ label: "Tier", value: "Team" }], priceCents: 9900, priceCentsEnabled: true, inventory: 999 },
  { id: 3, productId: 11, title: "Enterprise", options: [{ label: "Tier", value: "Enterprise" }], priceCents: 29900, priceCentsEnabled: true, inventory: 50 },
  ...teeVariants(),
];

export const SEED_DISCOUNTS: SeedDiscount[] = [
  { id: 1, code: "SHIP20", description: "20% off your order", discountType: "percent", discountValue: 20, maxUses: null },
  { id: 2, code: "LAUNCH30", description: "30% off — capped at $50, launch promo", discountType: "percent", discountValue: 30, maxUses: 200, maxDiscountCents: 5000 },
  { id: 3, code: "TENOFF", description: "$10 off orders over $40", discountType: "fixed", discountValue: 1000, maxUses: null, minSubtotalCents: 4000 },
  { id: 4, code: "FREEBIE", description: "100% off — makes any cart free (one per customer)", discountType: "percent", discountValue: 100, maxUses: null, maxUsesPerCustomer: 1 },
];

export const SEED_REVIEWS: SeedReview[] = [
  { id: 1, productId: 4, customerId: "ada", rating: 5, title: "Shipped in a weekend", body: "Auth, payments, admin, docs — all wired. I changed the entities and everything followed.", helpfulCount: 14 },
  { id: 2, productId: 4, customerId: "lin", rating: 5, title: "The cost ledger sold me", body: "Seeing real per-request cost trace from the button to the third party is something no other starter does.", helpfulCount: 9 },
  { id: 3, productId: 5, customerId: "rob", rating: 4, title: "Composes cleanly", body: "Installed the ecommerce entities and the whole cockpit lit up. The contract really is one source.", helpfulCount: 5 },
  { id: 4, productId: 3, customerId: "mei", rating: 5, title: "D1 + the contract = fast", body: "Edge-native out of the box. The generated client and UI matched the API because they are the same source.", helpfulCount: 7 },
];

export const SEED_POSTS: SeedPost[] = [
  { id: 1, title: "One contract beats a dozen tools", slug: "one-contract", excerpt: "Most starters glue together a dozen tools that each hold their own copy of the truth. They drift. Suluk inverts that.", body: "You declare your entities once (Drizzle) and your verbs once (Hono + Zod). The OpenAPI v4 document is **derived** — every layer reads from that one document.\n\n## What's projected from the contract\n\n- the Scalar docs and the typed client\n- the shadcn UI and the admin cockpit\n- the cost meter and the deploy plan\n\nNothing is hand-synced, so nothing can drift. Add an entity to the registry and it appears everywhere downstream:\n\n```ts\n{ name: 'Product', table: products, access: 'public' }\n```\n\n> Three tools holding three copies of the truth is three chances to disagree. One document can't.", author: "team" },
  { id: 2, title: "Cost as a first-class fact", slug: "cost-as-a-fact", excerpt: "Pricing is the cost plus your margin. So why do most apps hide the cost? saasuluk shows it — raw.", body: "Every request is metered: the **frontend action** that triggered it, the **operation** it hit, and the **third-party resources** it consumed.\n\n## How a cost becomes a fact\n\n- the action tags the request (`x-suluk-action`)\n- the operation declares its cost model (`x-suluk-cost`)\n- the events stream to a durable ledger at [/cost](/cost)\n\nWhen the cost is a fact instead of a guess, usage-based pricing stops being spreadsheet math — you charge the metered cost plus your margin, metered straight to Stripe Billing.", author: "team" },
  { id: 3, title: "A store that sells its own source", slug: "meta-store", excerpt: "This site is a demo and a product at the same time: the things in the cart are the code that renders the cart.", body: "It sounds like a gimmick, but it is the honest demo. The four tiers in the store are the real slices of **this repository**.\n\nAdd *Full-Stack Pro* to the cart, run the metered checkout, and three things are projected from the same contract you just bought:\n\n- the **order** row\n- the **cost event**\n- the **admin** row\n\n> The medium is the message.\n\nBrowse the [store](/products) and watch the [cost ledger](/cost) move as you click.", author: "team" },
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
const nq = (v: number | null | undefined) => (v == null ? "NULL" : String(v));
const qn = (s: string | null | undefined) => (s == null ? "NULL" : q(s)); // nullable quoted string

export const SEED_SQL = [
  "INSERT OR REPLACE INTO category (id, name, slug) VALUES\n  " +
    SEED_CATEGORIES.map((c) => `(${c.id}, ${q(c.name)}, ${q(c.slug)})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO product (id, name, slug, description, long_description, price_cents, category_id, inventory, image_url, images, featured, status) VALUES\n  " +
    SEED_PRODUCTS.map((p) => { const imgs = p.images ?? [{ url: `/img/products/${p.slug}.jpg` }]; return `(${p.id}, ${q(p.name)}, ${q(p.slug)}, ${q(p.description)}, ${qn(p.longDescription)}, ${p.priceCents}, ${p.categoryId}, ${p.inventory}, ${q(imgs[0].url)}, ${q(JSON.stringify(imgs))}, ${p.featured ? 1 : 0}, ${q(p.status)})`; }).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO variant (id, product_id, title, options, images, price_cents, price_cents_enabled, inventory) VALUES\n  " +
    SEED_VARIANTS.map((v) => `(${v.id}, ${v.productId}, ${q(v.title)}, ${q(JSON.stringify(v.options))}, ${v.images ? q(JSON.stringify(v.images)) : "NULL"}, ${v.priceCents}, ${v.priceCentsEnabled ? 1 : 0}, ${v.inventory})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO discount_code (id, code, description, discount_type, discount_value, min_subtotal_cents, max_discount_cents, max_uses, max_uses_per_customer, is_active, current_uses, expires_at) VALUES\n  " +
    SEED_DISCOUNTS.map((d) => `(${d.id}, ${q(d.code)}, ${qn(d.description)}, ${q(d.discountType)}, ${d.discountValue}, ${nq(d.minSubtotalCents)}, ${nq(d.maxDiscountCents)}, ${nq(d.maxUses)}, ${nq(d.maxUsesPerCustomer)}, 1, 0, NULL)`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO review (id, product_id, customer_id, rating, title, body, status, helpful_count, created_at) VALUES\n  " +
    SEED_REVIEWS.map((r) => `(${r.id}, ${r.productId}, ${q(r.customerId)}, ${r.rating}, ${q(r.title)}, ${q(r.body)}, 'published', ${r.helpfulCount}, ${T})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO post (id, title, slug, excerpt, body, status, published_at, author_id, cover_image_url) VALUES\n  " +
    SEED_POSTS.map((p) => `(${p.id}, ${q(p.title)}, ${q(p.slug)}, ${q(p.excerpt)}, ${q(p.body)}, 'published', ${T}, ${q(p.author)}, ${q(`/img/blog/${p.slug}.jpg`)})`).join(",\n  ") + ";",
  "INSERT OR REPLACE INTO faq (id, question, answer, sort_order, is_active) VALUES\n  " +
    SEED_FAQS.map((f, i) => `(${f.id}, ${q(f.question)}, ${q(f.answer)}, ${i}, 1)`).join(",\n  ") + ";",
].join("\n\n");
