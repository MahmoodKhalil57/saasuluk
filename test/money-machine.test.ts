/**
 * Characterization tests for the order money-state machine — the once-only CAS transitions that had NO direct test
 * (only their inventory side-effects did). These PIN the current behavior so the refactor onto @suluk/drizzle's
 * claimOnce/rowsChanged is provably byte-identical: pending→paid once (no double-decrement), paid→cancelled once
 * (no double-restock), refund-before-paid terminates without restocking, cancelPending only on pending.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sqlite, order, product, discountCode } from "../src/server/db";
import { markOrderPaid, cancelPendingOrder, refundOrder } from "../src/server/operations";

const ctx = { env: {}, req: { url: "https://x.test/" } } as never; // no RESEND/SUPERADMIN → alerts no-op

beforeEach(() => {
  sqlite.exec('DELETE FROM "order"; DELETE FROM product; DELETE FROM discount_code;');
});

function seedPaidScenario() {
  const p = db.insert(product).values({ name: "W", slug: "w", priceCents: 100, inventory: 5, status: "published" }).returning().get();
  db.insert(discountCode).values({ code: "SAVE", discountType: "percent", discountValue: 10, currentUses: 0 }).run();
  const o = db
    .insert(order)
    .values({
      items: JSON.stringify([{ productId: p.id, qty: 2 }]),
      totalCents: 180,
      status: "pending",
      discountCode: "SAVE",
      createdAt: Date.now(),
    })
    .returning()
    .get();
  return { pid: p.id, oid: o.id };
}
const inv = (pid: number) => db.select().from(product).where(eq(product.id, pid)).get()!.inventory;
const status = (oid: number) => db.select().from(order).where(eq(order.id, oid)).get()!.status;
const uses = () => db.select().from(discountCode).where(eq(discountCode.code, "SAVE")).get()!.currentUses;

describe("markOrderPaid — pending→paid exactly once", () => {
  test("first call pays + decrements inventory + bumps discount; re-delivery is a no-op", async () => {
    const { pid, oid } = seedPaidScenario();
    expect(await markOrderPaid(ctx, db, oid)).toBe(true);
    expect(status(oid)).toBe("paid");
    expect(inv(pid)).toBe(3);
    expect(uses()).toBe(1);
    expect(await markOrderPaid(ctx, db, oid)).toBe(false); // webhook re-delivery / double-confirm
    expect(inv(pid)).toBe(3);
    expect(uses()).toBe(1); // NOT decremented/bumped again
  });
});

describe("refundOrder — paid→cancelled exactly once", () => {
  test("refund restocks once; re-delivery doesn't double-restock", async () => {
    const { pid, oid } = seedPaidScenario();
    await markOrderPaid(ctx, db, oid); // inv 3
    expect(await refundOrder(db, oid)).toBe(true);
    expect(status(oid)).toBe("cancelled");
    expect(inv(pid)).toBe(5);
    expect(uses()).toBe(0); // restocked + discount returned
    expect(await refundOrder(db, oid)).toBe(false);
    expect(inv(pid)).toBe(5); // NOT over-restocked
  });

  test("refund arriving BEFORE paid terminates the pending order without restocking", async () => {
    const { pid, oid } = seedPaidScenario(); // still pending, inventory never decremented
    expect(await refundOrder(db, oid)).toBe(false); // nothing was decremented → nothing to restock
    expect(status(oid)).toBe("cancelled");
    expect(inv(pid)).toBe(5); // untouched (not over-inflated)
    expect(await markOrderPaid(ctx, db, oid)).toBe(false); // can't resurrect a cancelled order into a paid sale
    expect(inv(pid)).toBe(5);
  });
});

describe("cancelPendingOrder — only a pending order", () => {
  test("cancels pending once; a paid order is untouched", async () => {
    const { oid } = seedPaidScenario();
    expect(await cancelPendingOrder(db, oid)).toBe(true);
    expect(status(oid)).toBe("cancelled");
    expect(await cancelPendingOrder(db, oid)).toBe(false); // already cancelled
    const { oid: oid2 } = seedPaidScenario();
    await markOrderPaid(ctx, db, oid2);
    expect(await cancelPendingOrder(db, oid2)).toBe(false); // paid, not pending
    expect(status(oid2)).toBe("paid");
  });
});
