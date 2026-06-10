/**
 * The ENTITY REGISTRY — the single source of intuitive truth. Every domain entity is declared ONCE here (its
 * table + who owns a row + its per-call cost), and everything else is DERIVED: the v4 contract's entities, the
 * cost map (5 ops each), the name→table binding the API uses to mount generic CRUD, and the component schemas.
 * Add an entity = add a table in `schema.ts` + one line here; the CRUD API, Scalar docs, /superadmin, the typed
 * client, the generated UI, and the cost ledger all light up for it, in BOTH the dev server and the Worker.
 */
import { tableToV4 } from "@suluk/drizzle";
import type { CostModel } from "@suluk/cost";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as s from "./schema";

const read = (m: number): CostModel => ({ components: [{ source: "db-read", basis: "per-call", microUsd: m }], estimateMicroUsd: m });
const write = (m: number): CostModel => ({ components: [{ source: "compute", basis: "per-call", microUsd: 100 }, { source: "db-write", basis: "per-call", microUsd: m }], estimateMicroUsd: 100 + m });

export interface EntityDef {
  /** PascalCase singular — drives the operation names (list/get/create/update/delete + the path). */
  name: string;
  table: SQLiteTable;
  /** the column to stamp with the caller's `x-user` on create (a user-owned resource); omit for public/admin entities. */
  ownerCol?: string;
  /** per-call cost weights (read µUSD, write µUSD); delete is charged at ~60% of a write. */
  r: number;
  w: number;
}

/** The registry. Order is cosmetic (it sorts the docs/admin); the names must be unique + PascalCase. */
export const ENTITIES: EntityDef[] = [
  // ecommerce
  { name: "Category", table: s.category, r: 8, w: 30 },
  { name: "Product", table: s.product, r: 10, w: 45 },
  { name: "Variant", table: s.variant, r: 8, w: 30 },
  { name: "DiscountCode", table: s.discountCode, r: 8, w: 30 },
  { name: "Cart", table: s.cart, ownerCol: "customerId", r: 10, w: 35 },
  { name: "Order", table: s.order, ownerCol: "customerId", r: 12, w: 60 },
  { name: "Review", table: s.review, ownerCol: "customerId", r: 8, w: 40 },
  { name: "WishlistItem", table: s.wishlistItem, ownerCol: "customerId", r: 8, w: 25 },
  // content / marketing
  { name: "Post", table: s.post, ownerCol: "authorId", r: 8, w: 45 },
  { name: "Faq", table: s.faq, r: 6, w: 25 },
  { name: "NewsletterSubscriber", table: s.newsletterSubscriber, r: 6, w: 20 },
  { name: "ContactSubmission", table: s.contactSubmission, r: 6, w: 20 },
  { name: "Media", table: s.media, r: 6, w: 25 },
  // platform
  { name: "ApiToken", table: s.apiToken, ownerCol: "userId", r: 8, w: 30 },
  { name: "Project", table: s.project, ownerCol: "ownerId", r: 12, w: 40 },
];

/** The entity list for `buildApp` (each entity's CREATE/insert shape → CRUD routes + v4 schemas). */
export const entitySchemas = ENTITIES.map((e) => ({ name: e.name, schema: tableToV4(e.table).insert }));

/** The cost map — 5 operations per entity, keyed by operation name (list/get/create/update/delete<Name>). */
export const costs: Record<string, CostModel> = Object.fromEntries(
  ENTITIES.flatMap((e) => [
    [`list${e.name}`, read(e.r)],
    [`get${e.name}`, read(e.r)],
    [`create${e.name}`, write(e.w)],
    [`update${e.name}`, write(e.w)],
    [`delete${e.name}`, write(Math.max(15, Math.round(e.w * 0.6)))],
  ]),
);

/** name → { table, ownerCol } — how the API binds a generic CRUD handler to each contract-generated route. */
export const tableByEntity: Record<string, { table: SQLiteTable; ownerCol?: string }> = Object.fromEntries(
  ENTITIES.map((e) => [e.name, { table: e.table, ownerCol: e.ownerCol }]),
);

/** every domain table — for `tableComponents` (the component schemas in the standalone openapi.json gen). */
export const allTables = ENTITIES.map((e) => e.table);
