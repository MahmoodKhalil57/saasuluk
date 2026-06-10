/**
 * saasuluk on Cloudflare Workers — the Suluk stack, D1-backed. The contract (v4 doc + cost + auth schemes)
 * is built at module load (ajv-free now that @suluk/core is lazy); the request path never validates, so it
 * runs inside the Worker eval restriction. Data is D1 (Drizzle d1 driver). /superadmin (which validates) is
 * served by the Bun-hosted build, not here.
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { tableToV4 } from "@suluk/drizzle";
import { buildApp } from "@suluk/builder";
import { annotateCosts, costMeter, MemoryCostSink, summarize, type CostModel } from "@suluk/cost";
import { authSecuritySchemes, mergeAuth } from "@suluk/better-auth";
import { buildAda, matchRequest } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";

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

type Env = { DB: D1Database };
const app = new Hono<{ Bindings: Env }>();
const sink = new MemoryCostSink(); // per-isolate; fine for a live demo

app.use("*", costMeter({
  sink, costs,
  operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
  principalOf: (c) => c.req.header("x-user") || undefined,
}));

const D = (c: { env: Env }) => drizzle(c.env.DB);
app.get("/project", async (c) => c.json(await D(c).select().from(project).all()));
app.post("/project", async (c) => { const b = (await c.req.json()) as Record<string, unknown>; const r = await D(c).insert(project).values({ ...b, ownerId: c.req.header("x-user") ?? null } as typeof project.$inferInsert).returning(); return c.json(r[0], 201); });
app.get("/project/:id", async (c) => { const r = await D(c).select().from(project).where(eq(project.id, Number(c.req.param("id")))); return r[0] ? c.json(r[0]) : c.json({ error: "not found" }, 404); });
app.patch("/project/:id", async (c) => { const b = (await c.req.json()) as Record<string, unknown>; await D(c).update(project).set(b).where(eq(project.id, Number(c.req.param("id")))); const r = await D(c).select().from(project).where(eq(project.id, Number(c.req.param("id")))); return c.json(r[0]); });
app.delete("/project/:id", async (c) => { await D(c).delete(project).where(eq(project.id, Number(c.req.param("id")))); return c.body(null, 204); });

app.get("/scalar", () => scalarResponse(document));
app.get("/openapi.json", (c) => c.json(document as unknown as Record<string, unknown>));
app.get("/cost", (c) => c.json(summarize(sink.events())));
app.get("/api/health", (c) => c.json({ ok: true, on: "cloudflare-workers", name: "saasuluk" }));
app.get("/", (c) => c.html(`<!doctype html><html><head><meta charset="utf-8"/><title>saasuluk on Cloudflare</title>
<style>body{font:15px ui-monospace,monospace;background:#0b0e14;color:#cdd6f4;max-width:640px;margin:60px auto;padding:0 20px}a{color:#8aadf4}b{color:#f5a97f}</style></head>
<body><h1 style="color:#f5a97f">saasuluk · on Cloudflare</h1>
<p>A SaaS API powered by <b>Suluk</b>, running on a Cloudflare Worker + <b>D1</b>. One typed contract → API, OpenAPI v4, Scalar docs, and per-user cost — all derived.</p>
<ul>
<li><a href="/scalar">/scalar</a> — the API docs (Scalar over the v4 document; shows declared cost + auth)</li>
<li><a href="/openapi.json">/openapi.json</a> — the OpenAPI v4 document</li>
<li><a href="/project">/project</a> — the domain resource (GET list; POST to create, with <code>x-user</code>)</li>
<li><a href="/cost">/cost</a> — the raw cost ledger (per user / operation / action / source)</li>
<li><a href="/api/health">/api/health</a></li>
</ul>
<p style="color:#9399b2">Deployed with the Suluk Cloudflare integration. <a href="https://mahmoodkhalil57.github.io/sig-moonwalk/">Suluk docs →</a></p>
</body></html>`));
export default app;
