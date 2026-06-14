/**
 * Abandoned-cart recovery sweep — emails idle pending orders once, within the 1h..24h window, atomic claim-then-send.
 */
import { test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sqlite, order } from "../src/server/db";
import { sweepAbandonedCartEmails } from "../src/server/operations";

const HOUR = 3_600_000;
const opts = { origin: "https://x.test" }; // no apiKey ⇒ sends no-op, but the claim/stamp + returned count still work

beforeEach(() => { sqlite.exec('DELETE FROM "order";'); });

function mkOrder(ageMs: number, over: Partial<{ status: string; customerEmail: string | null; recoveryEmailedAt: number }> = {}) {
  return db.insert(order).values({
    customerEmail: "buyer@example.com", items: JSON.stringify([{ name: "Widget", qty: 2 }]), totalCents: 200,
    status: "pending", createdAt: Date.now() - ageMs, ...over,
  } as never).returning().get();
}
const stamped = (id: number) => db.select().from(order).where(eq(order.id, id)).get()!.recoveryEmailedAt != null;

test("emails an idle (>=1h, <24h) pending order once and stamps it", async () => {
  const o = mkOrder(2 * HOUR);
  const sent = await sweepAbandonedCartEmails(db as never, opts);
  expect(sent).toBe(1);
  expect(stamped(o.id)).toBe(true);
});

test("re-running does not re-email (notify-once via the stamp)", async () => {
  mkOrder(2 * HOUR);
  await sweepAbandonedCartEmails(db as never, opts);
  const second = await sweepAbandonedCartEmails(db as never, opts);
  expect(second).toBe(0);
});

test("a fresh order (<1h) is not emailed yet", async () => {
  const o = mkOrder(20 * 60_000); // 20 min
  expect(await sweepAbandonedCartEmails(db as never, opts)).toBe(0);
  expect(stamped(o.id)).toBe(false);
});

test("an order past the 24h reap window is left for the reaper, not emailed", async () => {
  const o = mkOrder(25 * HOUR);
  expect(await sweepAbandonedCartEmails(db as never, opts)).toBe(0);
  expect(stamped(o.id)).toBe(false);
});

test("a paid order and an emailless order are skipped", async () => {
  mkOrder(2 * HOUR, { status: "paid" });
  const guest = mkOrder(2 * HOUR, { customerEmail: null });
  expect(await sweepAbandonedCartEmails(db as never, opts)).toBe(0);
  expect(stamped(guest.id)).toBe(false);
});
