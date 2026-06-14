/**
 * Custom operations — the domain verbs BEYOND CRUD (checkout, discount validation, search, analytics,
 * recommendations, …). The static v4 definitions + costs (OPERATION_PATHS / OPERATION_COSTS) are merged into the
 * contract so they appear in Scalar / /superadmin and are metered like every CRUD op; the handlers are a factory
 * over a Drizzle instance, so the dev server (bun:sqlite) and the Worker (D1) mount the exact same logic. Every
 * call is awaited, so it works whether the driver is synchronous (bun) or asynchronous (D1). saastarter
 * hand-writes each of these as a Next.js route + an Effect program; here they project from the same single source.
 */
import { and, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { CostModel } from "@suluk/cost";
import { product, variant, post, order, cart, review, discountCode, newsletterSubscriber, apiToken, billingAccount, costEvent } from "./schema";
import { sendEmailAsync, brandedEmail } from "./email";
import { orderConfirmationEmail } from "@suluk/email";
import { customerParams, subscriptionParams, meterEventParams, billingPortalSessionParams, computeDiscountAmount, requiresStripe, type Discount } from "@suluk/stripe";
import { restStripe } from "./stripe-rest";
import { METER_EVENT_DEFAULT } from "./env";
import { hardenSchema } from "./harden-schema";
import { v } from "./validations";

/** Demo personas (testimonials + seed reviewers) get a REAL stock headshot; everyone else gets a generated
 *  identicon. Keyed by the avatar seed (handle / customerId), lower-cased. Real signed-up users are never in this
 *  map — putting a stranger's stock face on a real account would misrepresent them. Photos live in public/img/people/. */
const PERSONA_PHOTOS: Record<string, string> = {
  maya: "/img/people/maya.jpg", daniel: "/img/people/daniel.jpg", sara: "/img/people/sara.jpg",
  ada: "/img/people/ada.jpg", lin: "/img/people/lin.jpg", rob: "/img/people/rob.jpg", mei: "/img/people/mei.jpg",
};

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
  if (changed) {
    if (o.discountCode) {
      await dz.update(discountCode).set({ currentUses: sql`${discountCode.currentUses} + 1` }).where(eq(discountCode.code, String(o.discountCode).toUpperCase().trim())).run();
    }
    // decrement stock for each paid line (product + variant), clamped at 0 — the SINGLE place inventory is reduced,
    // on the once-only paid transition, so a webhook re-delivery / double-confirm can't double-decrement.
    let items: { productId?: number; variantId?: number; qty?: number }[] = [];
    try { items = JSON.parse(o.items || "[]"); } catch { items = []; }
    for (const it of items) {
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      if (it.productId != null) await dz.update(product).set({ inventory: sql`max(0, ${product.inventory} - ${qty})` }).where(eq(product.id, Number(it.productId))).run();
      if (it.variantId != null) await dz.update(variant).set({ inventory: sql`max(0, ${variant.inventory} - ${qty})` }).where(eq(variant.id, Number(it.variantId))).run();
    }
  }
  return changed;
}

/** The buyer's email for the receipt — the verified session email the auth middleware stashed (null for guests). */
const buyerEmail = (c: Context): string | null => (c.get("sessionEmail") as string | undefined) ?? null;
/** A guest's typed checkout email — lightly validated server-side so a guest order can still send a receipt. */
const cleanEmail = (x: unknown): string | null => {
  const s = String(x ?? "").trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

/**
 * Fire the order-confirmation receipt via @suluk/email's rich, locale-aware template (icon + line table + CTA) —
 * the SINGLE receipt site, called only on the once-only pending→paid transition (so a webhook re-deliver / double
 * confirm can't double-send). Best-effort: a render/send hiccup must NEVER break a completed sale, so it's wrapped.
 * Reads order.customerEmail (snapshotted at checkout from the session), so guests with no email simply get no email.
 */
async function sendOrderReceipt(c: Context, dz: Dz, orderId: number): Promise<void> {
  try {
    const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
    if (!o || o.status !== "paid" || !o.customerEmail) return;
    let items: { name?: string; qty?: number; priceCents?: number; variantLabel?: string }[] = [];
    try { items = JSON.parse(o.items || "[]"); } catch { items = []; }
    const lines = items.map((l) => {
      const qty = Math.max(1, Math.floor(Number(l.qty) || 1));
      return { name: l.variantLabel ? `${l.name ?? "Item"} — ${l.variantLabel}` : (l.name ?? "Item"), qty, totalCents: Math.max(0, Math.round(Number(l.priceCents) || 0)) * qty };
    });
    // surface the ship-to on the receipt for physical orders (one display line per array entry; @suluk/email escapes them)
    let ship: string[] | undefined;
    if (o.shippingAddress) {
      try {
        const a = JSON.parse(o.shippingAddress) as ShipTo;
        ship = [a.name, a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(", "), a.country].filter((s): s is string => !!s && !!s.trim());
      } catch { ship = undefined; }
    }
    const origin = new URL(c.req.url).origin;
    const { subject, html } = orderConfirmationEmail(
      { orderNumber: String(o.id), items: lines, totalCents: o.totalCents, currency: "usd", orderUrl: `${origin}/dashboard`, ...(ship && ship.length ? { shippingAddress: ship } : {}) },
      { brand: { brandName: "saasuluk", baseUrl: origin, accentFrom: "#ef8e5f", accentTo: "#f5a97f" } },
    );
    sendEmailAsync({ to: o.customerEmail, subject, html }, { apiKey: secret(c, "RESEND_API_KEY"), from: secret(c, "EMAIL_FROM") });
  } catch { /* a receipt failure must never break the sale */ }
}

/** Get-or-create the signed-in principal's Stripe customer, recorded on their billing_account row. ONE customer
 *  per user underpins both card-saving at checkout (the saved card attaches here) and the billing portal (which
 *  lists that customer's cards + invoices). Usage billing's connect flow tops up a subscription on the SAME row. */
export async function ensureStripeCustomer(dz: Dz, key: string, who: string, email?: string): Promise<string> {
  const existing = await dz.select().from(billingAccount).where(eq(billingAccount.principal, who)).get();
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;
  const customer = await restStripe(key).customers.create(customerParams({ email, metadata: { principal: who } }));
  if (existing) await dz.update(billingAccount).set({ stripeCustomerId: customer.id }).where(eq(billingAccount.id, existing.id)).run();
  else await dz.insert(billingAccount).values({ principal: who, stripeCustomerId: customer.id, subscriptionId: null, lastReportedMicroUsd: 0, createdAt: Date.now() }).run();
  return customer.id;
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
interface ResolvedDiscount { valid: boolean; discountType?: "percent" | "fixed"; discountValue?: number; reason?: string; maxDiscountCents?: number; minSubtotalCents?: number }
/** A server-re-priced order line — the client's priceCents is NEVER trusted; every cent comes from the product/variant row. */
interface PricedLine { productId: number; variantId?: number; qty: number; priceCents: number; name: string; image?: string; variantLabel?: string; stripePriceId?: string; inventory: number }

/** The first stock problem in the cart (sold-out / over-qty), or null if everything is available. */
function stockError(lines: PricedLine[]): string | null {
  for (const l of lines) {
    const label = l.name + (l.variantLabel ? ` (${l.variantLabel})` : "");
    if (l.inventory <= 0) return `${label} is sold out.`;
    if (l.qty > l.inventory) return `Only ${l.inventory} of ${label} ${l.inventory === 1 ? "is" : "are"} left.`;
  }
  return null;
}

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
  connectBilling: write(60), reportUsage: write(40), openBillingPortal: write(40),
};

// typed input bodies for the custom ops with REAL bounds (validations.ts) — a bare {type:"object"} is a free-form bag.
const obj = (properties: Record<string, unknown>, required?: string[]) => ({ type: "object", additionalProperties: false, properties, ...(required ? { required } : {}) });
const ID = 1_000_000_000_000;
const cartLine = obj({ productId: v.int(1, ID), variantId: v.int(1, ID), qty: v.int(1, 1000), priceCents: v.cents() });
const payLine = obj({ productId: v.int(1, ID), variantId: v.int(1, ID), qty: v.int(1, 1000) });
// shipping address captured at checkout for physical goods — a JSON snapshot stored on the order. line2/state optional;
// the rest are required IF an address is supplied (a digital-only order simply omits the whole object).
const shipAddress = obj({ name: v.line(120), line1: v.line(160), line2: v.line(160), city: v.line(100), state: v.line(100), postalCode: v.line(20), country: v.line(56) }, ["name", "line1", "city", "postalCode", "country"]);

/** The v4 path fragment for the custom operations — merged into the contract document (then hardened below). */
export const OPERATION_PATHS: Record<string, unknown> = {
  "checkout/order": { requests: { checkout: jsonOp("post", "Create an order from a cart (apply discount, total)", { body: obj({ cartId: v.int(1, ID), items: { type: "array", maxItems: 200, items: cartLine }, discountCode: v.code(40), email: v.email(), shippingAddress: shipAddress }), status: 201 }) } },
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
  "checkout/pay": { requests: { payCheckout: jsonOp("post", "Create a pending order + a Stripe Checkout Session (returns the hosted URL)", { body: obj({ items: { type: "array", maxItems: 200, items: payLine }, discountCode: v.code(40), email: v.email(), shippingAddress: shipAddress }) }) } },
  "checkout/confirm": { requests: { confirmCheckout: jsonOp("post", "Confirm payment by retrieving the Stripe session; mark the order paid", { body: obj({ orderId: v.int(1, ID), sessionId: v.line(255, "^[A-Za-z0-9_]+$") }, ["orderId", "sessionId"]) }) } },
  "billing/connect": { requests: { connectBilling: jsonOp("post", "Start usage-based billing: a Stripe customer + a metered subscription", { body: obj({ email: v.email() }) }) } },
  "billing/report": { requests: { reportUsage: jsonOp("post", "Report your accrued @suluk/cost usage to the Stripe Billing Meter", { body: { type: "object", additionalProperties: false } }) } },
  "billing/portal": { requests: { openBillingPortal: jsonOp("post", "Open the Stripe customer billing portal (manage saved cards + invoices)", { body: { type: "object", additionalProperties: false } }) } },
};

// HARDEN the custom-op inputs (the answer to @suluk/harden's findings): bound strings/numbers/arrays + close objects.
for (const pi of Object.values(OPERATION_PATHS) as { requests?: Record<string, Record<string, unknown>> }[]) {
  for (const req of Object.values(pi.requests ?? {})) {
    if (req.contentSchema) req.contentSchema = hardenSchema(req.contentSchema);
    const psk = req.parameterSchema as Record<string, unknown> | undefined;
    if (psk) for (const loc of ["query", "path", "header", "cookie", "body"]) if (psk[loc]) psk[loc] = hardenSchema(psk[loc]);
  }
}

const fmtUsd = (cents: number) => "$" + (Math.max(0, Math.round(cents)) / 100).toFixed(2);

/** Validate a discount code against the table — the FULL eligibility set (saastarter-parity): exists, active, within
 *  its date window (startsAt..expiresAt), under its global + per-customer usage caps, above its minimum subtotal, and
 *  in scope for the cart's products. `opts` carries the live cart context the data-dependent checks need. Returns the
 *  cap (maxDiscountCents) + minimum so applyDiscount can clamp exactly. Reasons are human + actionable. */
async function resolveDiscount(dz: Dz, raw: string, opts: { subtotalCents?: number; principal?: string; productIds?: number[] } = {}): Promise<ResolvedDiscount> {
  const code = String(raw ?? "").toUpperCase().trim();
  if (!code) return { valid: false, reason: "Enter a discount code." };
  const d = await dz.select().from(discountCode).where(eq(discountCode.code, code)).get();
  if (!d) return { valid: false, reason: "That code isn’t recognized." };
  if (!d.isActive) return { valid: false, reason: "This code is no longer active." };
  const now = Date.now();
  if (d.startsAt != null && now < Number(d.startsAt)) return { valid: false, reason: "This code isn’t active yet." };
  if (d.expiresAt != null && Number(d.expiresAt) < now) return { valid: false, reason: "This code has expired." };
  if (d.maxUses != null && Number(d.currentUses) >= Number(d.maxUses)) return { valid: false, reason: "This code has reached its usage limit." };
  if (d.minSubtotalCents != null && opts.subtotalCents != null && opts.subtotalCents < Number(d.minSubtotalCents)) return { valid: false, reason: `Spend at least ${fmtUsd(Number(d.minSubtotalCents))} to use this code.` };
  // product scope — the cart must contain at least one eligible product
  if (d.appliesToProductIds && opts.productIds?.length) {
    let scope: number[] = [];
    try { scope = JSON.parse(d.appliesToProductIds as string); } catch { scope = []; }
    if (Array.isArray(scope) && scope.length && !opts.productIds.some((id) => scope.includes(id))) return { valid: false, reason: "This code doesn’t apply to the items in your cart." };
  }
  // per-customer cap — count this principal's prior PAID/shipped orders that used this code
  if (d.maxUsesPerCustomer != null && opts.principal) {
    const prior = (await dz.select({ id: order.id }).from(order)
      .where(and(eq(order.customerId, opts.principal), eq(order.discountCode, code), or(eq(order.status, "paid"), eq(order.status, "shipped")))).all()) as unknown[];
    if (prior.length >= Number(d.maxUsesPerCustomer)) return { valid: false, reason: "You’ve already redeemed this code." };
  }
  return { valid: true, discountType: d.discountType, discountValue: Number(d.discountValue), maxDiscountCents: d.maxDiscountCents != null ? Number(d.maxDiscountCents) : undefined, minSubtotalCents: d.minSubtotalCents != null ? Number(d.minSubtotalCents) : undefined };
}

/** Apply a resolved discount to a cents total via @suluk/stripe's tested money primitive — poison-guarded, CLAMPED to
 *  [0, total], and now CAPPED at maxDiscountCents (e.g. "30% off, up to $50"). One shared conformance-tested core. */
function applyDiscount(totalCents: number, d: ResolvedDiscount): number {
  if (!d.valid || !d.discountType) return totalCents;
  const discount: Discount = { type: d.discountType, value: d.discountValue ?? 0, maxDiscountCents: d.maxDiscountCents, minSubtotalCents: d.minSubtotalCents };
  return totalCents - computeDiscountAmount(totalCents, discount);
}

/** The primary display image for a product (preferring a selected variant's gallery, then the product gallery). */
function firstImage(p: { imageUrl?: string | null; images?: string | null }, v?: { images?: string | null }): string | undefined {
  for (const src of [v?.images, p.images]) {
    if (typeof src === "string" && src) { try { const arr = JSON.parse(src); if (Array.isArray(arr) && arr[0]?.url) return arr[0].url as string; } catch { /* ignore */ } }
  }
  return p.imageUrl ?? undefined;
}

/** SERVER-AUTHORITATIVE re-pricing — the client sends only {productId, variantId?, qty}; every price comes from the
 *  product/variant row (a variant with priceCentsEnabled charges its own price, else it inherits the product's). The
 *  returned lines also snapshot name/image/variantLabel so the order immortalizes them. Unpublished products + variants
 *  belonging to another product are dropped. This is the one place price is decided, for BOTH checkout paths. */
async function repriceLines(dz: Dz, items: LineItem[]): Promise<PricedLine[]> {
  const valid = (Array.isArray(items) ? items : []).filter((i) => i?.productId != null);
  if (!valid.length) return [];
  const pids = [...new Set(valid.map((i) => Number(i.productId)))];
  const prods = (await dz.select().from(product).where(inArray(product.id, pids)).all()) as Record<string, unknown>[];
  const byPid = new Map(prods.map((p) => [Number(p.id), p]));
  const vids = [...new Set(valid.map((i) => (i.variantId != null ? Number(i.variantId) : null)).filter((x): x is number => x != null))];
  const vars = vids.length ? ((await dz.select().from(variant).where(inArray(variant.id, vids)).all()) as Record<string, unknown>[]) : [];
  const byVid = new Map(vars.map((vrow) => [Number(vrow.id), vrow]));
  const out: PricedLine[] = [];
  for (const i of valid) {
    const p = byPid.get(Number(i.productId));
    if (!p || p.status !== "published") continue;
    const qty = Math.max(1, Math.floor(Number(i.qty) || 1));
    const vrow = i.variantId != null ? byVid.get(Number(i.variantId)) : undefined;
    const vmatch = vrow && Number(vrow.productId) === Number(p.id) ? vrow : undefined;
    const priceCents = vmatch && vmatch.priceCentsEnabled ? Number(vmatch.priceCents) : Number(p.priceCents);
    out.push({ productId: Number(p.id), variantId: vmatch ? Number(vmatch.id) : undefined, qty, priceCents, name: String(p.name), image: firstImage(p as never, vmatch as never), variantLabel: vmatch ? String(vmatch.title) : undefined, stripePriceId: (p.stripePriceId as string) ?? undefined, inventory: Number(vmatch ? vmatch.inventory : p.inventory) });
  }
  return out;
}
const linesSubtotal = (lines: PricedLine[]) => lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
const orderItemsJson = (lines: PricedLine[]) => JSON.stringify(lines.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, priceCents: l.priceCents, name: l.name, image: l.image, variantLabel: l.variantLabel })));

/** Shipping address shape (the checkout form / contract); stored as a JSON snapshot on the order for physical goods. */
export interface ShipTo { name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string }
/** Strip <> + control chars (stored-XSS guard — this renders in the receipt + dashboard) and length-cap each field. */
const cleanField = (x: unknown, max: number) => String(x ?? "").replace(/[<> -]/g, "").trim().slice(0, max);
/** Server-authoritative address sanitize: returns a JSON snapshot, or null if absent/incomplete (digital orders skip it). */
function cleanAddress(a: unknown): string | null {
  if (!a || typeof a !== "object") return null;
  const r = a as ShipTo;
  const out = { name: cleanField(r.name, 120), line1: cleanField(r.line1, 160), line2: cleanField(r.line2, 160), city: cleanField(r.city, 100), state: cleanField(r.state, 100), postalCode: cleanField(r.postalCode, 20), country: cleanField(r.country, 56) };
  if (!out.name || !out.line1 || !out.city || !out.postalCode || !out.country) return null; // incomplete → treat as no address
  return JSON.stringify(out);
}

/** Bind the custom-operation handlers to a Drizzle instance and mount them on a Hono app. */
export function mountOperations(app: { get: (...a: unknown[]) => unknown; post: (...a: unknown[]) => unknown }, dbFor: DbFor): void {
  const checkout = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { cartId?: number; items?: LineItem[]; discountCode?: string; email?: string; shippingAddress?: ShipTo };
    let rawItems: LineItem[] = Array.isArray(body.items) ? body.items : [];
    let codeUsed: string | null = body.discountCode ?? null;
    if (body.cartId) {
      const ct = await dz.select().from(cart).where(eq(cart.id, Number(body.cartId))).get();
      if (ct) { try { rawItems = JSON.parse(ct.items || "[]"); } catch { rawItems = []; } codeUsed = codeUsed ?? ct.discountCode ?? null; }
    }
    // SERVER-AUTHORITATIVE: re-price every line from the product/variant rows (the client's priceCents is ignored).
    const lines = await repriceLines(dz, rawItems);
    if (!lines.length) return c.json({ error: "Your cart is empty." }, 422);
    const stock = stockError(lines); if (stock) return c.json({ error: stock }, 409); // never oversell
    const subtotal = linesSubtotal(lines);
    const who = principal(c);
    const disc = codeUsed ? await resolveDiscount(dz, codeUsed, { subtotalCents: subtotal, principal: who, productIds: lines.map((l) => l.productId) }) : { valid: false } as ResolvedDiscount;
    const total = applyDiscount(subtotal, disc);
    const codeFinal = disc.valid ? codeUsed!.toUpperCase().trim() : null;
    const created = await dz.insert(order).values({ customerId: who, customerEmail: buyerEmail(c) ?? cleanEmail(body.email), items: orderItemsJson(lines), totalCents: total, status: "pending", discountCode: codeFinal, shippingAddress: cleanAddress(body.shippingAddress), createdAt: Date.now() }).returning();
    const orderId = created[0].id;
    // FREE ORDER ($0 product or a 100%-off code): complete it immediately — there is nothing to charge. markOrderPaid
    // is the SINGLE place discount usage is incremented, so usage stays correct and isn't double-counted.
    const free = !requiresStripe(total);
    if (free && await markOrderPaid(dz, orderId)) await sendOrderReceipt(c, dz, orderId);
    const final = await dz.select().from(order).where(eq(order.id, orderId)).get();
    return c.json({ order: final, subtotalCents: subtotal, totalCents: total, discountApplied: disc.valid, free }, 201);
  };

  const validateDiscount = async (c: Context) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string; subtotalCents?: number; items?: LineItem[] };
    const productIds = Array.isArray(body.items) ? body.items.map((i) => Number(i.productId)).filter(Boolean) : undefined;
    const d = await resolveDiscount(dbFor(c), body.code ?? "", { subtotalCents: body.subtotalCents, principal: principal(c), productIds });
    const preview = d.valid && typeof body.subtotalCents === "number" ? applyDiscount(body.subtotalCents, d) : undefined;
    // 200 even when invalid (a {valid:false, reason} is not an HTTP error — the client shows the reason inline).
    return c.json({ ...d, ...(preview !== undefined ? { newTotalCents: preview } : {}) }, 200);
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
    const body = (await c.req.json().catch(() => ({}))) as { items?: LineItem[]; discountCode?: string; email?: string; shippingAddress?: ShipTo };
    const dz = dbFor(c);
    const who = principal(c);
    // SERVER-AUTHORITATIVE, variant-aware re-pricing (the same path the free checkout uses) — client priceCents ignored.
    const lines = await repriceLines(dz, Array.isArray(body.items) ? body.items : []);
    if (!lines.length) return c.json({ error: "No purchasable items in the cart." }, 422);
    const stock = stockError(lines); if (stock) return c.json({ error: stock }, 409); // never oversell
    const subtotal = linesSubtotal(lines);
    const disc = body.discountCode ? await resolveDiscount(dz, body.discountCode, { subtotalCents: subtotal, principal: who, productIds: lines.map((l) => l.productId) }) : { valid: false } as ResolvedDiscount;
    const total = applyDiscount(subtotal, disc);
    const codeUsed = disc.valid ? body.discountCode!.toUpperCase().trim() : null;
    // the order records the SERVER prices + the SERVER total (authoritative — matches what Stripe charges).
    const created = await dz.insert(order).values({ customerId: who, customerEmail: buyerEmail(c) ?? cleanEmail(body.email), items: orderItemsJson(lines), totalCents: total, status: "pending", discountCode: codeUsed, shippingAddress: cleanAddress(body.shippingAddress), createdAt: Date.now() }).returning();
    const orderId = created[0].id;
    // FREE ORDER: a $0 product or a 100%-off code drops the total below Stripe's $0.50 floor → complete it NOW (mark
    // paid, increment usage once via markOrderPaid) and skip Stripe entirely. This is the unified $0 outcome.
    if (!requiresStripe(total)) {
      if (await markOrderPaid(dz, orderId)) await sendOrderReceipt(c, dz, orderId);
      const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
      return c.json({ free: true, paid: true, order: o, orderId, totalCents: total });
    }
    // a real charge is required → only NOW do we need Stripe configured.
    const key = secret(c, "STRIPE_SECRET_KEY");
    if (!key) return c.json({ error: "Stripe is not configured (set STRIPE_SECRET_KEY).", orderId }, 503);
    const origin = new URL(c.req.url).origin;
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", `${origin}/checkout/success?order=${orderId}&session_id={CHECKOUT_SESSION_ID}`);
    form.set("cancel_url", `${origin}/checkout?cancelled=1`);
    form.set("client_reference_id", String(orderId));
    form.set("metadata[orderId]", String(orderId));
    // CARD-SAVING: for a signed-in shopper, attach their Stripe customer + save the payment method for future
    // on-session reuse, so the card they pay with shows up in the billing portal. Defensive — a customer hiccup
    // (e.g. Stripe blip) must never block the sale, so we fall back to an anonymous Checkout Session.
    if (who) {
      try {
        const customerId = await ensureStripeCustomer(dz, key, who);
        form.set("customer", customerId);
        form.set("payment_intent_data[setup_future_usage]", "on_session");
      } catch { /* anonymous checkout — the sale still completes, just without a saved card */ }
    }
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
    if (paid && await markOrderPaid(dz, orderId)) await sendOrderReceipt(c, dz, orderId); // pending-only transition + once-per-order discount bump + receipt (all idempotent)
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
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    // ONE Stripe customer per user (shared with checkout card-saving + the portal); connect just adds the metered sub.
    const customerId = await ensureStripeCustomer(dz, key, who, body.email);
    const acct = await dz.select().from(billingAccount).where(eq(billingAccount.principal, who)).get();
    if (acct?.subscriptionId) return c.json({ connected: true, already: true, customerId, subscriptionId: acct.subscriptionId });
    let subscriptionId: string | null = null;
    // metered subs bill at period end; default_incomplete avoids an upfront charge so it works without a card (test mode)
    try { const sub = await restStripe(key).subscriptions.create({ ...subscriptionParams({ customerId, priceId }), payment_behavior: "default_incomplete" }); subscriptionId = (sub as { id: string }).id; } catch { /* customer still meters */ }
    await dz.update(billingAccount).set({ subscriptionId }).where(eq(billingAccount.principal, who)).run();
    return c.json({ connected: true, customerId, subscriptionId });
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

  // Open the Stripe-hosted billing portal: the customer manages saved cards + sees invoices, no PCI surface of ours.
  const openBillingPortal = async (c: Context) => {
    const key = secret(c, "STRIPE_SECRET_KEY");
    if (!key) return c.json({ error: "Stripe is not configured (set STRIPE_SECRET_KEY)." }, 503);
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in first." }, 401);
    const dz = dbFor(c);
    const customerId = await ensureStripeCustomer(dz, key, who); // one customer per user — created on first portal/checkout
    const returnUrl = `${new URL(c.req.url).origin}/account`;
    try {
      const session = await restStripe(key).billingPortal!.sessions.create(billingPortalSessionParams({ customerId, returnUrl }));
      return c.json({ url: session.url });
    } catch (e) {
      // the portal needs a one-time activation in the Stripe dashboard (Settings → Billing → Customer portal).
      return c.json({ error: (e as Error).message || "Could not open the billing portal.", needsPortalConfig: true }, 502);
    }
  };

  // a deterministic identicon SVG from a seed — saastarter pulls @dicebear; here it is derived, dependency-free.
  const generateAvatar = (c: Context) => {
    const seed = c.req.query("seed") ?? "anon";
    const photo = PERSONA_PHOTOS[seed.toLowerCase()]; // demo personas → real headshot; everyone else → identicon
    if (photo) return c.redirect(photo, 302);
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
  app.post("/billing/portal", openBillingPortal);
}
