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
  priceCents: integer("price_cents").notNull().default(0),
  categoryId: integer("category_id"),
  inventory: integer("inventory").notNull().default(0),
  imageUrl: text("image_url"),
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
});

export const variant = sqliteTable("variant", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  title: text("title").notNull(),
  priceCents: integer("price_cents").notNull().default(0),
  inventory: integer("inventory").notNull().default(0),
});

export const discountCode = sqliteTable("discount_code", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  discountType: text("discount_type", { enum: ["percent", "fixed"] }).notNull().default("percent"),
  discountValue: integer("discount_value").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  currentUses: integer("current_uses").notNull().default(0),
  maxUses: integer("max_uses"),
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
  items: text("items").notNull().default("[]"),
  totalCents: integer("total_cents").notNull().default(0),
  status: text("status", { enum: ["pending", "paid", "shipped", "cancelled"] }).notNull().default("pending"),
  discountCode: text("discount_code"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  createdAt: integer("created_at"),
});

export const review = sqliteTable("review", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  customerId: text("customer_id"),
  rating: integer("rating").notNull().default(5),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status", { enum: ["pending", "published"] }).notNull().default("pending"),
  helpfulCount: integer("helpful_count").notNull().default(0),
  createdAt: integer("created_at"),
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
export const SCHEMA_SQL = `
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
CREATE TABLE IF NOT EXISTS api_token (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT NOT NULL, prefix TEXT NOT NULL, hashed_key TEXT NOT NULL, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id TEXT, status TEXT NOT NULL DEFAULT 'active');
`.trim();
