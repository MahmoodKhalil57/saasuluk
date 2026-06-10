/**
 * saasuluk on Cloudflare Workers — the full Suluk stack, D1-backed.
 *  - the v4 contract (cost-annotated + auth securitySchemes), built at load (eval-free)
 *  - Project CRUD on D1 (drizzle-orm/d1, async)
 *  - a DURABLE cost meter: each operation's cost is persisted to a D1 cost_event row, so /cost accumulates
 *    across isolates (per-user / operation / frontend-action / source)
 *  - /scalar + /openapi.json, and the /superadmin cockpit (validateDocument is precompiled → Workers-safe)
 * Static pages (landing/dashboard/pricing) are served by the assets binding; this worker owns everything else.
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { tableToV4 } from "@suluk/drizzle";
import { buildApp } from "@suluk/builder";
import { annotateCosts, computeCost, summarize, type CostModel, type CostEvent } from "@suluk/cost";
import { authSecuritySchemes, mergeAuth } from "@suluk/better-auth";
import { buildAda, matchRequest } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";
import { adminApp } from "@suluk/admin";
import { getAuth } from "./auth-d1";

const project = sqliteTable("project", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  ownerId: text("owner_id"),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
});

const read = (m: number): CostModel => ({ components: [{ source: "db-read", basis: "per-call", microUsd: m }], estimateMicroUsd: m });
const write = (m: number): CostModel => ({ components: [{ source: "compute", basis: "per-call", microUsd: 100 }, { source: "db-write", basis: "per-call", microUsd: m }], estimateMicroUsd: 100 + m });
const costs: Record<string, CostModel> = { listProject: read(12), getProject: read(8), createProject: write(40), updateProject: write(40), deleteProject: write(25) };

const built = buildApp({ entities: [{ name: "Project", schema: tableToV4(project).insert }], info: { title: "Saasuluk API (Cloudflare)", version: "0.1.0" } });
const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
const document = mergeAuth(annotateCosts(built.backend.document, costs), {}, { securitySchemes });
const ada = buildAda(document);

type Env = { DB: D1Database; BETTER_AUTH_SECRET?: string };
const app = new Hono<{ Bindings: Env }>();

// Better Auth (email/password + bearer + admin) on D1 — guarded so it can never take down the rest.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  try { return await getAuth(c.env).handler(c.req.raw); }
  catch (e) { return c.json({ error: "auth unavailable", detail: String((e as Error)?.message ?? e) }, 503); }
});

// durable cost meter — persist each operation's cost to D1 so /cost accumulates across isolates.
app.use("*", async (c, next) => {
  await next();
  const op = matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name;
  if (!op) return;
  const { breakdown, totalMicroUsd } = computeCost(costs[op], []);
  await c.env.DB.prepare("INSERT INTO cost_event (at, principal, operation, action, total_micro_usd, breakdown) VALUES (?,?,?,?,?,?)")
    .bind(Date.now(), c.req.header("x-user") ?? null, op, c.req.header("x-suluk-action") ?? null, totalMicroUsd, JSON.stringify(breakdown)).run();
});

const D = (c: { env: Env }) => drizzle(c.env.DB);
app.get("/project", async (c) => c.json(await D(c).select().from(project).all()));
app.post("/project", async (c) => { const b = (await c.req.json()) as Record<string, unknown>; const r = await D(c).insert(project).values({ ...b, ownerId: c.req.header("x-user") ?? null } as typeof project.$inferInsert).returning(); return c.json(r[0], 201); });
app.get("/project/:id", async (c) => { const r = await D(c).select().from(project).where(eq(project.id, Number(c.req.param("id")))); return r[0] ? c.json(r[0]) : c.json({ error: "not found" }, 404); });
app.patch("/project/:id", async (c) => { const b = (await c.req.json()) as Record<string, unknown>; await D(c).update(project).set(b).where(eq(project.id, Number(c.req.param("id")))); const r = await D(c).select().from(project).where(eq(project.id, Number(c.req.param("id")))); return c.json(r[0]); });
app.delete("/project/:id", async (c) => { await D(c).delete(project).where(eq(project.id, Number(c.req.param("id")))); return c.body(null, 204); });

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
export default app;
