/**
 * The GDPR erasure cascade for a deleted user — projected from the domain registry's owner columns. When a user is
 * deleted, every row they OWN (orders, carts, reviews, wishlist, projects, API tokens, billing account) is hard-
 * deleted; catalog/content (products, posts, FAQs) is NOT owned, so it's untouched. Shared by the dev (bun:sqlite)
 * and Worker (D1) auth configs over their own Drizzle instance — `.run()` executes on both. Wired via
 * @suluk/better-auth's beforeDeleteCascade orchestrator.
 */
import { eq } from "drizzle-orm";
import { deleteStep, type CascadeStep } from "@suluk/better-auth";
import * as s from "./schema";

type AuthUser = { id: string; email?: string };

interface Deletable {
  delete(table: unknown): { where(cond: unknown): { run(): unknown } };
}

/** Every owned table + its owner column (from domain.ts) — the single source of "what's a user's data". */
const OWNED: [name: string, table: Record<string, unknown>, ownerCol: string][] = [
  ["orders", s.order as unknown as Record<string, unknown>, "customerId"],
  ["carts", s.cart as unknown as Record<string, unknown>, "customerId"],
  ["reviews", s.review as unknown as Record<string, unknown>, "customerId"],
  ["wishlist", s.wishlistItem as unknown as Record<string, unknown>, "customerId"],
  ["projects", s.project as unknown as Record<string, unknown>, "ownerId"],
  ["apiTokens", s.apiToken as unknown as Record<string, unknown>, "userId"],
  ["billingAccount", s.billingAccount as unknown as Record<string, unknown>, "principal"],
];

export function buildErasureSteps(db: Deletable): CascadeStep<AuthUser>[] {
  return OWNED.map(([name, table, col]) =>
    deleteStep<AuthUser>(name, async (user) => {
      await db.delete(table).where(eq(table[col], user.id)).run();
    }),
  );
}
