/**
 * Generic Drizzle CRUD — written ONCE, bound to every entity's contract-generated routes. The dev server
 * (bun:sqlite, synchronous) uses these; the Worker has the async/D1 twin in `worker.ts`.
 *
 * ACCESS: each entity declares an access MODE in the registry (src/server/domain.ts → access.ts). The mode maps
 * to a per-operation rule that this factory enforces uniformly:
 *  - `owner` rules REQUIRE a verified caller (anon → 401, matching x-suluk-access: authenticated) and SCOPE the
 *    query to that caller's principal (token/session, then the x-user fallback) — they only see/mutate their own rows.
 *  - `admin` rules HARD-DENY (403) unless the caller is a verified superadmin — this is what closes the
 *    world-writable holes (mint a discount code, delete a catalog product, PATCH an order to "paid").
 * Without an explicit access mode the default is owned (if ownerCol) or public — see access.ts.
 */
import { and, eq, asc, desc, getTableName, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { parseListQuery } from "@suluk/drizzle";
import { db } from "./db";
import { principal } from "./operations";
import { policyFor, gate, isAdmin, redactRow, type AccessMode } from "./access";

type AnyRow = Record<string, unknown>;
const numId = (c: Context) => Number(c.req.param("id"));
const pk = (table: SQLiteTable) => (table as unknown as { id: SQLiteColumn }).id;
const denied = (c: Context, g: { status?: 401 | 403 }) => c.json({ error: g.status === 401 ? "unauthorized" : "forbidden" }, g.status ?? 403); // 401 anon vs 403 forbidden

export interface CrudHandlers {
  list: (c: Context) => Response | Promise<Response>;
  get: (c: Context) => Response | Promise<Response>;
  create: (c: Context) => Response | Promise<Response>;
  update: (c: Context) => Response | Promise<Response>;
  delete: (c: Context) => Response | Promise<Response>;
}

export function crudHandlers(table: SQLiteTable, ownerCol?: string, access?: AccessMode): CrudHandlers {
  const cols = table as unknown as Record<string, SQLiteColumn>;
  const policy = policyFor(access, ownerCol);
  const tname = getTableName(table); // for private-column redaction on public reads
  // when a rule scopes to the owner, AND the pk filter (for one row) with `ownerCol = principal`.
  const scoped = (c: Context, scopeOwner: boolean, withPk: boolean) => {
    const own = scopeOwner && ownerCol ? eq(cols[ownerCol], principal(c)) : undefined;
    const id = withPk ? eq(pk(table), numId(c)) : undefined;
    return own && id ? and(id, own) : (id ?? own);
  };
  return {
    list: (c) => {
      const g = gate(c, policy.list, principal(c));
      if (!g.ok) return denied(c, g);
      const own = scoped(c, g.scopeOwner, false);
      // The owner-scope AND any per-column equality filters (parseListQuery only returns REAL columns, validated
      // against the table — unknown keys are dropped, so a filter can never widen past the owner scope).
      const lq = parseListQuery(c.req.query(), table);
      const conds: SQL[] = [];
      if (own) conds.push(own);
      for (const [col, val] of Object.entries(lq.filters)) if (cols[col]) conds.push(eq(cols[col], val));
      const where = conds.length > 1 ? and(...conds) : conds[0];
      let qb = db.select().from(table).$dynamic();
      if (where) qb = qb.where(where);
      if (lq.orderBy && cols[lq.orderBy.column]) qb = qb.orderBy(lq.orderBy.dir === "desc" ? desc(cols[lq.orderBy.column]) : asc(cols[lq.orderBy.column]));
      // Pagination is OPT-IN: bound the page only when the caller passes page/perPage — otherwise the full list,
      // so every consumer that fetches-then-filters-client-side keeps working until it migrates to server params.
      const raw = c.req.query();
      if (raw.page != null || raw.perPage != null) qb = qb.limit(lq.limit).offset(lq.offset);
      const admin = isAdmin(c);
      return c.json(qb.all().map((row) => redactRow(tname, row as AnyRow, admin)));
    },
    get: (c) => {
      const g = gate(c, policy.get, principal(c));
      if (!g.ok) return denied(c, g);
      const r = db.select().from(table).where(scoped(c, g.scopeOwner, true)!).get();
      return r ? c.json(redactRow(tname, r as AnyRow, isAdmin(c))) : c.json({ error: "not found" }, 404);
    },
    create: async (c) => {
      const g = gate(c, policy.create, principal(c));
      if (!g.ok) return denied(c, g);
      const body = (await c.req.json().catch(() => ({}))) as AnyRow;
      const owner = ownerCol ? { [ownerCol]: principal(c) } : {}; // stamp the creator/owner (author for content)
      const r = db.insert(table).values({ ...body, ...owner } as never).returning().get();
      return c.json(r, 201);
    },
    update: async (c) => {
      const g = gate(c, policy.update, principal(c));
      if (!g.ok) return denied(c, g);
      const body = (await c.req.json().catch(() => ({}))) as AnyRow;
      delete body.id; if (ownerCol) delete body[ownerCol]; // never let the client move a row's id or its owner
      const w = scoped(c, g.scopeOwner, true)!;
      db.update(table).set(body as never).where(w).run();
      const r = db.select().from(table).where(w).get();
      return r ? c.json(r) : c.json({ error: "not found" }, 404);
    },
    delete: (c) => {
      const g = gate(c, policy.delete, principal(c));
      if (!g.ok) return denied(c, g);
      db.delete(table).where(scoped(c, g.scopeOwner, true)!).run();
      return c.body(null, 204);
    },
  };
}
