/**
 * The data floor — every domain table in ONE place (Drizzle on sqlite-core, which IS Cloudflare D1). This file
 * is RUNTIME-AGNOSTIC (no bun:sqlite, no d1 instance) so both the dev server (`db.ts`, bun:sqlite) and the
 * Worker (`worker.ts`, drizzle-orm/d1) import the same definitions — the single source the whole stack projects
 * from. saastarter spreads this domain across ~14 PayloadCMS collections + an ecommerce plugin; here it is one
 * typed schema, and the API, v4 contract, Scalar docs, /superadmin, the typed client, the generated UI, and the
 * cost ledger are all derived from it. They can't drift — they're the same source.
 *
 * Better Auth owns its own users/sessions tables in the same database; the relationship columns below
 * (`customerId`, `ownerId`, `authorId`, `userId`) reference Better Auth's user id by convention.
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { schemaDDL } from "@suluk/drizzle";

// ── ecommerce ──────────────────────────────────────────────────────────────────────────────────────────────
export const category = sqliteTable("category", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
});

export const product = sqliteTable("product", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  longDescription: text("long_description"), // rich body shown in the product-detail "Details" section
  priceCents: integer("price_cents").notNull().default(0),
  compareAtCents: integer("compare_at_cents"), // was/MSRP — when > priceCents the storefront shows a sale strikethrough
  downloadUrl: text("download_url"), // digital delivery: the access/download link a buyer gets once PAID (null for physical)
  categoryId: integer("category_id"),
  inventory: integer("inventory").notNull().default(0),
  imageUrl: text("image_url"), // the PRIMARY image (kept as images[0] mirror for thin consumers)
  images: text("images"), // JSON gallery: [{ url, alt?, sortOrder? }] — the multi-image capability
  featured: integer("featured", { mode: "boolean" }).notNull().default(false),
  requiresShipping: integer("requires_shipping", { mode: "boolean" }).notNull().default(false), // PHYSICAL good → shipping applies
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
  stripePriceId: text("stripe_price_id"), // set by scripts/sync-catalog.ts — the real Stripe Price for checkout
  lowStockAlerted: integer("low_stock_alerted", { mode: "boolean" }).notNull().default(false), // once-only latch: owner already emailed about this low level (re-armed on restock)
});

export const variant = sqliteTable("variant", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  title: text("title").notNull(),
  options: text("options"), // JSON [{ label, value }] — the variant's option dimensions (e.g. Size:L, Color:Black)
  images: text("images"), // JSON gallery override for this variant (swaps the product gallery when selected)
  priceCents: integer("price_cents").notNull().default(0),
  priceCentsEnabled: integer("price_cents_enabled", { mode: "boolean" }).notNull().default(false), // false → inherit product price
  inventory: integer("inventory").notNull().default(0),
  lowStockAlerted: integer("low_stock_alerted", { mode: "boolean" }).notNull().default(false), // once-only low-stock latch (see product)
});

export const discountCode = sqliteTable("discount_code", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  description: text("description"),
  discountType: text("discount_type", { enum: ["percent", "fixed"] }).notNull().default("percent"),
  discountValue: integer("discount_value").notNull().default(0),
  minSubtotalCents: integer("min_subtotal_cents"), // code only valid when cart subtotal ≥ this
  maxDiscountCents: integer("max_discount_cents"), // cap on a percentage discount (saastarter's maxDiscountAmount)
  maxUses: integer("max_uses"),
  maxUsesPerCustomer: integer("max_uses_per_customer"),
  appliesToProductIds: text("applies_to_product_ids"), // JSON number[] — scope the code to specific products
  startsAt: integer("starts_at"), // validFrom
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  currentUses: integer("current_uses").notNull().default(0),
  expiresAt: integer("expires_at"),
});

export const cart = sqliteTable("cart", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: text("customer_id"),
  // a JSON array of { productId, variantId?, qty, priceCents } — the line items, kept atomic with the cart
  items: text("items").notNull().default("[]"),
  discountCode: text("discount_code"),
  status: text("status", { enum: ["active", "converted", "abandoned"] }).notNull().default("active"),
});

export const order = sqliteTable("order", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: text("customer_id"),
  customerEmail: text("customer_email"), // snapshot of the buyer's email at purchase (guest or member)
  // items snapshot each line as { productId, variantId?, qty, priceCents, name, image?, variantLabel? } so a later
  // rename/reprice/delete never mis-renders a historical order.
  items: text("items").notNull().default("[]"),
  shippingAddress: text("shipping_address"), // JSON snapshot of the address at purchase time
  totalCents: integer("total_cents").notNull().default(0),
  status: text("status", { enum: ["pending", "paid", "shipped", "cancelled"] }).notNull().default("pending"),
  discountCode: text("discount_code"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  carrier: text("carrier"), // set on the shipped transition (admin fulfillment)
  trackingNumber: text("tracking_number"),
  shippingCents: integer("shipping_cents").notNull().default(0),
  taxCents: integer("tax_cents").notNull().default(0),
  shippingMethod: text("shipping_method"),
  recoveryEmailedAt: integer("recovery_emailed_at"), // stamped when the abandoned-cart recovery email is sent (once)
  createdAt: integer("created_at"),
});

export const review = sqliteTable("review", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  customerId: text("customer_id"),
  rating: integer("rating").notNull().default(5),
  title: text("title").notNull(),
  body: text("body"),
  verifiedPurchase: integer("verified_purchase", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["pending", "published"] }).notNull().default("pending"),
  helpfulCount: integer("helpful_count").notNull().default(0),
  createdAt: integer("created_at"),
});

// one row per (review, principal) so a "helpful" vote is idempotent + can be un-voted (replaces the bare counter race).
export const reviewHelpfulVote = sqliteTable("review_helpful_vote", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: integer("review_id").notNull(),
  principal: text("principal").notNull(),
});

// a customer's saved shipping/billing addresses — the address book the checkout form reads + writes.
export const address = sqliteTable("address", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: text("customer_id"),
  name: text("name"),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city").notNull(),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").notNull().default("US"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
});

export const wishlistItem = sqliteTable("wishlist_item", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: text("customer_id"),
  productId: integer("product_id").notNull(),
  variantId: integer("variant_id"),
  addedAt: integer("added_at"),
});

// ── content / marketing ──────────────────────────────────────────────────────────────────────────────────
export const post = sqliteTable("post", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  excerpt: text("excerpt"),
  body: text("body"),
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
  publishedAt: integer("published_at"),
  authorId: text("author_id"),
  coverImageUrl: text("cover_image_url"),
});

export const faq = sqliteTable("faq", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const newsletterSubscriber = sqliteTable("newsletter_subscriber", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  subscribedAt: integer("subscribed_at"),
});

export const contactSubmission = sqliteTable("contact_submission", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at"),
});

// back-in-stock waitlist: a shopper asks to be emailed when a sold-out product is restocked. notifiedAt is stamped
// when the email goes out (so the same waitlist row is never re-notified). Keyed by email (like newsletterSubscriber).
export const stockNotification = sqliteTable("stock_notification", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  email: text("email").notNull(),
  createdAt: integer("created_at"),
  notifiedAt: integer("notified_at"),
});

export const media = sqliteTable("media", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  alt: text("alt").notNull(),
  width: integer("width"),
  height: integer("height"),
});

// ── platform ─────────────────────────────────────────────────────────────────────────────────────────────
export const apiToken = sqliteTable("api_token", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id"),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  hashedKey: text("hashed_key").notNull(),
  createdAt: integer("created_at"),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});

// usage-based billing: a principal's Stripe customer + metered subscription (the @suluk/cost → Stripe meter bridge).
export const billingAccount = sqliteTable("billing_account", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  principal: text("principal").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  subscriptionId: text("subscription_id"),
  lastReportedMicroUsd: integer("last_reported_micro_usd"),
  lastReportedAt: integer("last_reported_at"),
  createdAt: integer("created_at"),
});

// the durable cost ledger (the Worker meters into it) — defined here so billing can SUM a principal's usage.
export const costEvent = sqliteTable("cost_event", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  principal: text("principal"),
  operation: text("operation").notNull(),
  action: text("action"),
  totalMicroUsd: integer("total_micro_usd").notNull(),
  breakdown: text("breakdown").notNull(),
});

// the original SaaS resource — kept (the README references it)
export const project = sqliteTable("project", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  ownerId: text("owner_id"),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
});

/**
 * The DDL for the whole domain — run on the in-memory dev DB (`db.ts`) and shipped as the D1 migration
 * (`migrations/0000_domain.sql`). Kept beside the table defs so the two representations stay in lockstep.
 * (`cost_event` — the durable cost ledger — is appended by the migration; it is infra, not a domain entity.)
 */
// GENERATED from the Drizzle tables above via @suluk/drizzle schemaDDL — no hand-mirrored column list to drift out
// of sync (a column added to a table flows into the dev DDL automatically). Only the table-INCLUSION list + the
// standalone unique index are hand-maintained. Snapshot-verified structurally identical to the prior hand-written
// SCHEMA_SQL (same columns/types/notnull/defaults/pk for all 20 tables). Prod stays migration-driven (migrations/).
export const SCHEMA_SQL = (
  schemaDDL([
    category, product, variant, discountCode, cart, order, review, reviewHelpfulVote, address, wishlistItem,
    post, faq, newsletterSubscriber, contactSubmission, stockNotification, media, apiToken, project, billingAccount, costEvent,
  ]) + "\nCREATE UNIQUE INDEX IF NOT EXISTS review_helpful_vote_uniq ON review_helpful_vote (review_id, principal);"
).trim();
