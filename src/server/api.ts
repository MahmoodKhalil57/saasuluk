/**
 * The Hono app — every Suluk surface, from ONE contract. Better Auth at /api/auth/*; the cost meter on every
 * request; the contract-derived domain CRUD (Drizzle-backed); Scalar docs + the raw v4 doc; the /superadmin
 * cockpit (same brain as the vscode extension); the cost ledger; and the Stripe webhook. Same `app` deploys
 * to a Cloudflare Worker (Hono is native there).
 */
import { Hono } from "hono";
import { mount, enforceAccess, enforceRateLimit, type RouteContract } from "@suluk/hono";

/** Per-operation rate budgets (saastarter-parity: abuse protection on the money + write paths). Undeclared ops fall
 *  to a generous blanket. Keyed by operation name. NOTE: MemoryRateLimitStore is per-process — correct on the dev
 *  server; the Worker needs a Durable Object / KV-backed store for true cross-isolate limiting. */
const RATE_LIMITS: Record<string, { windowMs: number; maxRequests: number; key: "ip" }> = {
  checkout: { windowMs: 60000, maxRequests: 60, key: "ip" },
  payCheckout: { windowMs: 60000, maxRequests: 30, key: "ip" },
  validateDiscount: { windowMs: 60000, maxRequests: 60, key: "ip" },
  createContactSubmission: { windowMs: 60000, maxRequests: 20, key: "ip" },
  createReview: { windowMs: 60000, maxRequests: 20, key: "ip" },
};
import { buildAda, matchRequest, scrubSource, sourceIndex, sourceCoverage } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";
import { swaggerResponse } from "@suluk/swagger";
import { ogImageSvg, DEPLOYMENT_HEADER } from "@suluk/seo";
import { BUILD_ID } from "../build-id";
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
import { renderCockpitPage } from "./cockpit-view";
import { themeHeadHtml } from "../themes/head";
import { accessIndex } from "./access-facet";
import { configHealth, renderConfigHealth, loadConfig } from "./env";
import { projectDocument, requestedViewer, viewerOf, docHash } from "./project";
import { db } from "./db";

export async function createApp() {
  await ensureAuthTables();
  const { built, document } = await buildContract();
  const sink = new MemoryCostSink();
  const ada = buildAda(document);
  const access = accessIndex(document); // op → x-suluk-access, for the wire enforcer
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
  app.use("*", enforceAccess({                                                                  // WIRE-enforce x-suluk-access (C022 inv.3) — makes the facet load-bearing on custom ops too
    operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
    accessOf: (op) => access[op],
    principal: (c) => principal(c),
    isAdmin: (c) => isAdmin(c),
  }));
  app.use("*", enforceRateLimit({                                                               // 429 + Retry-After (RFC-9457) on the declared money/write ops + a blanket default
    operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
    rateLimitOf: (op) => RATE_LIMITS[op],
    defaultFacet: { windowMs: 60000, maxRequests: 300, key: "ip" },                              // generous blanket so every op has basic protection
  }));
  app.use("*", costMeter({                                                                      // meter every op (after the gate — don't meter a rejected request)
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
  app.get("/swagger", () => swaggerResponse(scrubSource(document)));                              // Swagger UI — a second contract-rendered docs lens (@suluk/swagger)
  app.get("/cockpit", (c) => isAdmin(c) ? c.html(renderCockpitPage(document)) : c.json({ error: "forbidden" }, 403)); // admin: ship gates + convergence + diagrams (@suluk/cockpit + visual)
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
  app.route("/", adminApp({ document, title: "Saasuluk", authorize: (c) => isAdmin(c), headHtml: themeHeadHtml() })); // /superadmin (verified session, not a header)
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
  app.get("/api/health", (c) => c.json({ ok: true, name: "saasuluk", build: BUILD_ID }, 200, { [DEPLOYMENT_HEADER]: BUILD_ID }));
  app.get("/og.svg", (c) => c.body(ogImageSvg({ title: c.req.query("title") || "saasuluk", subtitle: c.req.query("subtitle") || undefined, brand: "saasuluk", eyebrow: "saasuluk" }), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" }));
  return { app, sink, document };
}
