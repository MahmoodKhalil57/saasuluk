/**
 * Generic Drizzle CRUD — written ONCE, bound to every entity's contract-generated routes. The dev server
 * (bun:sqlite, synchronous) uses these; the Worker has the async/D1 twin in `worker.ts`. A handler stamps the
 * owner column (e.g. `customerId`) from the caller's `x-user` header on create, so a user-owned row is attributed
 * without the client having to send it. This is the one place CRUD logic lives — projecting it across the whole
 * domain is what `tableByEntity` in `domain.ts` drives.
 */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "./db";
import { principal } from "./operations";

type AnyRow = Record<string, unknown>;
const numId = (c: Context) => Number(c.req.param("id"));
// the primary key column (every domain table is keyed by `id`)
const pk = (table: SQLiteTable) => (table as unknown as { id: Parameters<typeof eq>[0] }).id;

export interface CrudHandlers {
  list: (c: Context) => Response | Promise<Response>;
  get: (c: Context) => Response | Promise<Response>;
  create: (c: Context) => Response | Promise<Response>;
  update: (c: Context) => Response | Promise<Response>;
  delete: (c: Context) => Response | Promise<Response>;
}

/** Build the 5 CRUD handlers for one table (bun:sqlite / synchronous). `ownerCol` is stamped from `x-user`. */
export function crudHandlers(table: SQLiteTable, ownerCol?: string): CrudHandlers {
  const t = table as unknown as AnyRow;
  return {
    list: (c) => c.json(db.select().from(table).all()),
    get: (c) => {
      const r = db.select().from(table).where(eq(pk(table), numId(c))).get();
      return r ? c.json(r) : c.json({ error: "not found" }, 404);
    },
    create: async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as AnyRow;
      const owner = ownerCol ? { [ownerCol]: principal(c) } : {};
      const r = db.insert(table).values({ ...body, ...owner } as never).returning().get();
      return c.json(r, 201);
    },
    update: async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as AnyRow;
      // never let the client move a row's id; owner stays as-is (only create stamps it)
      delete body.id;
      db.update(table).set(body as never).where(eq(pk(table), numId(c))).run();
      const r = db.select().from(table).where(eq(pk(table), numId(c))).get();
      return r ? c.json(r) : c.json({ error: "not found" }, 404);
    },
    delete: (c) => {
      db.delete(table).where(eq(pk(table), numId(c))).run();
      return c.body(null, 204);
    },
  };
  void t;
}
