/**
 * Custom operations — the domain verbs BEYOND CRUD (checkout, discount validation, search, analytics,
 * recommendations, …). The static v4 definitions + costs (OPERATION_PATHS / OPERATION_COSTS) are merged into the
 * contract so they appear in Scalar / /superadmin and are metered like every CRUD op; the handlers are a factory
 * over a Drizzle instance, so the dev server (bun:sqlite) and the Worker (D1) mount the exact same logic. Every
 * call is awaited, so it works whether the driver is synchronous (bun) or asynchronous (D1). saastarter
 * hand-writes each of these as a Next.js route + an Effect program; here they project from the same single source.
 */
import { and, eq, gte, inArray, like, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { CostModel } from "@suluk/cost";
import { product, post, order, cart, review, discountCode, newsletterSubscriber, apiToken, billingAccount, costEvent } from "./schema";
import { sendEmailAsync, brandedEmail } from "./email";
import { customerParams, subscriptionParams, meterEventParams } from "@suluk/stripe";
import { restStripe } from "./stripe-rest";
import { METER_EVENT_DEFAULT } from "./env";
import { hardenSchema } from "./harden-schema";
import { v } from "./validations";

/** SHA-256 of an API key (Web Crypto — Worker-safe). We store only the hash; the plaintext is shown once. */
export async function hashKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The acting principal for a request, in trust order: a verified API-token user, then a verified Better Auth
 *  SESSION user (both set by the auth middleware), then the `x-user` header (a dev/anonymous-demo fallback only —
 *  never authoritative for a signed-in user). Owner-scoping + cost attribution + billing all read this one place. */
export const principal = (c: Context): string | null =>
  (c.get("tokenUser") as string | undefined) ?? (c.get("sessionUser") as string | undefined) ?? c.req.header("x-user") ?? null;

/** Read a secret/var from the Worker env (c.env) or the dev process.env — so one handler works in both runtimes. */
const secret = (c: Context, name: string): string | undefined =>
  ((c.env as Record<string, string> | undefined)?.[name]) ?? (typeof process !== "undefined" ? process.env?.[name] : undefined);

/**
 * Report a principal's NEW accrued cost to the Stripe Billing Meter — DELTA-based + idempotent: it meters only
 * (total cost so far − already-reported), then stores the new total. So re-running (the button, or the cron)
 * never double-counts. Shared by the manual /billing/report op and the scheduled sweep.
 */
export async function reportPrincipalUsage(
  dz: Dz,
  opts: { key: string; eventName: string; principal: string },
): Promise<{ reported: boolean; deltaMicroUsd?: number; totalMicroUsd?: number; customerId?: string; reason?: string }> {
  const acct = await dz.select().from(billingAccount).where(eq(billingAccount.principal, opts.principal)).get();
  if (!acct?.stripeCustomerId) return { reported: false, reason: "not connected" };
  const seen = Number(acct.lastReportedMicroUsd ?? 0);
  const rows = await dz.select().from(costEvent).where(eq(costEvent.principal, opts.principal)).all();
  const total = (rows as { totalMicroUsd: number }[]).reduce((s, r) => s + Number(r.totalMicroUsd), 0);
  const delta = total - seen;
  if (delta <= 0) return { reported: false, reason: "no new usage", totalMicroUsd: total, customerId: acct.stripeCustomerId };
  // Idempotent under retries/races: a DETERMINISTIC identifier per (principal, new total) so Stripe dedups a
  // duplicate submission of the same delta window, AND a compare-and-swap that advances the high-water-mark only
  // if it is still `seen` — so the cron + the button (or two reports) can't double-bill the same usage.
  const identifier = `${opts.principal}:${total}`;
  await restStripe(opts.key).billing.meterEvents.create({ ...meterEventParams({ eventName: opts.eventName, customerId: acct.stripeCustomerId, value: delta }), identifier });
  const res = (await dz.update(billingAccount).set({ lastReportedMicroUsd: total, lastReportedAt: Date.now() }).where(and(eq(billingAccount.id, acct.id), eq(billingAccount.lastReportedMicroUsd, seen))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
  const claimed = Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0;
  return { reported: claimed, deltaMicroUsd: delta, totalMicroUsd: total, customerId: acct.stripeCustomerId };
}

/** Sweep every connected billing account and report its delta — the scheduled (Cron) twin of the button. */
export async function sweepBillingUsage(dz: Dz, key: string, eventName: string): Promise<{ swept: number; reported: number }> {
  const accts = (await dz.select().from(billingAccount).all()) as { principal: string; stripeCustomerId?: string }[];
  let reported = 0;
  for (const a of accts) {
    if (!a.stripeCustomerId) continue;
    try { if ((await reportPrincipalUsage(dz, { key, eventName, principal: a.principal })).reported) reported++; } catch { /* skip one bad account */ }
  }
  return { swept: accts.length, reported };
}

/**
 * Mark an order paid EXACTLY ONCE: a pending→paid transition (so a webhook re-delivery or a second confirm is a
 * no-op), and only on that transition do we bump the discount's usage. Returns true iff this call did the work.
 */
export async function markOrderPaid(dz: Dz, orderId: number): Promise<boolean> {
  const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
  if (!o || o.status === "paid") return false;
  const res = (await dz.update(order).set({ status: "paid" }).where(and(eq(order.id, orderId), eq(order.status, "pending"))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
  const changed = Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0;
  if (changed && o.discountCode) {
    await dz.update(discountCode).set({ currentUses: sql`${discountCode.currentUses} + 1` }).where(eq(discountCode.code, String(o.discountCode).toUpperCase().trim())).run();
  }
  return changed;
}

/** Resolve an `Authorization: Bearer sk_…` header to the owning userId via the api_token table (or null). */
export async function verifyApiToken(dz: { select: (...a: unknown[]) => any }, authHeader: string | undefined): Promise<string | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = /^Bearer\s+(sk_[A-Za-z0-9_]+)$/.exec(authHeader ?? "");
  if (!m) return null;
  const hashed = await hashKey(m[1]);
  const row = await dz.select().from(apiToken).where(eq(apiToken.hashedKey, hashed)).get();
  if (!row || row.revokedAt) return null;
  return row.userId ?? null;
}

// a permissive Drizzle handle — both bun:sqlite and D1 expose the same query-builder surface.
type Dz = {
  select: (...a: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  insert: (...a: unknown[]) => any;
  update: (...a: unknown[]) => any;
};
export type DbFor = (c: Context) => Dz;

const read = (m: number): CostModel => ({ components: [{ source: "db-read", basis: "per-call", microUsd: m }], estimateMicroUsd: m });
const write = (m: number): CostModel => ({ components: [{ source: "compute", basis: "per-call", microUsd: 100 }, { source: "db-write", basis: "per-call", microUsd: m }], estimateMicroUsd: 100 + m });

interface LineItem { productId?: number; variantId?: number; qty?: number; priceCents?: number }
interface ResolvedDiscount { valid: boolean; discountType?: "percent" | "fixed"; discountValue?: number; reason?: string }

const idParam = { path: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
function jsonOp(
  method: string,
  summary: string,
  opts: { body?: unknown; params?: unknown; status?: number; contentType?: string; response?: unknown } = {},
): Record<string, unknown> {
  return {
    method, summary, tags: ["Operations"],
    ...(opts.body ? { contentType: "application/json", contentSchema: opts.body } : {}),
    ...(opts.params ? { parameterSchema: opts.params } : {}),
    responses: { ok: { status: opts.status ?? 200, description: summary, contentType: opts.contentType ?? "application/json", contentSchema: opts.response ?? { type: "object" } } },
  };
}

/** The per-operation cost models — merged into the contract's cost map so these are metered like CRUD. */
export const OPERATION_COSTS: Record<string, CostModel> = {
  checkout: write(80), validateDiscount: read(10), search: read(14), markReviewHelpful: write(20),
  analyticsSummary: read(20), analyticsRevenue: read(20), analyticsTopProducts: read(24),
  recommendRelated: read(16), subscribeNewsletter: write(20), generateAvatar: read(2),
  createToken: write(30), revokeToken: write(20),
  payCheckout: write(90), confirmCheckout: read(30),
  connectBilling: write(60), reportUsage: write(40),
};

// typed input bodies for the custom ops with REAL bounds (validations.ts) — a bare {type:"object"} is a free-form bag.
const obj = (properties: Record<string, unknown>, required?: string[]) => ({ type: "object", additionalProperties: false, properties, ...(required ? { required } : {}) });
const ID = 1_000_000_000_000;
const cartLine = obj({ productId: v.int(1, ID), qty: v.int(1, 1000), priceCents: v.cents() });
const payLine = obj({ productId: v.int(1, ID), qty: v.int(1, 1000) });

/** The v4 path fragment for the custom operations — merged into the contract document (then hardened below). */
export const OPERATION_PATHS: Record<string, unknown> = {
  "checkout/order": { requests: { checkout: jsonOp("post", "Create an order from a cart (apply discount, total)", { body: obj({ cartId: v.int(1, ID), items: { type: "array", maxItems: 200, items: cartLine }, discountCode: v.code(40) }), status: 201 }) } },
  "discount/validate": { requests: { validateDiscount: jsonOp("post", "Validate a discount code", { body: obj({ code: v.code(40), subtotalCents: v.cents(100_000_000_000) }, ["code"]) }) } },
  "search": { requests: { search: jsonOp("get", "Search products + blog posts", { params: { query: obj({ q: v.line(200) }) } }) } },
  "review/{id}/helpful": { requests: { markReviewHelpful: jsonOp("post", "Mark a review helpful (+1)", { params: idParam }) } },
  "analytics/summary": { requests: { analyticsSummary: jsonOp("get", "Store summary (orders, revenue, customers)") } },
  "analytics/revenue": { requests: { analyticsRevenue: jsonOp("get", "Revenue per day (last 30d)") } },
  "analytics/top-products": { requests: { analyticsTopProducts: jsonOp("get", "Best-selling products") } },
  "recommendations/{productId}": { requests: { recommendRelated: jsonOp("get", "Related products", { params: { path: { type: "object", properties: { productId: { type: "string", maxLength: 16, pattern: "^[0-9]+$" } }, required: ["productId"] } } }) } },
  "newsletter/subscribe": { requests: { subscribeNewsletter: jsonOp("post", "Subscribe to the newsletter (idempotent)", { body: obj({ email: v.email() }, ["email"]), status: 201 }) } },
  "avatar": { requests: { generateAvatar: jsonOp("get", "Deterministic identicon SVG", { params: { query: obj({ seed: v.line(100, "^[\\w .@-]{0,100}$") }) }, contentType: "image/svg+xml", response: { type: "string" } }) } },
  "tokens/create": { requests: { createToken: jsonOp("post", "Create an API token (returns the secret ONCE)", { body: obj({ name: v.line(80) }, ["name"]), status: 201 }) } },
  "tokens/{id}/revoke": { requests: { revokeToken: jsonOp("post", "Revoke an API token", { params: idParam }) } },
  "checkout/pay": { requests: { payCheckout: jsonOp("post", "Create a pending order + a Stripe Checkout Session (returns the hosted URL)", { body: obj({ items: { type: "array", maxItems: 200, items: payLine }, discountCode: v.code(40) }) }) } },
  "checkout/confirm": { requests: { confirmCheckout: jsonOp("post", "Confirm payment by retrieving the Stripe session; mark the order paid", { body: obj({ orderId: v.int(1, ID), sessionId: v.line(255, "^[A-Za-z0-9_]+$") }, ["orderId", "sessionId"]) }) } },
  "billing/connect": { requests: { connectBilling: jsonOp("post", "Start usage-based billing: a Stripe customer + a metered subscription", { body: obj({ email: v.email() }) }) } },
  "billing/report": { requests: { reportUsage: jsonOp("post", "Report your accrued @suluk/cost usage to the Stripe Billing Meter", { body: { type: "object", additionalProperties: false } }) } },
};

// HARDEN the custom-op inputs (the answer to @suluk/harden's findings): bound strings/numbers/arrays + close objects.
for (const pi of Object.values(OPERATION_PATHS) as { requests?: Record<string, Record<string, unknown>> }[]) {
  for (const req of Object.values(pi.requests ?? {})) {
    if (req.contentSchema) req.contentSchema = hardenSchema(req.contentSchema);
    const psk = req.parameterSchema as Record<string, unknown> | undefined;
    if (psk) for (const loc of ["query", "path", "header", "cookie", "body"]) if (psk[loc]) psk[loc] = hardenSchema(psk[loc]);
  }
}

/** Validate a discount code against the table: must exist, be active, not expired, and under its usage cap. */
async function resolveDiscount(dz: Dz, raw: string): Promise<ResolvedDiscount> {
  const code = String(raw ?? "").toUpperCase().trim();
  if (!code) return { valid: false, reason: "empty code" };
  const d = await dz.select().from(discountCode).where(eq(discountCode.code, code)).get();
  if (!d) return { valid: false, reason: "unknown code" };
  if (!d.isActive) return { valid: false, reason: "inactive" };
  if (d.expiresAt && Number(d.expiresAt) < Date.now()) return { valid: false, reason: "expired" };
  if (d.maxUses != null && Number(d.currentUses) >= Number(d.maxUses)) return { valid: false, reason: "usage limit reached" };
  return { valid: true, discountType: d.discountType, discountValue: Number(d.discountValue) };
}

/** Apply a resolved discount to a cents total (percent → proportional; fixed → flat cents off). Never negative. */
function applyDiscount(totalCents: number, d: ResolvedDiscount): number {
  if (!d.valid) return totalCents;
  if (d.discountType === "percent") return Math.max(0, Math.round(totalCents * (100 - (d.discountValue ?? 0)) / 100));
  return Math.max(0, totalCents - (d.discountValue ?? 0));
}

const itemsTotal = (items: LineItem[]) => items.reduce((s, it) => s + (Number(it.priceCents) || 0) * (Number(it.qty) || 1), 0);

/** Bind the custom-operation handlers to a Drizzle instance and mount them on a Hono app. */
export function mountOperations(app: { get: (...a: unknown[]) => unknown; post: (...a: unknown[]) => unknown }, dbFor: DbFor): void {
  const checkout = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { cartId?: number; items?: LineItem[]; discountCode?: string };
    let items: LineItem[] = Array.isArray(body.items) ? body.items : [];
    let codeUsed: string | null = body.discountCode ?? null;
    if (body.cartId) {
      const ct = await dz.select().from(cart).where(eq(cart.id, Number(body.cartId))).get();
      if (ct) { try { items = JSON.parse(ct.items || "[]"); } catch { items = []; } codeUsed = codeUsed ?? ct.discountCode ?? null; }
    }
    const subtotal = itemsTotal(items);
    const disc = codeUsed ? await resolveDiscount(dz, codeUsed) : { valid: false } as ResolvedDiscount;
    const total = applyDiscount(subtotal, disc);
    if (codeUsed && !disc.valid) codeUsed = null;
    const customerId = principal(c);
    const created = await dz.insert(order).values({ customerId, items: JSON.stringify(items), totalCents: total, status: "pending", discountCode: codeUsed, createdAt: Date.now() }).returning();
    if (codeUsed && disc.valid) await dz.update(discountCode).set({ currentUses: sql`${discountCode.currentUses} + 1` }).where(eq(discountCode.code, codeUsed.toUpperCase().trim())).run();
    return c.json({ order: created[0], subtotalCents: subtotal, totalCents: total, discountApplied: disc.valid }, 201);
  };

  const validateDiscount = async (c: Context) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string; subtotalCents?: number };
    const d = await resolveDiscount(dbFor(c), body.code ?? "");
    const preview = d.valid && typeof body.subtotalCents === "number" ? applyDiscount(body.subtotalCents, d) : undefined;
    return c.json({ ...d, ...(preview !== undefined ? { newTotalCents: preview } : {}) }, d.valid ? 200 : 422);
  };

  const search = async (c: Context) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ products: [], posts: [] });
    const dz = dbFor(c);
    const term = `%${q}%`;
    const products = await dz.select().from(product).where(and(eq(product.status, "published"), like(product.name, term))).limit(10).all();
    const posts = await dz.select().from(post).where(and(eq(post.status, "published"), like(post.title, term))).limit(10).all();
    return c.json({ products, posts });
  };

  const markReviewHelpful = async (c: Context) => {
    const dz = dbFor(c);
    // require an authenticated principal — so the +1 is attributable + cost-metered, not anonymous vote-stuffing.
    // (Full one-vote-per-(review,principal) dedup would need a votes table; this closes the trivial anon replay.)
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in to mark a review helpful." }, 401);
    const id = Number(c.req.param("id"));
    await dz.update(review).set({ helpfulCount: sql`${review.helpfulCount} + 1` }).where(eq(review.id, id)).run();
    const r = await dz.select().from(review).where(eq(review.id, id)).get();
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  };

  const analyticsSummary = async (c: Context) => {
    const dz = dbFor(c);
    const orders = await dz.select().from(order).all();
    const paid = orders.filter((o: { status: string }) => o.status === "paid" || o.status === "shipped");
    const revenueCents = paid.reduce((s: number, o: { totalCents: number }) => s + Number(o.totalCents), 0);
    const customers = new Set(orders.map((o: { customerId?: string }) => o.customerId).filter(Boolean));
    const products = await dz.select({ n: sql<number>`count(*)` }).from(product).get();
    return c.json({ orders: orders.length, paidOrders: paid.length, revenueCents, customers: customers.size, products: Number(products?.n ?? 0) });
  };

  const analyticsRevenue = async (c: Context) => {
    const dz = dbFor(c);
    const since = Date.now() - 30 * 86_400_000;
    const orders = await dz.select().from(order).where(gte(order.createdAt, since)).all();
    const byDay = new Map<string, number>();
    for (const o of orders as { status: string; totalCents: number; createdAt?: number }[]) {
      if (o.status !== "paid" && o.status !== "shipped") continue;
      const day = new Date(Number(o.createdAt ?? 0)).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + Number(o.totalCents));
    }
    return c.json({ series: [...byDay.entries()].sort().map(([date, revenueCents]) => ({ date, revenueCents })) });
  };

  const analyticsTopProducts = async (c: Context) => {
    const dz = dbFor(c);
    const orders = await dz.select().from(order).all();
    const qtyById = new Map<number, number>();
    for (const o of orders as { items: string }[]) {
      let items: LineItem[] = [];
      try { items = JSON.parse(o.items || "[]"); } catch { /* skip */ }
      for (const it of items) if (it.productId != null) qtyById.set(it.productId, (qtyById.get(it.productId) ?? 0) + (Number(it.qty) || 1));
    }
    const top = [...qtyById.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const rows = await Promise.all(top.map(async ([productId, qty]) => {
      const p = await dz.select().from(product).where(eq(product.id, productId)).get();
      return { productId, qty, name: p?.name ?? `#${productId}`, priceCents: p?.priceCents ?? 0 };
    }));
    return c.json({ topProducts: rows });
  };

  const recommendRelated = async (c: Context) => {
    const dz = dbFor(c);
    const productId = Number(c.req.param("productId"));
    const p = await dz.select().from(product).where(eq(product.id, productId)).get();
    if (!p) return c.json({ related: [] });
    const related = await dz.select().from(product)
      .where(and(eq(product.status, "published"), p.categoryId != null ? eq(product.categoryId, p.categoryId) : lt(product.id, productId)))
      .limit(8).all();
    return c.json({ related: (related as { id: number }[]).filter((r) => r.id !== productId).slice(0, 8) });
  };

  const subscribeNewsletter = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return c.json({ error: "a valid email is required" }, 422);
    const existing = await dz.select().from(newsletterSubscriber).where(eq(newsletterSubscriber.email, email)).get();
    if (existing) return c.json({ subscribed: true, already: true });
    await dz.insert(newsletterSubscriber).values({ email, subscribedAt: Date.now() }).run();
    sendEmailAsync({ to: email, subject: "Welcome to saasuluk", html: brandedEmail("You're subscribed 🎉", "<p>Thanks for joining the saasuluk newsletter. You'll hear from us when there's something worth your time.</p>") }, { apiKey: secret(c, "RESEND_API_KEY"), from: secret(c, "EMAIL_FROM") });
    return c.json({ subscribed: true, already: false }, 201);
  };

  const createToken = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const name = String(body.name ?? "").trim() || "token";
    // sk_<random> — shown ONCE; we persist only its SHA-256 hash + a short prefix for display.
    const secret = "sk_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const hashedKey = await hashKey(secret);
    const userId = principal(c);
    const created = await dz.insert(apiToken).values({ userId, name, prefix: secret.slice(0, 10), hashedKey, createdAt: Date.now() }).returning();
    return c.json({ id: created[0].id, name, token: secret, prefix: created[0].prefix, note: "Copy this now — it will not be shown again." }, 201);
  };

  const revokeToken = async (c: Context) => {
    const dz = dbFor(c);
    const id = Number(c.req.param("id"));
    const who = principal(c);
    // SCOPED: you can only revoke YOUR OWN token (eq id AND userId) — without this any caller could revoke any
    // user's token by id. A foreign/anonymous caller matches nothing → 404 (honest: it wasn't yours to revoke).
    const res = (await dz.update(apiToken).set({ revokedAt: Date.now() }).where(and(eq(apiToken.id, id), eq(apiToken.userId, who))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
    const changed = Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0;
    return changed ? c.json({ revoked: true, id }) : c.json({ error: "not found" }, 404);
  };

  // real Stripe Checkout — via the REST API over fetch (no SDK → Worker-safe). Creates a pending order + a
  // hosted Checkout Session; the success page calls confirmCheckout, which retrieves the session from Stripe
  // (the source of truth) and marks the order paid — so it works WITHOUT a configured webhook endpoint.
  const payCheckout = async (c: Context) => {
    const key = secret(c, "STRIPE_SECRET_KEY");
    if (!key) return c.json({ error: "Stripe is not configured (set STRIPE_SECRET_KEY)." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { items?: { productId?: number; qty?: number }[]; discountCode?: string };
    const cart = (Array.isArray(body.items) ? body.items : []).filter((i) => i.productId != null);
    if (!cart.length) return c.json({ error: "Your cart is empty." }, 422);
    const dz = dbFor(c);
    // SERVER-AUTHORITATIVE pricing: the client supplies only productId + qty; every price comes from the product
    // row. (A client cannot under-pay by sending a fake priceCents.) Unknown/unpublished products are dropped.
    const ids = [...new Set(cart.map((i) => Number(i.productId)))];
    const rows = await dz.select().from(product).where(inArray(product.id, ids)).all();
    const byId = new Map((rows as { id: number; name: string; priceCents: number; status: string; stripePriceId?: string }[]).map((p) => [p.id, p]));
    const lines = cart.map((i) => { const p = byId.get(Number(i.productId)); const qty = Math.max(1, Math.floor(Number(i.qty) || 1)); return p && p.status === "published" ? { productId: p.id, qty, priceCents: p.priceCents, name: p.name, stripePriceId: p.stripePriceId } : null; }).filter((x): x is NonNullable<typeof x> => x != null);
    if (!lines.length) return c.json({ error: "No purchasable items in the cart." }, 422);
    const subtotal = lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
    const disc = body.discountCode ? await resolveDiscount(dz, body.discountCode) : { valid: false } as ResolvedDiscount;
    const total = applyDiscount(subtotal, disc);
    if (total < 50) return c.json({ error: "Stripe's minimum charge is $0.50 — use “Place order” for free items." }, 422);
    const codeUsed = disc.valid ? body.discountCode!.toUpperCase().trim() : null;
    // the order records the SERVER prices + the SERVER total (authoritative — matches what Stripe charges).
    const created = await dz.insert(order).values({ customerId: principal(c), items: JSON.stringify(lines.map((l) => ({ productId: l.productId, qty: l.qty, priceCents: l.priceCents }))), totalCents: total, status: "pending", discountCode: codeUsed, createdAt: Date.now() }).returning();
    const orderId = created[0].id;
    const origin = new URL(c.req.url).origin;
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", `${origin}/checkout/success?order=${orderId}&session_id={CHECKOUT_SESSION_ID}`);
    form.set("cancel_url", `${origin}/checkout`);
    form.set("client_reference_id", String(orderId));
    form.set("metadata[orderId]", String(orderId));
    // no discount + every line has a catalog Price → charge the real Prices (Stripe shows the products). Otherwise
    // a single line item at the SERVER-recomputed (discounted) total — never a client-supplied amount.
    const useCatalog = !disc.valid && lines.every((l) => l.stripePriceId);
    if (useCatalog) {
      lines.forEach((l, idx) => { form.set(`line_items[${idx}][price]`, l.stripePriceId as string); form.set(`line_items[${idx}][quantity]`, String(l.qty)); });
    } else {
      form.set("line_items[0][quantity]", "1");
      form.set("line_items[0][price_data][currency]", "usd");
      form.set("line_items[0][price_data][unit_amount]", String(total));
      form.set("line_items[0][price_data][product_data][name]", `saasuluk order #${orderId}${codeUsed ? ` · ${codeUsed} applied` : ""}`);
    }
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const session = (await r.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
    if (!r.ok || !session.url) return c.json({ error: session.error?.message ?? "Stripe error", orderId }, 502);
    await dz.update(order).set({ stripePaymentIntentId: session.id }).where(eq(order.id, orderId)).run();
    return c.json({ url: session.url, orderId, totalCents: total });
  };

  const confirmCheckout = async (c: Context) => {
    const key = secret(c, "STRIPE_SECRET_KEY");
    const body = (await c.req.json().catch(() => ({}))) as { orderId?: number; sessionId?: string };
    const orderId = Number(body.orderId);
    if (!key || !body.sessionId || !orderId) return c.json({ paid: false, reason: "missing key, session or order" }, 400);
    const dz = dbFor(c);
    const ord = await dz.select().from(order).where(eq(order.id, orderId)).get();
    if (!ord) return c.json({ paid: false, reason: "unknown order" }, 404);
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`, { headers: { authorization: `Bearer ${key}` } });
    const session = (await r.json().catch(() => ({}))) as { payment_status?: string; client_reference_id?: string; amount_total?: number };
    // Stripe is the source of truth: payment cleared, the session is THIS order's, AND the amount matches our total.
    const paid = r.ok && session.payment_status === "paid" && String(session.client_reference_id) === String(orderId) && Number(session.amount_total) === Number(ord.totalCents);
    if (paid) await markOrderPaid(dz, orderId); // pending-only transition + once-per-order discount bump (idempotent)
    const row = await dz.select().from(order).where(eq(order.id, orderId)).get();
    return c.json({ paid, order: row });
  };

  // ── @suluk/cost → Stripe Billing Meters: connect a customer + metered subscription, then report usage. ──
  const connectBilling = async (c: Context) => {
    const key = secret(c, "STRIPE_SECRET_KEY");
    const priceId = secret(c, "STRIPE_METERED_PRICE_ID");
    if (!key || !priceId) return c.json({ error: "Usage billing isn't configured (run scripts/setup-billing.ts)." }, 503);
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in first." }, 401);
    const dz = dbFor(c);
    const existing = await dz.select().from(billingAccount).where(eq(billingAccount.principal, who)).get();
    if (existing?.stripeCustomerId) return c.json({ connected: true, already: true, customerId: existing.stripeCustomerId, subscriptionId: existing.subscriptionId });
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    const stripe = restStripe(key);
    const customer = await stripe.customers.create(customerParams({ email: body.email, metadata: { principal: who } }));
    let subscriptionId: string | null = null;
    // metered subs bill at period end; default_incomplete avoids an upfront charge so it works without a card (test mode)
    try { const sub = await stripe.subscriptions.create({ ...subscriptionParams({ customerId: customer.id, priceId }), payment_behavior: "default_incomplete" }); subscriptionId = (sub as { id: string }).id; } catch { /* customer still meters */ }
    if (existing) await dz.update(billingAccount).set({ stripeCustomerId: customer.id, subscriptionId }).where(eq(billingAccount.id, existing.id)).run();
    else await dz.insert(billingAccount).values({ principal: who, stripeCustomerId: customer.id, subscriptionId, lastReportedMicroUsd: 0, createdAt: Date.now() }).run();
    return c.json({ connected: true, customerId: customer.id, subscriptionId });
  };

  const reportUsage = async (c: Context) => {
    const key = secret(c, "STRIPE_SECRET_KEY");
    const eventName = secret(c, "STRIPE_METER_EVENT_NAME") ?? METER_EVENT_DEFAULT;
    if (!key) return c.json({ error: "Stripe is not configured." }, 503);
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in first." }, 401);
    const r = await reportPrincipalUsage(dbFor(c), { key, eventName, principal: who });
    if (r.reason === "not connected") return c.json({ error: "Connect usage billing first.", connected: false }, 409);
    return c.json({ ...r, valueMicroUsd: r.deltaMicroUsd, eventName }); // delta = only the NEW usage since last report
  };

  // a deterministic identicon SVG from a seed — saastarter pulls @dicebear; here it is derived, dependency-free.
  const generateAvatar = (c: Context) => {
    const seed = c.req.query("seed") ?? "anon";
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const hue = h % 360;
    const fg = `hsl(${hue} 65% 55%)`, bg = `hsl(${hue} 30% 95%)`;
    let cells = "";
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
      if (!((h >> (y * 3 + x)) & 1)) continue;
      for (const cx of new Set([x, 4 - x])) cells += `<rect x="${cx * 20}" y="${y * 20}" width="20" height="20"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" fill="${bg}"/><g fill="${fg}">${cells}</g></svg>`;
    return c.body(svg, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
  };

  app.post("/checkout/order", checkout); // NOT /checkout — that path is the checkout PAGE (a static asset), which would shadow a POST on Cloudflare
  app.post("/discount/validate", validateDiscount);
  app.get("/search", search);
  app.post("/review/:id/helpful", markReviewHelpful);
  app.get("/analytics/summary", analyticsSummary);
  app.get("/analytics/revenue", analyticsRevenue);
  app.get("/analytics/top-products", analyticsTopProducts);
  app.get("/recommendations/:productId", recommendRelated);
  app.post("/newsletter/subscribe", subscribeNewsletter);
  app.get("/avatar", generateAvatar);
  app.post("/tokens/create", createToken);
  app.post("/tokens/:id/revoke", revokeToken);
  app.post("/checkout/pay", payCheckout);
  app.post("/checkout/confirm", confirmCheckout);
  app.post("/billing/connect", connectBilling);
  app.post("/billing/report", reportUsage);
}
