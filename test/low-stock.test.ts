/**
 * Low-stock alert latch — the money-path change in markOrderPaid. Asserts the once-only latch:
 * a paid sale that dips inventory to/below the threshold flips low_stock_alerted exactly once, a
 * re-pay is a no-op, and restock re-arms the latch. Runs on the dev bun:sqlite DB (SCHEMA_SQL).
 */
import { test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sqlite, product, order } from "../src/server/db";
import { markOrderPaid, restockOrderLines } from "../src/server/operations";

// A minimal Hono-Context stand-in: secret() reads c.env, principal() isn't used here. SUPERADMIN_EMAILS makes
// owners non-empty so the alert path actually runs; no RESEND key ⇒ sendEmailAsync is a safe no-op.
const ctx = { env: { SUPERADMIN_EMAILS: '["owner@example.com"]', LOW_STOCK_THRESHOLD: "5" }, req: { url: "https://x.test/" } } as never;

beforeEach(() => {
  sqlite.exec('DELETE FROM product; DELETE FROM "order";');
});

async function makePaidDip(startInv: number, qty: number) {
  const p = db
    .insert(product)
    .values({ name: "Widget", slug: "widget", priceCents: 100, inventory: startInv, status: "published" })
    .returning()
    .get();
  const o = db
    .insert(order)
    .values({ items: JSON.stringify([{ productId: p.id, qty }]), totalCents: 100 * qty, status: "pending", createdAt: Date.now() })
    .returning()
    .get();
  const did = await markOrderPaid(ctx, db, o.id);
  return { pid: p.id, oid: o.id, did };
}

test("dipping to/below threshold flips the latch exactly once", async () => {
  const { pid, did } = await makePaidDip(6, 2); // 6 - 2 = 4 ≤ 5
  expect(did).toBe(true);
  const p = db.select().from(product).where(eq(product.id, pid)).get()!;
  expect(p.inventory).toBe(4);
  expect(p.lowStockAlerted).toBe(true);
});

test("staying above threshold does NOT flip the latch", async () => {
  const { pid } = await makePaidDip(20, 2); // 20 - 2 = 18 > 5
  const p = db.select().from(product).where(eq(product.id, pid)).get()!;
  expect(p.inventory).toBe(18);
  expect(p.lowStockAlerted).toBe(false);
});

test("a re-pay is a no-op (latch already set, no double work)", async () => {
  const { pid, oid } = await makePaidDip(6, 2);
  const again = await markOrderPaid(ctx, db, oid); // order already paid
  expect(again).toBe(false);
  const p = db.select().from(product).where(eq(product.id, pid)).get()!;
  expect(p.inventory).toBe(4); // not decremented again
  expect(p.lowStockAlerted).toBe(true);
});

test("restock re-arms the latch so a future dip alerts again", async () => {
  const { pid } = await makePaidDip(6, 2); // latched
  await restockOrderLines(db, { items: JSON.stringify([{ productId: pid, qty: 10 }]) });
  const p = db.select().from(product).where(eq(product.id, pid)).get()!;
  expect(p.inventory).toBe(14);
  expect(p.lowStockAlerted).toBe(false); // re-armed
});
