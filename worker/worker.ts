/**
 * saasuluk on Cloudflare Workers — the full Suluk stack, D1-backed, from the SAME entity registry the dev
 * server uses (src/server/domain.ts): no re-declared schema, no drift.
 *  - the v4 contract (cost-annotated + auth securitySchemes), built at load (eval-free)
 *  - GENERIC CRUD on D1 (drizzle-orm/d1, async) for EVERY domain entity, mounted from the contract routes
 *  - a DURABLE cost meter: each operation's cost is persisted to a D1 cost_event row, so /cost accumulates
 *    across isolates (per-user / operation / frontend-action / source)
 *  - /scalar + /openapi.json, and the /superadmin cockpit (validateDocument is precompiled → Workers-safe)
 * Static pages (landing/dashboard/pricing) are served by the assets binding; this worker owns everything else.
 */
import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { mount, type RouteContract } from "@suluk/hono";
import { buildApp } from "@suluk/builder";
import { annotateCosts, computeCost, summarize, type CostEvent } from "@suluk/cost";
import { authSecuritySchemes, mergeAuth } from "@suluk/better-auth";
import { buildAda, matchRequest } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";
import { adminApp } from "@suluk/admin";
import { getAuth } from "./auth-d1";
import { entitySchemas, costs as domainCosts, tableByEntity } from "../src/server/domain";
import { OPERATION_PATHS, OPERATION_COSTS, mountOperations, verifyApiToken, principal } from "../src/server/operations";

const costs = { ...domainCosts, ...OPERATION_COSTS };
const built = buildApp({ entities: entitySchemas, info: { title: "Saasuluk API (Cloudflare)", version: "0.1.0" } });
built.backend.document.paths = { ...built.backend.document.paths, ...(OPERATION_PATHS as typeof built.backend.document.paths) };
const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
const document = mergeAuth(annotateCosts(built.backend.document, costs), {}, { securitySchemes });
const ada = buildAda(document);

type Env = { DB: D1Database; BETTER_AUTH_SECRET?: string };
const app = new Hono<{ Bindings: Env; Variables: { tokenUser?: string } }>();

// Better Auth (email/password + bearer + admin) on D1 — guarded so it can never take down the rest.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  try { return await getAuth(c.env).handler(c.req.raw); }
  catch (e) { return c.json({ error: "auth unavailable", detail: String((e as Error)?.message ?? e) }, 503); }
});

// API-token auth — a Bearer sk_… resolves to its owning user (attributed in the cost ledger).
app.use("*", async (c, next) => {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer sk_")) { const u = await verifyApiToken(drizzle(c.env.DB), h); if (u) c.set("tokenUser", u); }
  await next();
});

// durable cost meter — persist each operation's cost to D1 so /cost accumulates across isolates.
app.use("*", async (c, next) => {
  await next();
  const op = matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name;
  if (!op || !costs[op]) return;
  const { breakdown, totalMicroUsd } = computeCost(costs[op], []);
  const principal = (c.get("tokenUser") as string | undefined) ?? c.req.header("x-user") ?? null;
  await c.env.DB.prepare("INSERT INTO cost_event (at, principal, operation, action, total_micro_usd, breakdown) VALUES (?,?,?,?,?,?)")
    .bind(Date.now(), principal, op, c.req.header("x-suluk-action") ?? null, totalMicroUsd, JSON.stringify(breakdown)).run();
});

// generic D1 CRUD (async) — written ONCE, bound to every contract-generated route, the D1 twin of src/server/crud.ts.
function d1Crud(table: SQLiteTable, ownerCol?: string) {
  const pk = (table as unknown as { id: Parameters<typeof eq>[0] }).id;
  const dz = (c: Context<{ Bindings: Env }>) => drizzle(c.env.DB);
  const rid = (c: Context) => Number(c.req.param("id"));
  return {
    list: async (c: Context<{ Bindings: Env }>) => c.json(await dz(c).select().from(table).all()),
    get: async (c: Context<{ Bindings: Env }>) => { const r = await dz(c).select().from(table).where(eq(pk, rid(c))); return r[0] ? c.json(r[0]) : c.json({ error: "not found" }, 404); },
    create: async (c: Context<{ Bindings: Env }>) => { const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>; const owner = ownerCol ? { [ownerCol]: principal(c) } : {}; const r = await dz(c).insert(table).values({ ...b, ...owner } as never).returning(); return c.json(r[0], 201); },
    update: async (c: Context<{ Bindings: Env }>) => { const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>; delete b.id; await dz(c).update(table).set(b as never).where(eq(pk, rid(c))); const r = await dz(c).select().from(table).where(eq(pk, rid(c))); return r[0] ? c.json(r[0]) : c.json({ error: "not found" }, 404); },
    delete: async (c: Context<{ Bindings: Env }>) => { await dz(c).delete(table).where(eq(pk, rid(c))); return c.body(null, 204); },
  };
}

type D1Handlers = ReturnType<typeof d1Crud>;
const handlerCache = new Map<string, D1Handlers>();
const routes: RouteContract[] = built.backend.routes.map((r) => {
  const m = /^(list|create|get|update|delete)([A-Z]\w*)$/.exec(r.name ?? "");
  if (!m) return r;
  const [, verb, entity] = m;
  const def = tableByEntity[entity];
  if (!def) return r;
  let h = handlerCache.get(entity);
  if (!h) { h = d1Crud(def.table, def.ownerCol); handlerCache.set(entity, h); }
  return { ...r, handler: h[verb as keyof D1Handlers] as unknown as RouteContract["handler"] };
});
mount(app, routes);
mountOperations(app, (c) => drizzle((c as Context<{ Bindings: Env }>).env.DB)); // custom ops on D1

app.get("/scalar", () => scalarResponse(document));
app.get("/openapi.json", (c) => c.json(document as unknown as Record<string, unknown>));
app.get("/cost", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT at, principal, operation, action, total_micro_usd, breakdown FROM cost_event ORDER BY at DESC LIMIT 2000").all();
  const events: CostEvent[] = (results as Record<string, unknown>[]).map((r) => ({ at: Number(r.at), principal: (r.principal as string) ?? undefined, operation: r.operation as string, action: (r.action as string) ?? undefined, totalMicroUsd: Number(r.total_micro_usd), breakdown: JSON.parse(r.breakdown as string) }));
  return c.json(summarize(events));
});

// the /superadmin cockpit — the same brain as the VSCode extension, now running on a Worker.
app.route("/", adminApp({ document, title: "Saasuluk (Cloudflare)", authorize: (c) => c.req.header("x-role") === "superadmin" }));
app.get("/api/health", (c) => c.json({ ok: true, on: "cloudflare-workers", name: "saasuluk" }));

// unmatched: a browser navigation gets the premium static 404 page; an API client gets JSON.
app.notFound(async (c) => {
  if (c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html")) {
    const res = await (c.env as Env & { ASSETS: { fetch: (req: Request) => Promise<Response> } }).ASSETS.fetch(new Request(new URL("/404.html", c.req.url)));
    return new Response(res.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return c.json({ error: "not found" }, 404);
});
export default app;
