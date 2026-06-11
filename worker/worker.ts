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
import { and, eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { mount, type RouteContract } from "@suluk/hono";
import { buildApp } from "@suluk/builder";
import { annotateCosts, computeCost, summarize, type CostEvent } from "@suluk/cost";
import { authSecuritySchemes, mergeAuth } from "@suluk/better-auth";
import { buildAda, matchRequest, scrubSource, sourceIndex, sourceCoverage } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";
import { referenceResponse } from "@suluk/reference";
import { generateSdk } from "@suluk/sdk";
import { adminApp } from "@suluk/admin";
import { getAuth } from "./auth-d1";
import { entitySchemas, costs as domainCosts, tableByEntity } from "../src/server/domain";
import { OPERATION_PATHS, OPERATION_COSTS, mountOperations, verifyApiToken, principal, sweepBillingUsage, markOrderPaid } from "../src/server/operations";
import { policyFor, gate, isAdmin, superadminEmails, type AccessMode } from "../src/server/access";
import { configHealth, renderConfigHealth, loadConfig, METER_EVENT_DEFAULT } from "../src/server/env";
import { annotateAccess } from "../src/server/access-facet";
import { annotateSource } from "../src/server/source-facet";
import { hardenDocument } from "../src/server/harden-schema";
import { projectDocument, requestedViewer, viewerOf, docHash } from "../src/server/project";

const costs = { ...domainCosts, ...OPERATION_COSTS };
const built = buildApp({ entities: entitySchemas, info: { title: "Saasuluk API (Cloudflare)", version: "0.1.0" } });
built.backend.document.paths = { ...built.backend.document.paths, ...(OPERATION_PATHS as typeof built.backend.document.paths) };
const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
const document = hardenDocument(annotateSource(annotateAccess(mergeAuth(annotateCosts(built.backend.document, costs), {}, { securitySchemes })))); // cost + access + source (provenance) facets + baseline hardening
const CANON_HASH = docHash(document); // canonical hash — the L2 projection's integrity pointer (council wcavrm7zk)
const ada = buildAda(document);

type Env = { DB: D1Database; BETTER_AUTH_SECRET?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; RESEND_API_KEY?: string; STRIPE_METER_EVENT_NAME?: string; STRIPE_METERED_PRICE_ID?: string; SUPERADMIN_EMAILS?: string };
const app = new Hono<{ Bindings: Env; Variables: { tokenUser?: string; sessionUser?: string; isAdmin?: boolean } }>();

// Better Auth (email/password + bearer + admin) on D1 — guarded so it can never take down the rest.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  try { return await getAuth(c.env).handler(c.req.raw); }
  catch (e) { return c.json({ error: "auth unavailable", detail: String((e as Error)?.message ?? e) }, 503); }
});

// Identity — resolve a VERIFIED principal server-side: a Bearer sk_… API token, else a Better Auth session
// cookie. (principal() falls back to the x-user header only when neither is present — anonymous demo.) When the
// session belongs to a SUPERADMIN_EMAILS address, mark the request admin — the ONLY way to be admin (never a
// spoofable header), which is what gates the catalog/discount write surface, /cost (all), and /superadmin.
let configChecked = false; // once-per-isolate: validate config against the @suluk/env registry, warn (don't crash)
app.use("*", async (c, next) => {
  if (!configChecked) { configChecked = true; const { problem } = loadConfig(c.env as unknown as Record<string, string | undefined>); if (problem) console.warn("[saasuluk config]", problem); }
  const admins = superadminEmails(c.env.SUPERADMIN_EMAILS);
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer sk_")) { const u = await verifyApiToken(drizzle(c.env.DB), h); if (u) c.set("tokenUser", u); }
  else if (c.req.header("cookie")) {
    try {
      const s = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers }) as { user?: { id?: string; email?: string } } | null;
      if (s?.user?.id) { c.set("sessionUser", s.user.id); if (s.user.email && admins.includes(s.user.email.toLowerCase())) c.set("isAdmin", true); }
    } catch { /* anonymous */ }
  }
  await next();
});

// durable cost meter — persist each operation's cost to D1 so /cost accumulates across isolates.
app.use("*", async (c, next) => {
  await next();
  const op = matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name;
  if (!op || !costs[op]) return;
  const { breakdown, totalMicroUsd } = computeCost(costs[op], []);
  const who = principal(c); // verified token/session, else the x-user fallback (one source — operations.ts)
  await c.env.DB.prepare("INSERT INTO cost_event (at, principal, operation, action, total_micro_usd, breakdown) VALUES (?,?,?,?,?,?)")
    .bind(Date.now(), who, op, c.req.header("x-suluk-action") ?? null, totalMicroUsd, JSON.stringify(breakdown)).run();
});

// generic D1 CRUD (async) — the D1 twin of src/server/crud.ts. ACCESS-CONTROLLED: each entity's access mode
// (registry → access.ts) maps to per-op rules — `owner` rules scope to the caller's principal (no cross-tenant
// dump/mutate), `admin` rules hard-deny (403) for non-superadmins (closes catalog/discount/billing writes).
function d1Crud(table: SQLiteTable, ownerCol?: string, access?: AccessMode) {
  const cols = table as unknown as Record<string, SQLiteColumn>;
  const pk = cols.id;
  const policy = policyFor(access, ownerCol);
  const dz = (c: Context<{ Bindings: Env }>) => drizzle(c.env.DB);
  const rid = (c: Context) => Number(c.req.param("id"));
  const forbidden = (c: Context) => c.json({ error: "forbidden" }, 403);
  const scoped = (c: Context, scopeOwner: boolean, withPk: boolean) => {
    const own = scopeOwner && ownerCol ? eq(cols[ownerCol], principal(c)) : undefined;
    const id = withPk ? eq(pk, rid(c)) : undefined;
    return own && id ? and(id, own) : (id ?? own);
  };
  return {
    list: async (c: Context<{ Bindings: Env }>) => {
      const g = gate(c, policy.list, principal(c)); if (!g.ok) return forbidden(c);
      const w = scoped(c, g.scopeOwner, false);
      return c.json(await (w ? dz(c).select().from(table).where(w) : dz(c).select().from(table)).all());
    },
    get: async (c: Context<{ Bindings: Env }>) => {
      const g = gate(c, policy.get, principal(c)); if (!g.ok) return forbidden(c);
      const r = await dz(c).select().from(table).where(scoped(c, g.scopeOwner, true)!); return r[0] ? c.json(r[0]) : c.json({ error: "not found" }, 404);
    },
    create: async (c: Context<{ Bindings: Env }>) => {
      const g = gate(c, policy.create, principal(c)); if (!g.ok) return forbidden(c);
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>; const owner = ownerCol ? { [ownerCol]: principal(c) } : {};
      const r = await dz(c).insert(table).values({ ...b, ...owner } as never).returning(); return c.json(r[0], 201);
    },
    update: async (c: Context<{ Bindings: Env }>) => {
      const g = gate(c, policy.update, principal(c)); if (!g.ok) return forbidden(c);
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>; delete b.id; if (ownerCol) delete b[ownerCol];
      const w = scoped(c, g.scopeOwner, true)!; await dz(c).update(table).set(b as never).where(w); const r = await dz(c).select().from(table).where(w); return r[0] ? c.json(r[0]) : c.json({ error: "not found" }, 404);
    },
    delete: async (c: Context<{ Bindings: Env }>) => {
      const g = gate(c, policy.delete, principal(c)); if (!g.ok) return forbidden(c);
      await dz(c).delete(table).where(scoped(c, g.scopeOwner, true)!); return c.body(null, 204);
    },
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
  if (!h) { h = d1Crud(def.table, def.ownerCol, def.access); handlerCache.set(entity, h); }
  return { ...r, handler: h[verb as keyof D1Handlers] as unknown as RouteContract["handler"] };
});
mount(app, routes);
mountOperations(app, (c) => drizzle((c as Context<{ Bindings: Env }>).env.DB)); // custom ops on D1

app.get("/reference", (c) => referenceResponse(isAdmin(c) ? document : scrubSource(document), { pageTitle: "Saasuluk — v4 reference", costLedgerUrl: "/cost", whoamiUrl: "/api/whoami", sdkUrl: "/sdk.ts" })); // PRIMARY docs + L2 live view + SDK; provenance (↗ src) shown to the maintainer (admin) only
app.get("/sdk.ts", (c) => new Response(generateSdk(document, { baseURL: new URL(c.req.url).origin }), { headers: { "content-type": "application/typescript; charset=utf-8", "content-disposition": 'attachment; filename="saasuluk-sdk.ts"' } })); // a complete typed ofetch SDK from the contract
app.get("/scalar", () => scalarResponse(scrubSource(document)));                                // 3.1 compatibility view (external — no provenance)
app.get("/api/whoami", (c) => c.json({ viewer: viewerOf(c as unknown as Context) }));           // renderer auto-selects this viewer's lens (L2)
app.get("/openapi.json", (c) => {                                                              // canonical (full, auth-free); ?as= → a provable-subset PROJECTION
  const viewer = requestedViewer(c as unknown as Context, c.req.query("as"));
  const doc = viewer ? projectDocument(document, viewer, CANON_HASH) : document;
  return c.json((isAdmin(c) ? doc : scrubSource(doc)) as unknown as Record<string, unknown>);   // scrub x-suluk-source from external views (council: internal-layout disclosure)
});
app.get("/source", (c) => isAdmin(c)                                                            // DERIVED provenance reverse index (admin/maintainer only — never stored on the doc)
  ? c.json({ coverage: sourceCoverage(document), index: sourceIndex(document) })
  : c.json({ error: "forbidden" }, 403));
app.get("/cost", async (c) => {
  // SCOPED to the caller (no cross-tenant ledger dump). A VERIFIED superadmin sees the whole store ledger.
  const who = principal(c);
  const admin = isAdmin(c);
  const stmt = admin
    ? c.env.DB.prepare("SELECT at, principal, operation, action, total_micro_usd, breakdown FROM cost_event ORDER BY at DESC LIMIT 2000")
    : c.env.DB.prepare("SELECT at, principal, operation, action, total_micro_usd, breakdown FROM cost_event WHERE principal = ? ORDER BY at DESC LIMIT 2000").bind(who ?? " ");
  const { results } = await stmt.all();
  const events: CostEvent[] = (results as Record<string, unknown>[]).map((r) => ({ at: Number(r.at), principal: (r.principal as string) ?? undefined, operation: r.operation as string, action: (r.action as string) ?? undefined, totalMicroUsd: Number(r.total_micro_usd), breakdown: JSON.parse(r.breakdown as string) }));
  const opStats: Record<string, { count: number; totalMicroUsd: number }> = {};                  // per-op {count,total} → declared-vs-actual drift in /reference
  for (const e of events) { const o = (opStats[e.operation] ??= { count: 0, totalMicroUsd: 0 }); o.count++; o.totalMicroUsd += e.totalMicroUsd; }
  return c.json({ ...summarize(events), opStats });
});

// the /superadmin cockpit — the same brain as the VSCode extension, now running on a Worker. Gated on a VERIFIED
// superadmin session (SUPERADMIN_EMAILS), not a spoofable header — it surfaces the whole store's cost ledger.
app.route("/", adminApp({ document, title: "Saasuluk (Cloudflare)", authorize: (c) => isAdmin(c as unknown as Context) }));

// config health (@suluk/env) — one declared registry (src/server/env.ts) projected into the admin surface. The
// browser gets the premium HTML panel; an API client gets JSON. Values are NEVER returned — presence only.
app.get("/config", (c) => {
  if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
  const h = configHealth(c.env as unknown as Record<string, string | undefined>);
  return (c.req.header("accept") ?? "").includes("text/html") ? c.html(renderConfigHealth(h)) : c.json(h);
});
app.get("/api/health", (c) => c.json({ ok: true, on: "cloudflare-workers", name: "saasuluk" }));

// Stripe webhook — verifies the signature with Web Crypto (no SDK) and marks the order paid on completion.
// Secondary to the success-page confirm (which retrieves the session directly); add an endpoint in Stripe
// (https://saasuluk.saastemly.com/api/stripe/webhook) and put its signing secret in STRIPE_WEBHOOK_SECRET.
/** constant-time hex compare — no early-out, so it doesn't leak the MAC byte-by-byte via timing. */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyStripe(raw: string, sig: string, secret: string, toleranceSec = 300): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const p of sig.split(",")) { const i = p.indexOf("="); if (i > 0 && !(p.slice(0, i) in parts)) parts[p.slice(0, i)] = p.slice(i + 1); } // split on the FIRST '=' only
  const ts = Number(parts.t);
  if (!parts.t || !parts.v1 || !Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false; // reject stale/replayed events (Stripe's 5-min window)
  const keyData = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", keyData, new TextEncoder().encode(`${ts}.${raw}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeHexEqual(expected, parts.v1);
}
app.post("/api/stripe/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "stripe webhook not configured" }, 503);
  const raw = await c.req.text();
  if (!(await verifyStripe(raw, c.req.header("stripe-signature") ?? "", secret))) return c.json({ error: "bad signature" }, 400);
  const evt = JSON.parse(raw) as { type?: string; data?: { object?: { client_reference_id?: string; metadata?: { orderId?: string } } } };
  if (evt.type === "checkout.session.completed") {
    const oid = Number(evt.data?.object?.client_reference_id ?? evt.data?.object?.metadata?.orderId);
    if (oid) await markOrderPaid(drizzle(c.env.DB), oid); // pending-only + once (a re-delivery is a no-op)
  }
  return c.json({ received: true, type: evt.type });
});

// unmatched: a browser navigation gets the premium static 404 page; an API client gets JSON.
app.notFound(async (c) => {
  if (c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html")) {
    const res = await (c.env as Env & { ASSETS: { fetch: (req: Request) => Promise<Response> } }).ASSETS.fetch(new Request(new URL("/404.html", c.req.url)));
    return new Response(res.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return c.json({ error: "not found" }, 404);
});

// The Worker exports BOTH the fetch handler (the app) AND a scheduled handler (the Cron Trigger that auto-reports
// usage). One cron per the `triggers.crons` schedule in wrangler.jsonc.
export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    if (!env.STRIPE_SECRET_KEY) return;
    ctx.waitUntil(sweepBillingUsage(drizzle(env.DB), env.STRIPE_SECRET_KEY, env.STRIPE_METER_EVENT_NAME ?? METER_EVENT_DEFAULT).catch(() => ({ swept: 0, reported: 0 })));
  },
};
