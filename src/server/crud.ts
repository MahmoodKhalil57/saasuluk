/**
 * Dev-server CRUD — a thin binding of @suluk/drizzle's driver-agnostic `crudHandlers` factory to the dev runtime:
 * the bun:sqlite `db`, saasuluk's principal/isAdmin/redactRow, and the back-in-stock afterUpdate hook. The Worker
 * binds the SAME factory to D1 (worker.ts d1Crud) — ONE implementation, no twin to keep in sync. Access modes +
 * the gate live in @suluk/hono (via ./access); private-column redaction + the hook stay app-owned data/policy.
 */
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { crudHandlers as crudHandlersFactory, type CrudHandlers } from "@suluk/drizzle";
import { db } from "./db";
import { principal, crudAfterUpdate, CRUD_AFTER_UPDATE_TABLES } from "./operations";
import { isAdmin, redactRow, type AccessMode } from "./access";

export type { CrudHandlers } from "@suluk/drizzle";

export function crudHandlers(table: SQLiteTable, ownerCol?: string, access?: AccessMode): CrudHandlers {
  return crudHandlersFactory(table, {
    ownerCol,
    access,
    db: () => db as never, // dev: the module-global bun:sqlite instance (sync; awaited transparently)
    principal,
    isAdmin,
    redact: redactRow,
    afterUpdate: crudAfterUpdate,
    afterUpdateTables: CRUD_AFTER_UPDATE_TABLES,
  });
}
