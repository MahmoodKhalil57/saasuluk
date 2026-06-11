/**
 * The Hono app — every Suluk surface, from ONE contract. Better Auth at /api/auth/*; the cost meter on every
 * request; the contract-derived domain CRUD (Drizzle-backed); Scalar docs + the raw v4 doc; the /superadmin
 * cockpit (same brain as the vscode extension); the cost ledger; and the Stripe webhook. Same `app` deploys
 * to a Cloudflare Worker (Hono is native there).
 */
import { Hono } from "hono";
import { mount, type RouteContract } from "@suluk/hono";
import { buildAda, matchRequest, scrubSource, sourceIndex, sourceCoverage } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";
import { referenceResponse } from "@suluk/reference";
import { generateSdk } from "@suluk/sdk";
import { generateTests } from "@suluk/testgen";
import { adminApp } from "@suluk/admin";
import { costMeter, MemoryCostSink, summarize } from "@suluk/cost";
import { stripeProvider, type StripeLike } from "@suluk/stripe";
import { auth, ensureAuthTables } from "./auth";
import { buildContract, costs } from "./contract";
import { tableByEntity } from "./domain";
import { crudHandlers, type CrudHandlers } from "./crud";
import { mountOperations, verifyApiToken, principal } from "./operations";
import { isAdmin, superadminEmails } from "./access";
import { configHealth, renderConfigHealth, loadConfig } from "./env";
import { projectDocument, requestedViewer, viewerOf, docHash } from "./project";
import { db } from "./db";

export async function createApp() {
  await ensureAuthTables();
  const { built, document } = await buildContract();
  const sink = new MemoryCostSink();
  const ada = buildAda(document);
  const admins = superadminEmails(process.env.SUPERADMIN_EMAILS); // verified-superadmin allowlist (read at app build)
  const { problem } = loadConfig(process.env as Record<string, string | undefined>); // validate config vs the registry — warn loud, don't crash
  if (problem) console.warn("[saasuluk config]", problem);

  // bind a real Drizzle CRUD handler to EVERY contract-generated route, by entity. One generic factory covers
  // the whole domain — `list/get/create/update/delete<Entity>` → crudHandlers(table) for that entity.
  const handlerCache = new Map<string, CrudHandlers>();
  const routes: RouteContract[] = built.backend.routes.map((r) => {
    const m = /^(list|create|get|update|delete)([A-Z]\w*)$/.exec(r.name ?? "");
    if (!m) return r;
    const [, verb, entity] = m;
    const def = tableByEntity[entity];
    if (!def) return r;
    let h = handlerCache.get(entity);
    if (!h) { h = crudHandlers(def.table, def.ownerCol, def.access); handlerCache.set(entity, h); }
    return { ...r, handler: h[verb as keyof CrudHandlers] as RouteContract["handler"] };
  });

  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));                       // Better Auth
  app.use("*", async (c, next) => {                                                             // identity (verified)
    const h = c.req.header("authorization");
    if (h?.startsWith("Bearer sk_")) { const u = await verifyApiToken(db, h); if (u) c.set("tokenUser", u); }
    else if (c.req.header("cookie")) {
      try {
        const s = await auth.api.getSession({ headers: c.req.raw.headers }) as { user?: { id?: string; email?: string } } | null;
        if (s?.user?.id) { c.set("sessionUser", s.user.id); if (s.user.email && admins.includes(s.user.email.toLowerCase())) c.set("isAdmin", true); } // verified superadmin
      } catch { /* anonymous */ }
    }
    await next();
  });
  app.use("*", costMeter({                                                                      // meter every op
    sink, costs,
    operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
    principalOf: (c) => principal(c) || undefined,                                              // verified token/session, else x-user
  }));
  mount(app, routes);                                                                            // contract-derived CRUD
  mountOperations(app, () => db);                                                                // custom ops (checkout, search, analytics, …)
  const canonHash = docHash(document);
  app.get("/reference", (c) => referenceResponse(isAdmin(c) ? document : scrubSource(document), { pageTitle: "Saasuluk — v4 reference", costLedgerUrl: "/cost", whoamiUrl: "/api/whoami", sdkUrl: "/sdk.ts", conformanceUrl: "/conformance.test.ts" })); // PRIMARY docs: v4 AS v4 + L2 live view + SDK + conformance suite; provenance (↗ src) for the maintainer (admin) only
  app.get("/sdk.ts", (c) => new Response(generateSdk(document, { baseURL: new URL(c.req.url).origin }), { headers: { "content-type": "application/typescript; charset=utf-8", "content-disposition": 'attachment; filename="saasuluk-sdk.ts"' } })); // a complete typed ofetch SDK, generated from the contract
  app.get("/conformance.test.ts", (c) => new Response(generateTests(isAdmin(c) ? document : scrubSource(document), { baseURL: new URL(c.req.url).origin }), { headers: { "content-type": "application/typescript; charset=utf-8", "content-disposition": 'attachment; filename="saasuluk.conformance.test.ts"' } })); // a runnable suite asserting the SERVER ENFORCES the contract (access on the wire, status, schema, cost)
  app.get("/scalar", () => scalarResponse(scrubSource(document)));                                // 3.1 compatibility view (external — no provenance)
  app.get("/api/whoami", (c) => c.json({ viewer: viewerOf(c) }));                                 // the renderer auto-selects this viewer's lens (L2)
  app.get("/openapi.json", (c) => {                                                              // canonical (full, auth-free); ?as=me|anon|user|admin → a provable-subset PROJECTION
    const viewer = requestedViewer(c, c.req.query("as"));
    const doc = viewer ? projectDocument(document, viewer, canonHash) : document;
    return c.json((isAdmin(c) ? doc : scrubSource(doc)) as unknown as Record<string, unknown>);   // scrub x-suluk-source from external views (council: internal-layout disclosure)
  });
  app.get("/source", (c) => isAdmin(c)                                                            // DERIVED provenance reverse index (admin/maintainer only — never stored on the doc)
    ? c.json({ coverage: sourceCoverage(document), index: sourceIndex(document) })
    : c.json({ error: "forbidden" }, 403));
  app.get("/cost", (c) => {                                                                      // raw cost ledger — SCOPED to the caller (a VERIFIED superadmin sees all)
    const who = principal(c);
    const events = isAdmin(c) ? sink.events() : sink.events().filter((e) => e.principal === who);
    const opStats: Record<string, { count: number; totalMicroUsd: number }> = {};                // per-op {count,total} → declared-vs-actual drift in /reference
    for (const e of events) { const o = (opStats[e.operation] ??= { count: 0, totalMicroUsd: 0 }); o.count++; o.totalMicroUsd += e.totalMicroUsd; }
    return c.json({ ...summarize(events), opStats });
  });
  app.route("/", adminApp({ document, title: "Saasuluk", authorize: (c) => isAdmin(c) })); // /superadmin (verified session, not a header)
  app.get("/config", (c) => {                                                                   // config health (@suluk/env) — one registry, projected
    if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
    const h = configHealth(process.env as Record<string, string | undefined>);
    return (c.req.header("accept") ?? "").includes("text/html") ? c.html(renderConfigHealth(h)) : c.json(h);
  });
  app.post("/api/stripe/webhook", async (c) => {                                                 // Stripe billing
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return c.json({ error: "stripe not configured (set STRIPE_SECRET_KEY)" }, 503);
    const Stripe = (await import("stripe")).default;
    const provider = stripeProvider(new Stripe(key) as unknown as StripeLike, { webhookSecret: process.env.STRIPE_WEBHOOK_SECRET });
    try { const evt = provider.verifyWebhook(await c.req.text(), c.req.header("stripe-signature") ?? ""); return c.json({ received: true, type: evt.type }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/health", (c) => c.json({ ok: true, name: "saasuluk" }));
  return { app, sink, document };
}
