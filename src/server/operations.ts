/**
 * Custom operations — the domain verbs BEYOND CRUD (checkout, discount validation, search, analytics,
 * recommendations, …). The static v4 definitions + costs (OPERATION_PATHS / OPERATION_COSTS) are merged into the
 * contract so they appear in Scalar / /superadmin and are metered like every CRUD op; the handlers are a factory
 * over a Drizzle instance, so the dev server (bun:sqlite) and the Worker (D1) mount the exact same logic. Every
 * call is awaited, so it works whether the driver is synchronous (bun) or asynchronous (D1). saastarter
 * hand-writes each of these as a Next.js route + an Effect program; here they project from the same single source.
 */
import { and, eq, gte, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { CostModel } from "@suluk/cost";
import { product, variant, post, order, cart, review, reviewHelpfulVote, contactSubmission, stockNotification, discountCode, newsletterSubscriber, apiToken, billingAccount, costEvent, wishlistItem } from "./schema";
import { sendEmailAsync, brandedEmail } from "./email";
import { orderConfirmationEmail, orderStatusEmail } from "@suluk/email";
import { customerParams, subscriptionParams, meterEventParams, billingPortalSessionParams, computeDiscountAmount, requiresStripe, resolveShipping, resolveTax, composeTotal, type Discount } from "@suluk/stripe";
import { shippingProvider, taxProvider } from "./commerce";
import { restStripe } from "./stripe-rest";
import { METER_EVENT_DEFAULT } from "./env";
import { hardenSchema } from "./harden-schema";
import { redactRow, superadminEmails } from "./access";
import { v } from "./validations";

/** Strip private columns (a digital good's downloadUrl) from product rows headed to a PUBLIC display surface
 *  (search, related). The delivery URL reaches a buyer only via their order snapshot, never the open catalog. */
const publicProducts = <T extends Record<string, unknown>>(rows: T[]): T[] => rows.map((r) => redactRow("product", r, false));

/** Escape untrusted text before embedding it in server-built HTML (e.g. the owner-notification email body). The
 *  client-side analog of esc() — a contact form's name/subject/message are attacker-controlled and must not inject. */
const escHtml = (s: string): string => s.replace(/[<>&"]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m]!));

/** Buyer-facing projection of an order row (the /checkout/confirm response + success page). Strips ops-only columns
 *  — the customerId principal and stripePaymentIntentId — so the session-capability holder sees only their receipt. */
const publicOrderShape = <T extends Record<string, unknown> | undefined>(o: T): Record<string, unknown> | null => {
  if (!o) return null;
  const r = o as Record<string, unknown>;
  return {
    id: r.id, status: r.status, items: r.items, shippingAddress: r.shippingAddress, customerEmail: r.customerEmail,
    totalCents: r.totalCents, shippingCents: r.shippingCents, taxCents: r.taxCents, shippingMethod: r.shippingMethod,
    discountCode: r.discountCode, carrier: r.carrier, trackingNumber: r.trackingNumber, createdAt: r.createdAt,
  };
};

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

/** Email the store owner ONCE when a product/variant dips to/below the low-stock threshold after a paid sale. The
 *  conditional latch flip is the once-only gate (re-armed on restock), so concurrent paid orders don't multi-send. */
async function alertLowStock(c: Context, dz: Dz, kind: "product" | "variant", id: number, threshold: number, owners: string[]): Promise<void> {
  if (!owners.length) return; // no recipients configured → skip the extra read+write entirely
  const tbl = (kind === "product" ? product : variant) as typeof product; // both share id/inventory/lowStockAlerted
  const row = (await dz.select().from(tbl).where(eq(tbl.id, id)).get()) as { inventory?: number; lowStockAlerted?: boolean; name?: string; title?: string } | undefined;
  if (!row || Number(row.inventory) > threshold || row.lowStockAlerted) return; // above threshold, or already alerted at this level
  const res = (await dz.update(tbl).set({ lowStockAlerted: true }).where(and(eq(tbl.id, id), eq(tbl.lowStockAlerted, false))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
  if (Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) <= 0) return; // a concurrent paid order won the flip and already emailed
  const label = kind === "product" ? String(row.name ?? ("Product #" + id)) : ("Variant #" + id + (row.title ? " (" + row.title + ")" : ""));
  const origin = new URL(c.req.url).origin;
  sendEmailAsync( // fire-and-forget — a mail failure must never break the sale (same contract as the receipt)
    { to: owners.join(","), subject: ("Low stock: " + label).slice(0, 180), html: brandedEmail("Low stock alert", "<p><b>" + escHtml(label) + "</b> is down to " + Number(row.inventory) + " unit(s) (threshold " + threshold + "). Restock soon.</p><p><a href=\"" + origin + "/superadmin\">Open the admin cockpit →</a></p>") },
    { apiKey: secret(c, "RESEND_API_KEY"), from: secret(c, "EMAIL_FROM") },
  );
}

/**
 * Mark an order paid EXACTLY ONCE: a pending→paid transition (so a webhook re-delivery or a second confirm is a
 * no-op), and only on that transition do we bump the discount's usage. Returns true iff this call did the work.
 * Takes Context so a stock dip can email the owner (low-stock alert) — threaded through every call site.
 */
export async function markOrderPaid(c: Context, dz: Dz, orderId: number): Promise<boolean> {
  const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
  if (!o || o.status === "paid") return false;
  const res = (await dz.update(order).set({ status: "paid" }).where(and(eq(order.id, orderId), eq(order.status, "pending"))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
  const changed = Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0;
  if (changed) {
    if (o.discountCode) {
      await dz.update(discountCode).set({ currentUses: sql`${discountCode.currentUses} + 1` }).where(eq(discountCode.code, String(o.discountCode).toUpperCase().trim())).run();
    }
    const owners = superadminEmails(secret(c, "SUPERADMIN_EMAILS")); // low-stock alert recipients (empty → checks no-op)
    const threshold = Number(secret(c, "LOW_STOCK_THRESHOLD")) || 5;
    // decrement stock for each paid line (product + variant), clamped at 0 — the SINGLE place inventory is reduced,
    // on the once-only paid transition, so a webhook re-delivery / double-confirm can't double-decrement.
    let items: { productId?: number; variantId?: number; qty?: number }[] = [];
    try { items = JSON.parse(o.items || "[]"); } catch { items = []; }
    for (const it of items) {
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      // no max(0) clamp: the decrement must be the EXACT inverse of restockOrderLines' +qty, or a refund over-inflates
      // stock. stockError blocks overselling at checkout, so inventory stays >=0 in the normal path; a rare race that
      // dips it below 0 renders as "Sold out" (the <=0 check) and a later refund returns it to the true value.
      if (it.productId != null) { await dz.update(product).set({ inventory: sql`${product.inventory} - ${qty}` }).where(eq(product.id, Number(it.productId))).run(); await alertLowStock(c, dz, "product", Number(it.productId), threshold, owners); }
      if (it.variantId != null) { await dz.update(variant).set({ inventory: sql`${variant.inventory} - ${qty}` }).where(eq(variant.id, Number(it.variantId))).run(); await alertLowStock(c, dz, "variant", Number(it.variantId), threshold, owners); }
    }
  }
  return changed;
}

/** Cancel a still-PENDING order (Stripe session expired, or the abandoned-order reaper). Pending orders never
 *  decremented inventory (only markOrderPaid does), so there is nothing to restock — the once-only guard keeps it idempotent. */
export async function cancelPendingOrder(dz: Dz, orderId: number): Promise<boolean> {
  const res = (await dz.update(order).set({ status: "cancelled" }).where(and(eq(order.id, orderId), eq(order.status, "pending"))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
  return Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0;
}

/** Reaper — cancel PENDING orders older than `olderThanMs` (default 24h) so abandoned Stripe checkouts don't linger in
 *  the fulfillment queue forever. Returns the count cancelled. Run from the Worker's scheduled() cron. */
export async function reapAbandonedOrders(dz: Dz, olderThanMs = 86_400_000): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const stale = (await dz.select().from(order).where(and(eq(order.status, "pending"), lt(order.createdAt, cutoff))).all()) as { id: number }[];
  for (const o of stale) await cancelPendingOrder(dz, o.id);
  return stale.length;
}

/** Reverse the inventory + discount-usage effects of a PAID sale (markOrderPaid did the decrement/increment) — used when
 *  a paid order is refunded or admin-cancelled. The CALLER must ensure this runs exactly ONCE per order (gate on the
 *  paid/shipped → cancelled transition), so a webhook re-delivery can't double-restock. */
export async function restockOrderLines(dz: Dz, o: { items?: string | null; discountCode?: string | null }): Promise<void> {
  let items: { productId?: number; variantId?: number; qty?: number }[] = [];
  try { items = JSON.parse(o.items || "[]"); } catch { items = []; }
  for (const it of items) {
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    // restock RAISES stock → re-arm the low-stock latch so a future dip alerts again (else the owner is warned once, never again).
    if (it.productId != null) await dz.update(product).set({ inventory: sql`${product.inventory} + ${qty}`, lowStockAlerted: false }).where(eq(product.id, Number(it.productId))).run();
    if (it.variantId != null) await dz.update(variant).set({ inventory: sql`${variant.inventory} + ${qty}`, lowStockAlerted: false }).where(eq(variant.id, Number(it.variantId))).run();
  }
  if (o.discountCode) await dz.update(discountCode).set({ currentUses: sql`max(0, ${discountCode.currentUses} - 1)` }).where(eq(discountCode.code, String(o.discountCode).toUpperCase().trim())).run();
}

/** Refund a paid order (Stripe charge.refunded): flip paid/shipped → cancelled ONCE and restock. The conditional UPDATE
 *  is the once-only gate — a webhook re-delivery finds it already cancelled and does nothing (no double-restock). */
export async function refundOrder(dz: Dz, orderId: number): Promise<boolean> {
  const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
  if (!o) return false;
  // Stripe doesn't guarantee webhook ordering: a refund can arrive BEFORE checkout.session.completed. Terminate a
  // still-pending order so a later markOrderPaid (pending-only) can't resurrect it into a paid sale + decrement stock.
  if (o.status === "pending") {
    await dz.update(order).set({ status: "cancelled" }).where(and(eq(order.id, orderId), eq(order.status, "pending"))).run();
    return false; // nothing was decremented yet → nothing to restock
  }
  if (o.status !== "paid" && o.status !== "shipped") return false;
  const res = (await dz.update(order).set({ status: "cancelled" }).where(and(eq(order.id, orderId), inArray(order.status, ["paid", "shipped"]))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
  if (!(Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0)) return false;
  // restock ONLY a paid (not-yet-shipped) order — a shipped order's goods already left, so they don't return to stock.
  if (o.status === "paid") await restockOrderLines(dz, o);
  return true;
}

/** The buyer's email for the receipt — the verified session email the auth middleware stashed (null for guests). */
const buyerEmail = (c: Context): string | null => (c.get("sessionEmail") as string | undefined) ?? null;

/**
 * Idempotency for FREE orders: a retry / double-submit / multi-tab must not mint a SECOND $0 order — that would
 * double-send the receipt AND double-decrement inventory. Returns a recent (≤90s) PAID order id from the SAME buyer
 * (principal, else the guest email) with the identical items snapshot + total, or null. Stripe orders are NOT deduped
 * here: a duplicate PENDING order is benign (only one Checkout Session ever completes) and the client disables the
 * button. The narrow SQL filter (paid + total + recent) keeps it cheap; items + buyer are matched in memory.
 */
async function recentPaidDuplicate(dz: Dz, opts: { who: string | null; email: string | null; itemsJson: string; total: number }): Promise<number | null> {
  if (!opts.who && !opts.email) return null; // anonymous with no email can't be correlated — skip
  const since = Date.now() - 90_000;
  const rows = (await dz.select().from(order).where(and(eq(order.status, "paid"), eq(order.totalCents, opts.total), gte(order.createdAt, since))).all()) as { id: number; items: string | null; customerId: string | null; customerEmail: string | null }[];
  const m = rows.find((o) => (o.items ?? "") === opts.itemsJson && (opts.who ? o.customerId === opts.who : o.customerEmail === opts.email));
  return m ? m.id : null;
}

/** Known-carrier tracking deep-link for the order-status email (else the email links to the buyer's orders page). */
const CARRIER_TRACK: Record<string, string> = { ups: "https://www.ups.com/track?tracknum=", usps: "https://tools.usps.com/go/TrackConfirmAction?tLabels=", fedex: "https://www.fedex.com/fedextrack/?trknbr=", dhl: "https://www.dhl.com/en/express/tracking.html?AWB=" };
const carrierTrackingUrl = (carrier: string | null, num: string | null): string | undefined => {
  if (!num) return undefined;
  const base = CARRIER_TRACK[String(carrier ?? "").toLowerCase().trim()];
  return base ? base + encodeURIComponent(num) : undefined;
};

/** Issue a Stripe refund for a paid order. The order stores its Checkout SESSION id (stripePaymentIntentId), so first
 *  resolve the PaymentIntent, then refund it. Returns true on success — OR when there is nothing to refund (a $0/free
 *  order has no PaymentIntent). Any Stripe error → false, so the caller can refuse to cancel an order it couldn't refund. */
async function stripeRefund(key: string, sessionId: string, idemKey: string): Promise<boolean> {
  try {
    const s = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { headers: { authorization: `Bearer ${key}` } });
    if (!s.ok) return false;
    const sess = (await s.json()) as { payment_intent?: string };
    if (!sess.payment_intent) return true; // no charge to reverse (free / $0 order)
    const pi = sess.payment_intent;
    // ALREADY fully refunded (out-of-band in the dashboard, or a retry after a lost HTTP response)? Treat as success so
    // the cancel completes instead of looping on 502. Check the PI's latest charge's refunded state.
    const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pi)}?expand[]=latest_charge`, { headers: { authorization: `Bearer ${key}` } });
    if (piRes.ok) {
      const ch = ((await piRes.json()) as { latest_charge?: { amount?: number; amount_refunded?: number; refunded?: boolean } }).latest_charge;
      if (ch && (ch.refunded === true || (typeof ch.amount === "number" && typeof ch.amount_refunded === "number" && ch.amount_refunded >= ch.amount))) return true;
    }
    // Idempotency-Key so a retried request (after a lost response) returns the SAME refund, never a duplicate.
    const r = await fetch("https://api.stripe.com/v1/refunds", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idemKey }, body: `payment_intent=${encodeURIComponent(pi)}` });
    if (r.ok) return true;
    const err = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
    return err.error?.code === "charge_already_refunded"; // nothing left to refund → success for our purpose
  } catch { return false; }
}
/** A guest's typed checkout email — lightly validated server-side so a guest order can still send a receipt. */
const cleanEmail = (x: unknown): string | null => {
  const s = String(x ?? "").trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};
/** base64url(email) — obscures the address in the unsubscribe URL (not a bare email in the query string). */
const unsubToken = (email: string) => btoa(email).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** Best-effort mirror of a subscriber into the Resend AUDIENCE (where broadcasts are sent from), so the list isn't
 *  only the local table. No-op until RESEND_AUDIENCE_ID is configured. The local newsletter_subscriber row stays the
 *  source of truth; this just keeps Resend in sync (create on subscribe, flag unsubscribed:true on unsubscribe). */
function resendAudienceSync(c: Context, email: string, unsubscribed: boolean): void {
  const key = secret(c, "RESEND_API_KEY"), audience = secret(c, "RESEND_AUDIENCE_ID");
  if (!key || !audience) return;
  const h = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const base = `https://api.resend.com/audiences/${audience}/contacts`;
  const p = (unsubscribed
    ? fetch(`${base}/${encodeURIComponent(email)}`, { method: "PATCH", headers: h, body: JSON.stringify({ unsubscribed: true }) })
    : fetch(base, { method: "POST", headers: h, body: JSON.stringify({ email, unsubscribed: false }) })
  ).catch(() => {});
  // keep the fire-and-forget alive past the Worker response (an un-awaited fetch can otherwise be cancelled).
  try { (c.executionCtx as { waitUntil?: (x: Promise<unknown>) => void } | undefined)?.waitUntil?.(p); } catch { /* dev/Node: no executionCtx — the promise runs inline */ }
}

/**
 * Fire the order-confirmation receipt via @suluk/email's rich, locale-aware template (icon + line table + CTA) —
 * the SINGLE receipt site, called only on the once-only pending→paid transition (so a webhook re-deliver / double
 * confirm can't double-send). Best-effort: a render/send hiccup must NEVER break a completed sale, so it's wrapped.
 * Reads order.customerEmail (snapshotted at checkout from the session), so guests with no email simply get no email.
 */
export async function sendOrderReceipt(c: Context, dz: Dz, orderId: number): Promise<void> {
  try {
    const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
    if (!o || o.status !== "paid" || !o.customerEmail) return;
    let items: { name?: string; qty?: number; priceCents?: number; variantLabel?: string }[] = [];
    try { items = JSON.parse(o.items || "[]"); } catch { items = []; }
    const lines = items.map((l) => {
      const qty = Math.max(1, Math.floor(Number(l.qty) || 1));
      return { name: l.variantLabel ? `${l.name ?? "Item"} — ${l.variantLabel}` : (l.name ?? "Item"), qty, totalCents: Math.max(0, Math.round(Number(l.priceCents) || 0)) * qty };
    });
    // append the adjustment lines (discount/shipping/tax) so the receipt's lines sum EXACTLY to the total.
    const goodsCents = lines.reduce((s, l) => s + l.totalCents, 0);
    const shipC = Math.max(0, Number(o.shippingCents) || 0), taxC = Math.max(0, Number(o.taxCents) || 0);
    const discC = goodsCents - ((o.totalCents || 0) - shipC - taxC);
    if (discC > 0) lines.push({ name: o.discountCode ? `Discount (${o.discountCode})` : "Discount", qty: 1, totalCents: -discC });
    if (shipC > 0) lines.push({ name: "Shipping", qty: 1, totalCents: shipC });
    if (taxC > 0) lines.push({ name: "Sales tax", qty: 1, totalCents: taxC });
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

/** Email a product's back-in-stock waitlist exactly once. ATOMIC claim-then-send (the compare-and-set gate
 *  alertLowStock/markOrderPaid use): stamp notifiedAt + RETURNING the rows this call won, then email ONLY those —
 *  so concurrent restocks each claim a disjoint set (no double-send) and a row inserted mid-flight is either claimed
 *  (and emailed) or left for the next restock (never stamped-but-unsent). Best-effort sends; fired on a 0→+ restock. */
export async function notifyBackInStock(c: Context, dz: Dz, productId: number): Promise<void> {
  const p = (await dz.select().from(product).where(eq(product.id, productId)).get()) as { name?: string; slug?: string } | undefined;
  if (!p) return; // the hook fires from this product's own update, so this is a defensive guard, not a real path
  // CLAIM first: only rows this UPDATE flips (notifiedAt was NULL) come back; a concurrent caller claims the rest.
  const claimed = (await dz.update(stockNotification).set({ notifiedAt: Date.now() }).where(and(eq(stockNotification.productId, productId), isNull(stockNotification.notifiedAt))).returning()) as { email?: string }[];
  if (!claimed.length) return;
  const url = new URL(c.req.url).origin + "/products/" + String(p.slug ?? "");
  const apiKey = secret(c, "RESEND_API_KEY"), from = secret(c, "EMAIL_FROM");
  for (const s of claimed) {
    if (!s.email) continue;
    sendEmailAsync({ to: String(s.email), subject: ("Back in stock: " + (p.name ?? "your item")).slice(0, 180), html: brandedEmail("Back in stock 🎉", "<p><b>" + escHtml(String(p.name ?? "Your item")) + "</b> is available again — but it may not last.</p><p><a href=\"" + url + "\">Get it now →</a></p>") }, { apiKey, from });
  }
}

/** afterUpdate hooks for the generic CRUD, keyed by table name (mirrors PRIVATE_READ_COLS). When inventory crosses
 *  from sold-out (<=0) back to positive — a merchant restock via the admin CRUD — fire the back-in-stock waitlist.
 *  A variant restock notifies its parent product's waitlist. */
const CRUD_AFTER_UPDATE: Record<string, (c: Context, dz: Dz, before: Record<string, unknown>, after: Record<string, unknown>) => Promise<void>> = {
  product: async (c, dz, before, after) => { if (Number(before.inventory) <= 0 && Number(after.inventory) > 0) await notifyBackInStock(c, dz, Number(after.id)); },
  variant: async (c, dz, before, after) => { if (Number(before.inventory) <= 0 && Number(after.inventory) > 0) await notifyBackInStock(c, dz, Number(after.productId)); },
};
/** Tables with an afterUpdate hook — the CRUD factories pre-read the before-row only for these (mirrors redactRow). */
export const CRUD_AFTER_UPDATE_TABLES = new Set(Object.keys(CRUD_AFTER_UPDATE));
/** Run a table's afterUpdate hook (no-op when none). Called by BOTH CRUD twins (dev crud.ts + worker d1Crud). */
export async function crudAfterUpdate(tableName: string, c: Context, dz: Dz, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
  const h = CRUD_AFTER_UPDATE[tableName];
  if (h) await h(c, dz, before, after);
}

const read = (m: number): CostModel => ({ components: [{ source: "db-read", basis: "per-call", microUsd: m }], estimateMicroUsd: m });
const write = (m: number): CostModel => ({ components: [{ source: "compute", basis: "per-call", microUsd: 100 }, { source: "db-write", basis: "per-call", microUsd: m }], estimateMicroUsd: 100 + m });

interface LineItem { productId?: number; variantId?: number; qty?: number; priceCents?: number }
interface ResolvedDiscount { valid: boolean; discountType?: "percent" | "fixed"; discountValue?: number; reason?: string; maxDiscountCents?: number; minSubtotalCents?: number }
/** A server-re-priced order line — the client's priceCents is NEVER trusted; every cent comes from the product/variant row. */
interface PricedLine { productId: number; variantId?: number; qty: number; priceCents: number; name: string; image?: string; variantLabel?: string; stripePriceId?: string; inventory: number; requiresShipping: boolean; downloadUrl?: string }

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
  checkout: write(80), validateDiscount: read(10), search: read(14), markReviewHelpful: write(20), submitReview: write(25), setOrderStatus: write(30),
  analyticsSummary: read(20), analyticsRevenue: read(20), analyticsTopProducts: read(24),
  recommendRelated: read(16), subscribeNewsletter: write(20), unsubscribeNewsletter: read(8), submitContact: write(20), subscribeStock: write(20), generateAvatar: read(2),
  createToken: write(30), revokeToken: write(20),
  payCheckout: write(90), confirmCheckout: read(30), quoteCheckout: read(12),
  connectBilling: write(60), reportUsage: write(40), openBillingPortal: write(40), exportAccount: read(20),
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
  "checkout/order": { requests: { checkout: jsonOp("post", "Create an order from a cart (apply discount, total)", { body: obj({ cartId: v.int(1, ID), items: { type: "array", maxItems: 200, items: cartLine }, discountCode: v.code(40), email: v.email(), shippingMethod: v.line(40), shippingAddress: shipAddress }), status: 201 }) } },
  "discount/validate": { requests: { validateDiscount: jsonOp("post", "Validate a discount code", { body: obj({ code: v.code(40), subtotalCents: v.cents(100_000_000_000) }, ["code"]) }) } },
  "search": { requests: { search: jsonOp("get", "Search products + blog posts", { params: { query: obj({ q: v.line(200) }) } }) } },
  "review/{id}/helpful": { requests: { markReviewHelpful: jsonOp("post", "Mark a review helpful (+1)", { params: idParam }) } },
  "review/submit": { requests: { submitReview: jsonOp("post", "Submit a product review — auto-flags verified-purchase when the reviewer has a paid order for the product", { body: obj({ productId: v.int(1, ID), rating: v.int(1, 5), title: v.line(160), body: v.rich(5000) }, ["productId", "rating"]), status: 201 }) } },
  "order/{id}/status": { requests: { setOrderStatus: jsonOp("post", "Admin: advance an order's fulfillment status (paid/shipped/cancelled) + record tracking; emails the buyer on shipped/cancelled", { params: idParam, body: obj({ status: v.line(20), carrier: v.line(60), trackingNumber: v.line(80) }, ["status"]) }) } },
  "analytics/summary": { requests: { analyticsSummary: jsonOp("get", "Store summary (orders, revenue, customers)") } },
  "analytics/revenue": { requests: { analyticsRevenue: jsonOp("get", "Revenue per day (last 30d)") } },
  "analytics/top-products": { requests: { analyticsTopProducts: jsonOp("get", "Best-selling products") } },
  "recommendations/{productId}": { requests: { recommendRelated: jsonOp("get", "Related products", { params: { path: { type: "object", properties: { productId: { type: "string", maxLength: 16, pattern: "^[0-9]+$" } }, required: ["productId"] } } }) } },
  "newsletter/subscribe": { requests: { subscribeNewsletter: jsonOp("post", "Subscribe to the newsletter (idempotent)", { body: obj({ email: v.email() }, ["email"]), status: 201 }) } },
  "contact/submit": { requests: { submitContact: jsonOp("post", "Submit the contact form (persists + notifies the store owner)", { body: obj({ name: v.line(120), email: v.email(), subject: v.line(160), message: v.line(4000) }, ["name", "email", "subject", "message"]), status: 201 }) } },
  "product/{id}/notify-stock": { requests: { subscribeStock: jsonOp("post", "Join a sold-out product's back-in-stock waitlist", { params: idParam, body: obj({ email: v.email() }, ["email"]), status: 201 }) } },
  "newsletter/unsubscribe": { requests: { unsubscribeNewsletter: jsonOp("get", "Unsubscribe from the newsletter via a tokenized one-click link", { params: { query: obj({ t: v.line(400) }) }, contentType: "text/html", response: { type: "string" } }) } },
  "avatar": { requests: { generateAvatar: jsonOp("get", "Deterministic identicon SVG", { params: { query: obj({ seed: v.line(100, "^[\\w .@-]{0,100}$") }) }, contentType: "image/svg+xml", response: { type: "string" } }) } },
  "tokens/create": { requests: { createToken: jsonOp("post", "Create an API token (returns the secret ONCE)", { body: obj({ name: v.line(80) }, ["name"]), status: 201 }) } },
  "tokens/{id}/revoke": { requests: { revokeToken: jsonOp("post", "Revoke an API token", { params: idParam }) } },
  "checkout/pay": { requests: { payCheckout: jsonOp("post", "Create a pending order + a Stripe Checkout Session (returns the hosted URL)", { body: obj({ items: { type: "array", maxItems: 200, items: payLine }, discountCode: v.code(40), email: v.email(), shippingMethod: v.line(40), shippingAddress: shipAddress }) }) } },
  "checkout/quote": { requests: { quoteCheckout: jsonOp("post", "Quote the live order total — subtotal − discount + shipping + tax (via the pluggable @suluk/stripe adapters)", { body: obj({ items: { type: "array", maxItems: 200, items: payLine }, discountCode: v.code(40), shippingMethod: v.line(40), shippingAddress: shipAddress }) }) } },
  "checkout/confirm": { requests: { confirmCheckout: jsonOp("post", "Confirm payment by retrieving the Stripe session; mark the order paid", { body: obj({ orderId: v.int(1, ID), sessionId: v.line(255, "^[A-Za-z0-9_]+$") }, ["orderId", "sessionId"]) }) } },
  "billing/connect": { requests: { connectBilling: jsonOp("post", "Start usage-based billing: a Stripe customer + a metered subscription", { body: obj({ email: v.email() }) }) } },
  "billing/report": { requests: { reportUsage: jsonOp("post", "Report your accrued @suluk/cost usage to the Stripe Billing Meter", { body: { type: "object", additionalProperties: false } }) } },
  "billing/portal": { requests: { openBillingPortal: jsonOp("post", "Open the Stripe customer billing portal (manage saved cards + invoices)", { body: { type: "object", additionalProperties: false } }) } },
  "account/export": { requests: { exportAccount: jsonOp("get", "Export all your account data (GDPR) — orders, wishlist, reviews, token metadata — as a downloadable JSON") } },
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
    out.push({ productId: Number(p.id), variantId: vmatch ? Number(vmatch.id) : undefined, qty, priceCents, name: String(p.name), image: firstImage(p as never, vmatch as never), variantLabel: vmatch ? String(vmatch.title) : undefined, stripePriceId: (p.stripePriceId as string) ?? undefined, inventory: Number(vmatch ? vmatch.inventory : p.inventory), requiresShipping: !!p.requiresShipping, downloadUrl: (p.downloadUrl as string) ?? undefined });
  }
  return out;
}
const linesSubtotal = (lines: PricedLine[]) => lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
const orderItemsJson = (lines: PricedLine[]) => JSON.stringify(lines.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, priceCents: l.priceCents, name: l.name, image: l.image, variantLabel: l.variantLabel, downloadUrl: l.downloadUrl })));

export interface OrderTotals { subtotalCents: number; discountCents: number; shippingCents: number; taxCents: number; totalCents: number; shippingMethod: string | null }
/**
 * The authoritative full total — subtotal − discount + shipping + tax — via the pluggable @suluk/stripe adapters
 * (./commerce). Shipping is quoted off the POST-discount goods total (so "free over $X" tracks what's actually spent)
 * and is $0 for a digital-only cart; tax is computed on the discounted base. The SINGLE place the order total is
 * composed, so checkout, the live quote, and the stored order can never disagree. Server-authoritative (the client
 * only proposes a shipping-method id; everything else is recomputed here).
 */
async function computeOrderTotals(lines: PricedLine[], disc: ResolvedDiscount, opts: { address?: ShipTo; shippingMethod?: string } = {}): Promise<OrderTotals> {
  const subtotalCents = linesSubtotal(lines);
  const discountedGoods = applyDiscount(subtotalCents, disc); // subtotal − discount, already clamped to [0, subtotal]
  const discountCents = subtotalCents - discountedGoods;
  // the free-over threshold must track only what ACTUALLY ships — a digital line never ships, so it can't earn free
  // physical shipping. Use the shippable-only subtotal (discounted proportionally) for the threshold check.
  const shippableSubtotal = lines.filter((l) => l.requiresShipping).reduce((s, l) => s + l.priceCents * l.qty, 0);
  const shippableForThreshold = subtotalCents > 0 ? Math.round(shippableSubtotal * (discountedGoods / subtotalCents)) : 0;
  const ship = await resolveShipping(shippingProvider, { subtotalCents: shippableForThreshold, lines: lines.map((l) => ({ id: l.productId, qty: l.qty, requiresShipping: l.requiresShipping })), address: opts.address }, opts.shippingMethod);
  const shippingCents = ship ? ship.amountCents : 0;
  const tax = await resolveTax(taxProvider, { subtotalCents: discountedGoods, shippingCents, address: opts.address }); // tax stays on the full discounted base
  const totalCents = composeTotal({ subtotalCents, discountCents, shippingCents, taxCents: tax.taxCents }).totalCents;
  // persist a method only when a fee is actually charged — a free/digital order has no method (matches shippingCents 0).
  return { subtotalCents, discountCents, shippingCents, taxCents: tax.taxCents, totalCents, shippingMethod: shippingCents > 0 && ship ? ship.id : null };
}

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
    const body = (await c.req.json().catch(() => ({}))) as { cartId?: number; items?: LineItem[]; discountCode?: string; email?: string; shippingAddress?: ShipTo; shippingMethod?: string };
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
    // FULL total via the pluggable shipping + tax adapters: subtotal − discount + shipping + tax.
    const totals = await computeOrderTotals(lines, disc, { address: body.shippingAddress, shippingMethod: body.shippingMethod });
    const total = totals.totalCents;
    const codeFinal = disc.valid ? codeUsed!.toUpperCase().trim() : null;
    const itemsJson = orderItemsJson(lines);
    const email = buyerEmail(c) ?? cleanEmail(body.email);
    // IDEMPOTENCY: a retry/double-submit of a FREE order must reuse the existing paid order, not create a second one.
    if (!requiresStripe(total)) {
      const dupId = await recentPaidDuplicate(dz, { who, email, itemsJson, total });
      if (dupId != null) { const o = await dz.select().from(order).where(eq(order.id, dupId)).get(); return c.json({ order: publicOrderShape(o), ...totals, discountApplied: disc.valid, free: true, duplicate: true }, 200); }
    }
    const created = await dz.insert(order).values({ customerId: who, customerEmail: email, items: itemsJson, totalCents: total, status: "pending", discountCode: codeFinal, shippingAddress: cleanAddress(body.shippingAddress), shippingCents: totals.shippingCents, taxCents: totals.taxCents, shippingMethod: totals.shippingMethod, createdAt: Date.now() }).returning();
    const orderId = created[0].id;
    // FREE ORDER ($0 product or a 100%-off code): complete it immediately — there is nothing to charge. markOrderPaid
    // is the SINGLE place discount usage is incremented, so usage stays correct and isn't double-counted.
    const free = !requiresStripe(total);
    if (free && await markOrderPaid(c, dz, orderId)) await sendOrderReceipt(c, dz, orderId);
    const final = await dz.select().from(order).where(eq(order.id, orderId)).get();
    return c.json({ order: final, ...totals, discountApplied: disc.valid, free }, 201);
  };

  // Live checkout breakdown — the server-authoritative subtotal/discount/shipping/tax/total for the current cart, so
  // the buyer sees the FULL total (incl. shipping + tax from the adapters) BEFORE paying. The client only proposes a
  // shipping-method id + address; everything is recomputed here (never trusts a client amount).
  const quoteCheckout = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { items?: LineItem[]; discountCode?: string; shippingAddress?: ShipTo; shippingMethod?: string };
    const lines = await repriceLines(dz, Array.isArray(body.items) ? body.items : []);
    const subtotal = linesSubtotal(lines);
    const disc = body.discountCode ? await resolveDiscount(dz, body.discountCode, { subtotalCents: subtotal, principal: principal(c), productIds: lines.map((l) => l.productId) }) : { valid: false } as ResolvedDiscount;
    const totals = await computeOrderTotals(lines, disc, { address: body.shippingAddress, shippingMethod: body.shippingMethod });
    return c.json({ ...totals, discountApplied: disc.valid, discountCode: disc.valid ? (body.discountCode ?? "").toUpperCase().trim() : null, needsShipping: lines.some((l) => l.requiresShipping), stockError: stockError(lines), free: !requiresStripe(totals.totalCents) }, 200);
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
    // match the product NAME or DESCRIPTION (was name-only), and posts on title or excerpt — a real store search.
    const products = await dz.select().from(product).where(and(eq(product.status, "published"), or(like(product.name, term), like(product.description, term)))).limit(10).all();
    const posts = await dz.select().from(post).where(and(eq(post.status, "published"), or(like(post.title, term), like(post.excerpt, term)))).limit(10).all();
    return c.json({ products: publicProducts(products as Record<string, unknown>[]), posts });
  };

  const markReviewHelpful = async (c: Context) => {
    const dz = dbFor(c);
    // require an authenticated principal — the vote is attributable + cost-metered, not anonymous stuffing.
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in to mark a review helpful." }, 401);
    const id = Number(c.req.param("id"));
    if (!id) return c.json({ error: "bad review id" }, 422);
    // ONE vote per (review, principal), TOGGLEABLE. The vote row is the source of truth; helpfulCount mirrors it.
    // Read-then-write keeps it driver-agnostic (bun:sqlite sync + D1 async differ on .run() affected-row reporting);
    // the (review_id, principal) UNIQUE index (migration 0003 / SCHEMA_SQL) is the race backstop via onConflictDoNothing.
    const existing = await dz.select().from(reviewHelpfulVote).where(and(eq(reviewHelpfulVote.reviewId, id), eq(reviewHelpfulVote.principal, who))).get();
    const affected = (r: unknown): number => { const x = r as { meta?: { changes?: number }; changes?: number; rowsAffected?: number }; return Number(x?.meta?.changes ?? x?.changes ?? x?.rowsAffected ?? 0); };
    let voted: boolean;
    if (!existing) {
      // Gate the +1 on the INSERT actually creating a row: two concurrent first-clicks both pass the read-check, but the
      // unique index makes one insert a no-op (onConflictDoNothing → 0 rows) — only the winner increments, so the counter
      // never drifts above the vote-row count.
      const ins = await dz.insert(reviewHelpfulVote).values({ reviewId: id, principal: who }).onConflictDoNothing().run();
      if (affected(ins) > 0) await dz.update(review).set({ helpfulCount: sql`${review.helpfulCount} + 1` }).where(eq(review.id, id)).run();
      voted = true;
    } else {
      // Symmetrically gate the −1 on the DELETE removing a row, so a double un-vote decrements at most once.
      const del = await dz.delete(reviewHelpfulVote).where(and(eq(reviewHelpfulVote.reviewId, id), eq(reviewHelpfulVote.principal, who))).run();
      if (affected(del) > 0) await dz.update(review).set({ helpfulCount: sql`MAX(0, ${review.helpfulCount} - 1)` }).where(eq(review.id, id)).run();
      voted = false;
    }
    const r = await dz.select().from(review).where(eq(review.id, id)).get();
    return r ? c.json({ ...r, voted }) : c.json({ error: "not found" }, 404);
  };

  // Submit a review AND stamp verified-purchase — review.verifiedPurchase was a dead column (never written). A review
  // earns the "✓ Verified" badge iff the signed-in reviewer has a paid/shipped order whose items include this product.
  const submitReview = async (c: Context) => {
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in to leave a review." }, 401);
    const dz = dbFor(c);
    const b = (await c.req.json().catch(() => ({}))) as { productId?: number; rating?: number; title?: string; body?: string };
    const productId = Number(b.productId);
    const rating = Math.max(1, Math.min(5, Math.floor(Number(b.rating) || 0)));
    if (!productId || !rating) return c.json({ error: "A product and a 1–5 rating are required." }, 422);
    const myOrders = (await dz.select().from(order).where(and(eq(order.customerId, who), or(eq(order.status, "paid"), eq(order.status, "shipped")))).all()) as { items?: string }[];
    const verified = myOrders.some((o) => { try { return (JSON.parse(o.items || "[]") as { productId?: number }[]).some((it) => Number(it.productId) === productId); } catch { return false; } });
    const title = String(b.title ?? "").replace(/[<> -]/g, "").trim().slice(0, 160) || "Review";
    const reviewBody = String(b.body ?? "").replace(/[ --]/g, "").trim().slice(0, 5000);
    const row = await dz.insert(review).values({ productId, customerId: who, rating, title, body: reviewBody, verifiedPurchase: verified, status: "pending", createdAt: Date.now() }).returning();
    return c.json({ ...row[0], verified }, 201);
  };

  // Admin fulfillment — advance an order pending/paid → shipped → cancelled, record carrier + tracking, and EMAIL the
  // buyer on shipped/cancelled via @suluk/email's orderStatusEmail (the order-status template that previously never
  // sent). The status enum is bounded; tracking is sanitized; a known carrier yields a real tracking deep-link.
  const setOrderStatus = async (c: Context) => {
    if (!c.get("isAdmin")) return c.json({ error: "Admin only." }, 403);
    const dz = dbFor(c);
    const id = Number(c.req.param("id"));
    const b = (await c.req.json().catch(() => ({}))) as { status?: string; carrier?: string; trackingNumber?: string };
    const status = String(b.status ?? "");
    // ONLY fulfillment transitions — pending→paid stays exclusive to markOrderPaid (inventory + discount + receipt).
    if (!["shipped", "cancelled"].includes(status)) return c.json({ error: "status must be shipped or cancelled." }, 422);
    const o = await dz.select().from(order).where(eq(order.id, id)).get();
    if (!o) return c.json({ error: "not found" }, 404);
    if (o.status === status) return c.json(o); // idempotent no-op — never re-email the buyer on a replayed call (email-bomb guard)
    // legal transitions: ship only a paid order; cancel only a still-open (pending/paid) order.
    if (status === "shipped" && o.status !== "paid") return c.json({ error: "Only a paid order can be shipped." }, 409);
    if (status === "cancelled" && !["pending", "paid"].includes(o.status)) return c.json({ error: `A ${o.status} order can't be cancelled.` }, 409);
    const clean = (x: unknown, n: number) => { const s = String(x ?? "").replace(/[<> -]/g, "").trim().slice(0, n); return s || null; };
    const carrier = clean(b.carrier, 60), trackingNumber = clean(b.trackingNumber, 80);
    const isRefund = status === "cancelled" && o.status === "paid"; // cancelling a PAID order reverses the money
    const needsRefund = isRefund && !!o.stripePaymentIntentId; // a free/$0 paid order has no charge to reverse
    const key = needsRefund ? secret(c, "STRIPE_SECRET_KEY") : undefined;
    // FAIL CLOSED: never cancel + restock + email "refunded" while the buyer is still charged. No key ⇒ can't refund ⇒ abort.
    if (needsRefund && !key) return c.json({ error: "Stripe is not configured — cannot refund; the order was NOT cancelled." }, 503);
    // CONDITIONAL flip FIRST (compare-and-swap on the pre-read status) — the once-only gate. Claiming the transition
    // atomically BEFORE the irreversible refund means a concurrent ship/cancel can't slip in: only the winner refunds.
    const res = (await dz.update(order).set({ status: status as never, ...(status === "shipped" ? { carrier, trackingNumber } : {}) }).where(and(eq(order.id, id), eq(order.status, o.status))).run()) as { meta?: { changes?: number }; changes?: number; rowsAffected?: number };
    if (!(Number(res?.meta?.changes ?? res?.changes ?? res?.rowsAffected ?? 0) > 0)) return c.json(await dz.select().from(order).where(eq(order.id, id)).get()); // lost the race — no refund, no restock, no email
    // the winner of paid→cancelled reverses the money (idempotent). If the refund FAILS, ROLL BACK the flip so the order
    // is never left cancelled-while-still-charged, and abort 502 so the owner retries.
    if (needsRefund && key && !(await stripeRefund(key, o.stripePaymentIntentId!, `refund_${id}`))) {
      await dz.update(order).set({ status: "paid" as never }).where(and(eq(order.id, id), eq(order.status, "cancelled"))).run();
      return c.json({ error: "Stripe refund failed — the order was NOT cancelled. Refund it in the Stripe dashboard, then retry." }, 502);
    }
    // restock + return the discount use (this racer won the flip exactly once; the money is now reversed).
    if (isRefund) await restockOrderLines(dz, o);
    if ((status === "shipped" || status === "cancelled") && o.customerEmail) {
      const origin = new URL(c.req.url).origin;
      const emailStatus = isRefund ? "refunded" : status; // a refunded buyer should be told their money is coming back, not just "cancelled"
      const trackUrl = status === "shipped" ? (carrierTrackingUrl(carrier, trackingNumber) ?? `${origin}/dashboard/s/orders`) : undefined;
      const m = orderStatusEmail({ orderNumber: String(id), status: emailStatus, ...(trackUrl ? { trackingUrl: trackUrl } : {}) }, { brand: { brandName: "saasuluk", baseUrl: origin, accentFrom: "#ef8e5f", accentTo: "#f5a97f" } });
      sendEmailAsync({ to: o.customerEmail, subject: m.subject, html: m.html }, { apiKey: secret(c, "RESEND_API_KEY"), from: secret(c, "EMAIL_FROM") });
    }
    const row = await dz.select().from(order).where(eq(order.id, id)).get();
    return c.json(row);
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
    return c.json({ related: publicProducts((related as Record<string, unknown>[]).filter((r) => r.id !== productId).slice(0, 8)) });
  };

  const subscribeNewsletter = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return c.json({ error: "a valid email is required" }, 422);
    const existing = await dz.select().from(newsletterSubscriber).where(eq(newsletterSubscriber.email, email)).get();
    if (existing) return c.json({ subscribed: true, already: true });
    await dz.insert(newsletterSubscriber).values({ email, subscribedAt: Date.now() }).run();
    resendAudienceSync(c, email, false); // mirror into the Resend audience (where broadcasts are sent)
    const unsubUrl = `${new URL(c.req.url).origin}/newsletter/unsubscribe?t=${unsubToken(email)}`;
    sendEmailAsync({ to: email, subject: "Welcome to saasuluk", html: brandedEmail("You're subscribed 🎉", `<p>Thanks for joining the saasuluk newsletter. You'll hear from us when there's something worth your time.</p><p style="font-size:12px;color:#8a8a8a;margin-top:24px">Not interested? <a href="${unsubUrl}" style="color:#8a8a8a">Unsubscribe</a> any time.</p>`) }, { apiKey: secret(c, "RESEND_API_KEY"), from: secret(c, "EMAIL_FROM") });
    return c.json({ subscribed: true, already: false }, 201);
  };

  // Contact form: persist the submission AND notify the store owner. A bespoke op (not the generic CRUD create) because
  // the email side-effect belongs in operations.ts — the one seam that reaches BOTH dev + worker via mountOperations.
  const submitContact = async (c: Context) => {
    const dz = dbFor(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; email?: string; subject?: string; message?: string };
    const name = String(body.name ?? "").trim(), email = String(body.email ?? "").trim().toLowerCase();
    const subject = String(body.subject ?? "").trim(), message = String(body.message ?? "").trim();
    // Custom ops bypass the CRUD zValidator, so bound the input HERE — restoring the line()/email() limits the generic
    // ContactSubmission route enforced before the form moved to this op (length caps + email shape + no <>/control chars).
    const badLine = (s: string) => /[<> -]/.test(s);
    if (!name || name.length > 120 || badLine(name)) return c.json({ error: "name is required (max 120 chars)" }, 422);
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "a valid email is required" }, 422);
    if (!subject || subject.length > 200 || badLine(subject)) return c.json({ error: "subject is required (max 200 chars)" }, 422);
    if (!message || message.length > 5000) return c.json({ error: "message is required (max 5000 chars)" }, 422);
    const row = await dz.insert(contactSubmission).values({ name, email, subject, message, createdAt: Date.now() }).returning(); // persist FIRST — survives a mail outage
    // BEST-EFFORT owner notification — to the first SUPERADMIN_EMAILS entry, else EMAIL_FROM. esc() the user fields
    // (they land in the owner's inbox as HTML). sendEmailAsync is itself fire-and-forget; the try guards arg-building.
    try {
      const to = superadminEmails(secret(c, "SUPERADMIN_EMAILS"))[0] ?? secret(c, "EMAIL_FROM");
      if (to) sendEmailAsync({ to, subject: `New contact: ${subject}`.slice(0, 180), html: brandedEmail("New contact submission", `<p><b>${escHtml(name)}</b> &lt;${escHtml(email)}&gt; wrote:</p><p><b>${escHtml(subject)}</b></p><p style="white-space:pre-wrap">${escHtml(message)}</p>`) }, { apiKey: secret(c, "RESEND_API_KEY"), from: secret(c, "EMAIL_FROM") });
    } catch { /* notification is best-effort; the submission already persisted */ }
    return c.json(row[0] ?? { ok: true }, 201);
  };

  // Back-in-stock subscribe: a shopper on a SOLD-OUT product asks to be emailed when it's restocked. Public + idempotent
  // (one open waitlist row per email+product). The notification fires from the product CRUD afterUpdate hook on restock.
  const subscribeStock = async (c: Context) => {
    const dz = dbFor(c);
    const productId = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!productId) return c.json({ error: "unknown product" }, 422);
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "a valid email is required" }, 422);
    const p = await dz.select().from(product).where(eq(product.id, productId)).get();
    if (!p) return c.json({ error: "unknown product" }, 404);
    const existing = await dz.select().from(stockNotification).where(and(eq(stockNotification.productId, productId), eq(stockNotification.email, email), isNull(stockNotification.notifiedAt))).get();
    if (!existing) await dz.insert(stockNotification).values({ productId, email, createdAt: Date.now() }).run();
    return c.json({ subscribed: true }, 201);
  };

  // One-click unsubscribe — the token obscures the email (base64url) so it isn't a bare address in the URL. Public; a
  // failed/forged token just 400s. (For high-security lists, sign the token with a secret; this is the starter default.)
  const unsubscribeNewsletter = async (c: Context) => {
    let email = "";
    try { email = atob((c.req.query("t") ?? "").replace(/-/g, "+").replace(/_/g, "/")).trim().toLowerCase(); } catch { email = ""; }
    if (!email || !email.includes("@")) return c.html("<!doctype html><meta charset=utf-8><title>Invalid link</title><body style=\"font-family:system-ui;max-width:520px;margin:80px auto;text-align:center\"><h1>Invalid unsubscribe link</h1><p><a href=\"/\">Back to saasuluk</a></p></body>", 400);
    await dbFor(c).delete(newsletterSubscriber).where(eq(newsletterSubscriber.email, email)).run();
    resendAudienceSync(c, email, true); // flag unsubscribed:true in the Resend audience (broadcasts will skip them)
    const safe = email.replace(/[<>&"]/g, "");
    return c.html(`<!doctype html><meta charset=utf-8><title>Unsubscribed</title><body style="font-family:system-ui;max-width:520px;margin:80px auto;padding:0 20px;text-align:center"><h1>You're unsubscribed</h1><p style="color:#666"><b>${safe}</b> won't receive the saasuluk newsletter anymore. Changed your mind? Re-subscribe from the footer on <a href="/">saasuluk</a>.</p></body>`);
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
    const body = (await c.req.json().catch(() => ({}))) as { items?: LineItem[]; discountCode?: string; email?: string; shippingAddress?: ShipTo; shippingMethod?: string };
    const dz = dbFor(c);
    const who = principal(c);
    // SERVER-AUTHORITATIVE, variant-aware re-pricing (the same path the free checkout uses) — client priceCents ignored.
    const lines = await repriceLines(dz, Array.isArray(body.items) ? body.items : []);
    if (!lines.length) return c.json({ error: "No purchasable items in the cart." }, 422);
    const stock = stockError(lines); if (stock) return c.json({ error: stock }, 409); // never oversell
    const subtotal = linesSubtotal(lines);
    const disc = body.discountCode ? await resolveDiscount(dz, body.discountCode, { subtotalCents: subtotal, principal: who, productIds: lines.map((l) => l.productId) }) : { valid: false } as ResolvedDiscount;
    // FULL total via the pluggable shipping + tax adapters: subtotal − discount + shipping + tax (what Stripe charges).
    const totals = await computeOrderTotals(lines, disc, { address: body.shippingAddress, shippingMethod: body.shippingMethod });
    const total = totals.totalCents;
    const codeUsed = disc.valid ? body.discountCode!.toUpperCase().trim() : null;
    const itemsJson = orderItemsJson(lines);
    const email = buyerEmail(c) ?? cleanEmail(body.email);
    // IDEMPOTENCY: a retry/double-submit of a FREE order must reuse the existing paid order, not mint a second one.
    if (!requiresStripe(total)) {
      const dupId = await recentPaidDuplicate(dz, { who, email, itemsJson, total });
      if (dupId != null) { const o = await dz.select().from(order).where(eq(order.id, dupId)).get(); return c.json({ free: true, paid: true, order: publicOrderShape(o), orderId: dupId, totalCents: total, duplicate: true }); }
    }
    // the order records the SERVER prices + the SERVER total (authoritative — matches what Stripe charges).
    const created = await dz.insert(order).values({ customerId: who, customerEmail: email, items: itemsJson, totalCents: total, status: "pending", discountCode: codeUsed, shippingAddress: cleanAddress(body.shippingAddress), shippingCents: totals.shippingCents, taxCents: totals.taxCents, shippingMethod: totals.shippingMethod, createdAt: Date.now() }).returning();
    const orderId = created[0].id;
    // FREE ORDER: a $0 product or a 100%-off code drops the total below Stripe's $0.50 floor → complete it NOW (mark
    // paid, increment usage once via markOrderPaid) and skip Stripe entirely. This is the unified $0 outcome.
    if (!requiresStripe(total)) {
      if (await markOrderPaid(c, dz, orderId)) await sendOrderReceipt(c, dz, orderId);
      const o = await dz.select().from(order).where(eq(order.id, orderId)).get();
      return c.json({ free: true, paid: true, order: publicOrderShape(o), orderId, totalCents: total });
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
    form.set("payment_intent_data[metadata][orderId]", String(orderId)); // so the charge carries orderId → charge.refunded maps back
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
      // append shipping + tax as their own line items so the catalog charge ALSO collects them (total stays authoritative).
      let extra = lines.length;
      const addLine = (cents: number, name: string) => { if (cents <= 0) return; form.set(`line_items[${extra}][quantity]`, "1"); form.set(`line_items[${extra}][price_data][currency]`, "usd"); form.set(`line_items[${extra}][price_data][unit_amount]`, String(cents)); form.set(`line_items[${extra}][price_data][product_data][name]`, name); extra++; };
      addLine(totals.shippingCents, "Shipping");
      addLine(totals.taxCents, "Sales tax");
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
    // CAPABILITY CHECK: the order body is returned ONLY when Stripe validates this session as paid-for-THIS-order.
    // The session id is the secret (Stripe hands it to the buyer at redirect), so this gates the receipt to the buyer
    // alone — a bogus/guessed session against a sequential orderId yields {paid:false} and NO order (no email/address leak).
    if (!paid) return c.json({ paid: false });
    if (await markOrderPaid(c, dz, orderId)) await sendOrderReceipt(c, dz, orderId); // pending-only transition + once-per-order discount bump + receipt (all idempotent)
    const row = await dz.select().from(order).where(eq(order.id, orderId)).get();
    return c.json({ paid: true, order: publicOrderShape(row) });
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

  // GDPR data export (the privacy policy promises it): the signed-in user downloads ALL their own rows as JSON —
  // orders, wishlist, reviews, and API-token METADATA (never the hashed secret). Owner-scoped; no other tenant's data.
  const exportAccount = async (c: Context) => {
    const who = principal(c);
    if (!who) return c.json({ error: "Sign in to export your data." }, 401);
    const dz = dbFor(c);
    const [orders, wishlist, reviews, tokens] = await Promise.all([
      dz.select().from(order).where(eq(order.customerId, who)).all(),
      dz.select().from(wishlistItem).where(eq(wishlistItem.customerId, who)).all(),
      dz.select().from(review).where(eq(review.customerId, who)).all(),
      dz.select().from(apiToken).where(eq(apiToken.userId, who)).all(),
    ]) as [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]];
    const data = {
      exportedAt: new Date(Date.now()).toISOString(),
      account: { id: who, email: (c.get("sessionEmail") as string | undefined) ?? null },
      orders, wishlist, reviews,
      apiTokens: tokens.map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt })), // metadata only — no hashedKey
    };
    return c.json(data, 200, { "content-disposition": `attachment; filename="saasuluk-data-${String(who).replace(/[^a-zA-Z0-9_-]/g, "")}.json"` });
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
  app.post("/review/submit", submitReview);
  app.post("/order/:id/status", setOrderStatus);
  app.get("/analytics/summary", analyticsSummary);
  app.get("/analytics/revenue", analyticsRevenue);
  app.get("/analytics/top-products", analyticsTopProducts);
  app.get("/recommendations/:productId", recommendRelated);
  app.post("/newsletter/subscribe", subscribeNewsletter);
  app.post("/contact/submit", submitContact);
  app.post("/product/:id/notify-stock", subscribeStock);
  app.get("/newsletter/unsubscribe", unsubscribeNewsletter);
  app.get("/avatar", generateAvatar);
  app.post("/tokens/create", createToken);
  app.post("/tokens/:id/revoke", revokeToken);
  app.post("/checkout/pay", payCheckout);
  app.post("/checkout/quote", quoteCheckout);
  app.post("/checkout/confirm", confirmCheckout);
  app.post("/billing/connect", connectBilling);
  app.post("/billing/report", reportUsage);
  app.post("/billing/portal", openBillingPortal);
  app.get("/account/export", exportAccount);
}
