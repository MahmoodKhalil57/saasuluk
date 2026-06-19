/**
 * Back-in-stock waitlist — the CRUD afterUpdate restock trigger. Asserts: a restock crossing 0 → positive stamps
 * every waiting row notified exactly once; staying sold-out or already-stocked does not fire. Runs on dev bun:sqlite.
 */
import { test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sqlite, product, stockNotification } from "../src/server/db";
import { crudAfterUpdate } from "../src/server/operations";

const ctx = { env: {}, req: { url: "https://x.test/" } } as never; // no RESEND key ⇒ sends no-op, but the latch still stamps

beforeEach(() => {
  sqlite.exec("DELETE FROM product; DELETE FROM stock_notification;");
});

function seed(inv: number, waiters: string[]) {
  const p = db
    .insert(product)
    .values({ name: "Widget", slug: "widget", priceCents: 100, inventory: inv, status: "published" })
    .returning()
    .get();
  for (const email of waiters) db.insert(stockNotification).values({ productId: p.id, email, createdAt: Date.now() }).run();
  return p;
}
const pending = (pid: number) =>
  db
    .select()
    .from(stockNotification)
    .where(eq(stockNotification.productId, pid))
    .all()
    .filter((r) => r.notifiedAt == null).length;

test("a restock crossing 0 → positive notifies every waiting row once", async () => {
  const p = seed(0, ["a@x.com", "b@x.com"]);
  expect(pending(p.id)).toBe(2);
  await crudAfterUpdate("product", ctx, db as never, { id: p.id, inventory: 0 }, { id: p.id, inventory: 5 });
  expect(pending(p.id)).toBe(0); // both stamped notified
});

test("re-running the hook does not re-notify (notify-once)", async () => {
  const p = seed(0, ["a@x.com"]);
  await crudAfterUpdate("product", ctx, db as never, { id: p.id, inventory: 0 }, { id: p.id, inventory: 5 });
  // a second restock (e.g. 5 → 8) is NOT a 0→positive crossing, and the rows are already notified anyway
  await crudAfterUpdate("product", ctx, db as never, { id: p.id, inventory: 5 }, { id: p.id, inventory: 8 });
  expect(pending(p.id)).toBe(0);
  expect(db.select().from(stockNotification).where(eq(stockNotification.productId, p.id)).all().length).toBe(1); // no duplicate rows
});

test("an update that does NOT cross from sold-out does not fire", async () => {
  const p = seed(3, ["a@x.com"]); // was already in stock
  await crudAfterUpdate("product", ctx, db as never, { id: p.id, inventory: 3 }, { id: p.id, inventory: 9 });
  expect(pending(p.id)).toBe(1); // still waiting — no crossing
});

test("a variant restock notifies the parent product's waitlist", async () => {
  const p = seed(0, ["a@x.com"]);
  await crudAfterUpdate("variant", ctx, db as never, { id: 99, productId: p.id, inventory: 0 }, { id: 99, productId: p.id, inventory: 4 });
  expect(pending(p.id)).toBe(0);
});
