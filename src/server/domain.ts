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
import type { AccessMode } from "./access";
import { hardenSchema } from "./harden-schema";
import { applyValidations } from "./validations";
import * as s from "./schema";

const read = (m: number): CostModel => ({ components: [{ source: "db-read", basis: "per-call", microUsd: m }], estimateMicroUsd: m });
const write = (m: number): CostModel => ({ components: [{ source: "compute", basis: "per-call", microUsd: 100 }, { source: "db-write", basis: "per-call", microUsd: m }], estimateMicroUsd: 100 + m });

export interface EntityDef {
  /** PascalCase singular — drives the operation names (list/get/create/update/delete + the path). */
  name: string;
  table: SQLiteTable;
  /** the column to stamp with the caller's principal on create (a user-owned resource); omit for public entities. */
  ownerCol?: string;
  /**
   * who may read/write each row (enforced by both CRUD factories — see access.ts). Defaults to `owned` when an
   * ownerCol is present, else `public`. Set EXPLICITLY where the default is unsafe: catalog/content is `public`
   * (world-read, admin-write), discount codes are `admin` (a self-minted 99%-off code is an underpayment vector),
   * orders are `ownedAppend` (you place one but can't flip it to paid), billing is `ownedReadonly`.
   */
  access?: AccessMode;
  /** per-call cost weights (read µUSD, write µUSD); delete is charged at ~60% of a write. */
  r: number;
  w: number;
}

/** The registry. Order is cosmetic (it sorts the docs/admin); the names must be unique + PascalCase. */
export const ENTITIES: EntityDef[] = [
  // ecommerce — catalog is public-read/admin-write; carts/orders/reviews are user data
  { name: "Category", table: s.category, access: "public", r: 8, w: 30 },
  { name: "Product", table: s.product, access: "public", r: 10, w: 45 },
  { name: "Variant", table: s.variant, access: "public", r: 8, w: 30 },
  { name: "DiscountCode", table: s.discountCode, access: "admin", r: 8, w: 30 }, // never world-writable: free money
  { name: "Cart", table: s.cart, ownerCol: "customerId", access: "owned", r: 10, w: 35 },
  { name: "Order", table: s.order, ownerCol: "customerId", access: "ownedAppend", r: 12, w: 60 }, // can't self-mark paid
  { name: "Review", table: s.review, ownerCol: "customerId", access: "review", r: 8, w: 40 }, // public-read, owner-write
  { name: "WishlistItem", table: s.wishlistItem, ownerCol: "customerId", access: "owned", r: 8, w: 25 },
  { name: "Address", table: s.address, ownerCol: "customerId", access: "owned", r: 8, w: 25 }, // the checkout saved-address book — owner-scoped
  // content / marketing — posts/faqs are admin-published; contact/newsletter are public submissions
  { name: "Post", table: s.post, ownerCol: "authorId", access: "public", r: 8, w: 45 },
  { name: "Faq", table: s.faq, access: "public", r: 6, w: 25 },
  { name: "NewsletterSubscriber", table: s.newsletterSubscriber, access: "submit", r: 6, w: 20 },
  { name: "ContactSubmission", table: s.contactSubmission, access: "submit", r: 6, w: 20 },
  { name: "Media", table: s.media, access: "public", r: 6, w: 25 },
  // platform — tokens/projects are owned; billing is owner-read but system-written
  { name: "ApiToken", table: s.apiToken, ownerCol: "userId", access: "owned", r: 8, w: 30 },
  { name: "BillingAccount", table: s.billingAccount, ownerCol: "principal", access: "ownedReadonly", r: 8, w: 30 },
  { name: "Project", table: s.project, ownerCol: "ownerId", access: "owned", r: 12, w: 40 },
];

/** The entity list for `buildApp` (each entity's CREATE/insert shape → CRUD routes + v4 schemas). The Drizzle
 *  projection gives bare types; we layer REASONABLE per-field validations (validations.ts) — slugs, emails, rating
 *  1–5, sane caps, no `<>` in display fields — then hardenSchema only fills any remaining gap with a floor. These
 *  are enforced at runtime (the API rejects invalid input), so they're real security, not just a grade. */
export const entitySchemas = ENTITIES.map((e) => ({ name: e.name, schema: hardenSchema(applyValidations(e.name, tableToV4(e.table).insert)) }));

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

/** name → { table, ownerCol, access } — how the API binds a generic CRUD handler to each contract-generated route. */
export const tableByEntity: Record<string, { table: SQLiteTable; ownerCol?: string; access?: AccessMode }> = Object.fromEntries(
  ENTITIES.map((e) => [e.name, { table: e.table, ownerCol: e.ownerCol, access: e.access }]),
);

/** every domain table — for `tableComponents` (the component schemas in the standalone openapi.json gen). */
export const allTables = ENTITIES.map((e) => e.table);

/**
 * PROVENANCE (council whuovh6gs, L2): entity name → the authored source it was projected FROM. The symbol is
 * REVERSE-MAPPED from the actual `schema.ts` exports by object identity — not re-derived by a naming convention —
 * so a rename in schema.ts is reflected here (and the staleness test catches a stale pointer). Stamped onto the
 * contract by `annotateSource`; advisory only, never an authz input.
 */
const tableSymbol = new Map<unknown, string>(Object.entries(s).map(([sym, tbl]) => [tbl, sym]));
export const entitySource: Record<string, { file: string; symbol: string; kind: string }> = Object.fromEntries(
  ENTITIES.map((e) => [e.name, { file: "src/server/schema.ts", symbol: tableSymbol.get(e.table) ?? `${e.name[0].toLowerCase()}${e.name.slice(1)}`, kind: "drizzle-table" }]),
);
