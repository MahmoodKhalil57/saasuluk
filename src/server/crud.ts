/**
 * Generic Drizzle CRUD — written ONCE, bound to every entity's contract-generated routes. The dev server
 * (bun:sqlite, synchronous) uses these; the Worker has the async/D1 twin in `worker.ts`.
 *
 * OWNERSHIP: when an entity has an owner column (`ownerCol`, e.g. Order→customerId, BillingAccount→principal,
 * ApiToken→userId), create STAMPS the caller's principal, and list/get/update/delete are SCOPED to it — a caller
 * only ever sees or mutates rows they own. Without that scope the whole domain would be a cross-tenant CRUD
 * (anyone could dump every Stripe customer id or mark any order paid). Public entities (no ownerCol — products,
 * posts, faqs) stay open. The principal is server-derived (token/session, then the x-user fallback).
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "./db";
import { principal } from "./operations";

type AnyRow = Record<string, unknown>;
const numId = (c: Context) => Number(c.req.param("id"));
const pk = (table: SQLiteTable) => (table as unknown as { id: SQLiteColumn }).id;

export interface CrudHandlers {
  list: (c: Context) => Response | Promise<Response>;
  get: (c: Context) => Response | Promise<Response>;
  create: (c: Context) => Response | Promise<Response>;
  update: (c: Context) => Response | Promise<Response>;
  delete: (c: Context) => Response | Promise<Response>;
}

export function crudHandlers(table: SQLiteTable, ownerCol?: string): CrudHandlers {
  const cols = table as unknown as Record<string, SQLiteColumn>;
  const ownerEq = (c: Context) => (ownerCol ? eq(cols[ownerCol], principal(c)) : undefined);
  const byId = (c: Context) => { const o = ownerEq(c); return o ? and(eq(pk(table), numId(c)), o) : eq(pk(table), numId(c)); };
  return {
    list: (c) => { const o = ownerEq(c); return c.json(o ? db.select().from(table).where(o).all() : db.select().from(table).all()); },
    get: (c) => {
      const r = db.select().from(table).where(byId(c)).get();
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
      delete body.id; if (ownerCol) delete body[ownerCol]; // never let the client move a row's id or its owner
      db.update(table).set(body as never).where(byId(c)).run();
      const r = db.select().from(table).where(byId(c)).get();
      return r ? c.json(r) : c.json({ error: "not found" }, 404);
    },
    delete: (c) => {
      db.delete(table).where(byId(c)).run();
      return c.body(null, 204);
    },
  };
}
