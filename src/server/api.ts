/**
 * The Hono app — every Suluk surface, from ONE contract. Better Auth at /api/auth/*; the cost meter on every
 * request; the contract-derived domain CRUD (Drizzle-backed); Scalar docs + the raw v4 doc; the /superadmin
 * cockpit (same brain as the vscode extension); the cost ledger; and the Stripe webhook. Same `app` deploys
 * to a Cloudflare Worker (Hono is native there).
 */
import { Hono, type Context } from "hono";

/** The Hono context Variables map for this app's request pipeline — set by the identity middleware (api.ts) and
 *  read by principal()/signedIn()/isAdmin() and the cost meter. Without this, c.set/c.get keys infer as `never`. */
type Vars = {
  tokenUser?: string; // verified API-token user id (verifyApiToken → string)
  sessionUser?: string; // verified Better Auth session user id
  sessionEmail?: string; // verified session email (snapshotted onto checkout)
  isAdmin?: boolean; // verified superadmin flag
};
import { mount, enforceAccess, enforceRateLimit, type RouteContract } from "@suluk/hono";

/** Per-operation rate budgets (saastarter-parity: abuse protection on the money + write paths). Undeclared ops fall
 *  to a generous blanket. Keyed by operation name. NOTE: MemoryRateLimitStore is per-process — correct on the dev
 *  server; the Worker needs a Durable Object / KV-backed store for true cross-isolate limiting. */
import { RATE_LIMITS } from "./ratelimits"; // shared with the Worker so dev/prod budgets never drift
import { buildAda, matchRequest, scrubSource, sourceIndex, sourceCoverage } from "@suluk/core";
import { scalarResponse, scalarV4Response, enrichedSpec, enrichedV4, SCALAR_VERSION } from "@suluk/scalar";
import { SCALAR_FORK_HASH } from "../../worker/gen/scalar-fork";
import { v4ShowcaseDoc } from "./v4-showcase";
import { swaggerResponse } from "@suluk/swagger";
import { ogImageSvg, DEPLOYMENT_HEADER } from "@suluk/seo";
import { BUILD_ID } from "../build-id";
import { referenceInsightsResponse } from "@suluk/reference";
import { generateSdk } from "@suluk/sdk";
import { generateTests } from "@suluk/testgen";
import { adminApp } from "@suluk/admin";
import { panelApp } from "@suluk/panel";
import { mcpApp, appExec } from "@suluk/mcp";
import { chatApp } from "@suluk/chat";
import {
  dashboardSections,
  dashboardGroups,
  dashboardHiddenEntities,
  dashboardHome,
  userStats,
  adminStats,
  adminGroups,
  adminSections,
} from "./dashboard";
import { costMeter, MemoryCostSink, summarize } from "@suluk/cost";
import { verifyStripeSignature } from "@suluk/stripe";
import { auth, ensureAuthTables } from "./auth";
import { buildContract, costs } from "./contract";
import { tableByEntity } from "./domain";
import { crudHandlers, type CrudHandlers } from "./crud";
import { mountOperations, verifyApiToken, principal, type DbFor } from "./operations";
import { isAdmin, superadminEmails } from "./access";
import { renderCockpitPage } from "./cockpit-view";
import { themeHeadHtml, panelChromeHtml } from "../themes/head";
import { accessIndex } from "./access-facet";
import { configHealth, renderConfigHealth, loadConfig } from "./env";
import { projectDocument, requestedViewer, viewerOf, docHash } from "./project";
import { db, sqlite } from "./db";

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
    if (!h) {
      h = crudHandlers(def.table, def.ownerCol, def.access);
      handlerCache.set(entity, h);
    }
    return { ...r, handler: h[verb as keyof CrudHandlers] as RouteContract["handler"] };
  });

  const app = new Hono<{ Variables: Vars }>();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw)); // Better Auth
  app.use("*", async (c, next) => {
    // identity (verified)
    const h = c.req.header("authorization");
    if (h?.startsWith("Bearer sk_")) {
      const u = await verifyApiToken(db, h);
      if (u) c.set("tokenUser", u);
    } else if (c.req.header("cookie")) {
      try {
        const s = (await auth.api.getSession({ headers: c.req.raw.headers })) as { user?: { id?: string; email?: string } } | null;
        if (s?.user?.id) {
          c.set("sessionUser", s.user.id);
          if (s.user.email) {
            c.set("sessionEmail", s.user.email);
            if (admins.includes(s.user.email.toLowerCase())) c.set("isAdmin", true);
          }
        } // verified superadmin; email stashed so checkout can snapshot it onto the order + send a receipt
      } catch {
        /* anonymous */
      }
    }
    await next();
  });
  app.use(
    "*",
    enforceAccess({
      // WIRE-enforce x-suluk-access (C022 inv.3) — makes the facet load-bearing on custom ops too
      operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
      accessOf: (op) => access[op],
      principal: (c) => principal(c),
      isAdmin: (c) => isAdmin(c),
    }),
  );
  app.use(
    "*",
    enforceRateLimit({
      // 429 + Retry-After (RFC-9457) on the declared money/write ops + a blanket default
      operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
      rateLimitOf: (op) => RATE_LIMITS[op],
      defaultFacet: { windowMs: 60000, maxRequests: 300, key: "ip" }, // generous blanket so every op has basic protection
    }),
  );
  app.use(
    "*",
    costMeter({
      // meter every op (after the gate — don't meter a rejected request)
      sink,
      costs,
      operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
      principalOf: (c) => principal(c) || undefined, // verified token/session, else x-user
    }),
  );
  // typing the Hono Variables map (above) makes `app` a `Hono<{Variables: Vars}>`; mount() wants a plain `Hono` —
  // cast to its exact param type for this call (registration is runtime-identical).
  mount(app as unknown as Parameters<typeof mount>[0], routes); // contract-derived CRUD
  // library-type gap: the real bun:sqlite `BunSQLiteDatabase` is wider than @suluk's permissive `Dz` handle (DbFor's
  // return) — same query-builder surface at runtime, so cast the factory to DbFor.
  mountOperations(app, (() => db) as unknown as DbFor); // custom ops (checkout, search, analytics, …)
  const canonHash = docHash(document);
  const SCALAR_SELF = `/vendor/scalar/standalone-${SCALAR_VERSION}.js`; // upstream (vanilla /scalar)
  const SCALAR_FORK = `/vendor/scalar/standalone-suluk.js?v=${SCALAR_FORK_HASH}`; // our fork: latest + suluk v4 patches (/reference); ?v= cache-busts on rebuild
  const refProjected = (c: Context) => {
    const base = isAdmin(c) ? document : scrubSource(document);
    const v = requestedViewer(c, c.req.query("as"));
    return v ? projectDocument(base, v, canonHash) : base;
  };
  // The ONE v4 reference: OUR forked Scalar + superpowers + ⚡ insights drawer. The native @suluk/reference renderer's
  // v4-superpower panels (hardening grade, requests-shape, source provenance) are served standalone at
  // /reference/insights, and the raw v4 spec the SPA renders is at /reference/spec.
  app.get("/reference", (c) =>
    scalarV4Response(isAdmin(c) ? document : scrubSource(document), {
      cdn: SCALAR_FORK,
      pageTitle: "saasuluk — OpenAPI v4 reference",
      brand: "saasuluk",
      specUrl: "/reference/spec",
      views: [
        { label: "Anonymous", value: "anon" },
        { label: "Signed-in", value: "user" },
        { label: "Admin", value: "admin" },
      ],
      insightsUrl: "/reference/insights",
    }),
  );
  app.get("/reference/spec", (c) => c.json(enrichedV4(refProjected(c)).spec));
  app.get("/reference/insights", (c) => referenceInsightsResponse(refProjected(c), { costLedgerUrl: "/cost", whoamiUrl: "/api/whoami" })); // the v4 superpower panels for the drawer
  app.get("/reference/showcase", () =>
    scalarV4Response(v4ShowcaseDoc as never, { cdn: SCALAR_FORK, pageTitle: "OpenAPI v4 — Multi-Request Showcase", brand: "v4 showcase" }),
  ); // demonstrates multi-request-per-method
  app.get(
    "/sdk.ts",
    (c) =>
      new Response(generateSdk(document, { baseURL: new URL(c.req.url).origin }), {
        headers: {
          "content-type": "application/typescript; charset=utf-8",
          "content-disposition": 'attachment; filename="saasuluk-sdk.ts"',
        },
      }),
  ); // a complete typed ofetch SDK, generated from the contract
  app.get(
    "/conformance.test.ts",
    (c) =>
      new Response(generateTests(isAdmin(c) ? document : scrubSource(document), { baseURL: new URL(c.req.url).origin }), {
        headers: {
          "content-type": "application/typescript; charset=utf-8",
          "content-disposition": 'attachment; filename="saasuluk.conformance.test.ts"',
        },
      }),
  ); // a runnable suite asserting the SERVER ENFORCES the contract (access on the wire, status, schema, cost)
  app.get("/scalar", () => scalarResponse(scrubSource(document), { cdn: SCALAR_SELF, facetBadges: false, customCss: "" })); // VANILLA Scalar (plain 4→3 downgrade, no superpowers) — the baseline; the fancy view is /reference
  app.get("/swagger", () => swaggerResponse(scrubSource(document))); // Swagger UI — a second contract-rendered docs lens (@suluk/swagger)
  app.get("/cockpit", (c) => (isAdmin(c) ? c.html(renderCockpitPage(document)) : c.json({ error: "forbidden" }, 403))); // admin: ship gates + convergence + diagrams (@suluk/cockpit + visual)
  app.get("/api/whoami", (c) => c.json({ viewer: viewerOf(c) })); // the renderer auto-selects this viewer's lens (L2)
  app.get("/openapi.json", (c) => {
    // canonical (full, auth-free); ?as=me|anon|user|admin → a provable-subset PROJECTION
    const viewer = requestedViewer(c, c.req.query("as"));
    const doc = viewer ? projectDocument(document, viewer, canonHash) : document;
    return c.json((isAdmin(c) ? doc : scrubSource(doc)) as unknown as Record<string, unknown>); // scrub x-suluk-source from external views (council: internal-layout disclosure)
  });
  app.get("/source", (c) =>
    isAdmin(c) // DERIVED provenance reverse index (admin/maintainer only — never stored on the doc)
      ? c.json({ coverage: sourceCoverage(document), index: sourceIndex(document) })
      : c.json({ error: "forbidden" }, 403),
  );
  app.get("/cost", (c) => {
    // raw cost ledger — SCOPED to the caller (a VERIFIED superadmin sees all)
    const who = principal(c);
    const events = isAdmin(c) ? sink.events() : sink.events().filter((e) => e.principal === who);
    const opStats: Record<string, { count: number; totalMicroUsd: number }> = {}; // per-op {count,total} → declared-vs-actual drift in /reference
    for (const e of events) {
      const o = (opStats[e.operation] ??= { count: 0, totalMicroUsd: 0 });
      o.count++;
      o.totalMicroUsd += e.totalMicroUsd;
    }
    return c.json({ ...summarize(events), opStats });
  });
  // Admin read-only views (issue #7 phase 2) — the panel's Users / Sessions / Transactions tabs. Better Auth's
  // user/session tables aren't domain entities, so they're served here (dev: the same bun:sqlite db), admin-gated.
  const adminRows = (c: Context, sql: string) =>
    isAdmin(c) ? c.json(sqlite.query(sql).all() as unknown[]) : c.json({ error: "forbidden" }, 403);
  app.get("/admin/users", (c) =>
    adminRows(c, "SELECT id, email, name, role, emailVerified, banned, createdAt FROM user ORDER BY createdAt DESC LIMIT 500"),
  );
  app.get("/admin/sessions", (c) =>
    adminRows(
      c,
      "SELECT s.id, u.email, s.ipAddress, s.userAgent, s.createdAt, s.expiresAt FROM session s LEFT JOIN user u ON u.id = s.userId ORDER BY s.createdAt DESC LIMIT 500",
    ),
  );
  app.get("/admin/transactions", (c) =>
    adminRows(
      c,
      "SELECT id, customer_id, total_cents, status, stripe_payment_intent_id, created_at FROM \"order\" WHERE status IN ('paid','shipped','cancelled','refunded') ORDER BY created_at DESC LIMIT 500",
    ),
  );
  app.route("/", adminApp({ document, title: "Saasuluk", authorize: (c) => isAdmin(c), headHtml: themeHeadHtml() })); // /superadmin (verified session, not a header)
  // Unified /panel (issue #7) — ONE self-service + store-management surface for every signed-in user. It REPLACES the
  // old admin-only /panel AND the user /dashboard. @suluk/panel resolves groups/sections/stats/home/heading per-request,
  // so a single mount serves both audiences off the role-projected document:
  //   • every signed-in user gets the personal account groups (profile, security, sessions, orders, wishlist, billing,
  //     developer, danger) — role-projected so they only ever see their own rows;
  //   • owners/admins ALSO get the "Store · …" management groups (catalog, orders, content, inbox, ops).
  // /superadmin stays as the exhaustive raw-CRUD console for power users.
  const signedIn = (c: Context) => !!(c.get("sessionUser") || c.get("tokenUser"));
  app.use("/panel", (c, next) => (signedIn(c) ? next() : Promise.resolve(c.redirect("/login"))));
  app.use("/panel/*", (c, next) => (signedIn(c) ? next() : Promise.resolve(c.redirect("/login"))));
  app.route(
    "/",
    panelApp({
      document: (c) => projectDocument(document, viewerOf(c), canonHash),
      basePath: "/panel",
      title: "saasuluk",
      authorize: (c) => signedIn(c),
      headHtml: panelChromeHtml(), // issue #12 — site chrome (promo banner + branded top bar + footer) in the panel
      homeHeading: (c) => (isAdmin(c) ? "Owner dashboard" : "Your account"),
      homeLabel: "Overview",
      hideEntities: dashboardHiddenEntities,
      groups: (c) => (isAdmin(c) ? [...dashboardGroups, ...adminGroups] : dashboardGroups),
      sections: (c) => (isAdmin(c) ? [...dashboardSections, ...adminSections] : dashboardSections),
      home: (c) => dashboardHome({ admin: isAdmin(c) }),
      stats: (c) => (isAdmin(c) ? adminStats(db as never) : userStats(db as never, principal(c))),
    }),
  );
  // /dashboard + /account are retired → 301 to the unified /panel (sub-paths preserved so deep links survive).
  app.get("/dashboard", (c) => c.redirect("/panel", 301));
  app.get("/dashboard/*", (c) => c.redirect(c.req.path.replace(/^\/dashboard/, "/panel"), 301));
  app.get("/account", (c) => c.redirect("/panel", 301));
  app.get("/account/*", (c) => c.redirect("/panel", 301));
  app.route(
    "/",
    mcpApp({
      document: (c) => projectDocument(document, viewerOf(c), canonHash),
      basePath: "/mcp",
      name: "saasuluk",
      include: "read",
      exec: appExec(app),
      instructions: "Browse the saasuluk store: list and read products, posts, and categories.",
    }),
  ); // @suluk/mcp — contract → MCP server (read-only, per-role, in-process exec)
  app.route(
    "/",
    chatApp({
      document: (c) => projectDocument(document, viewerOf(c), canonHash),
      basePath: "/chat",
      include: "all",
      exec: appExec(app),
      apiKey: () => process.env.OPENROUTER_API_KEY,
      title: "saasuluk",
      greeting: "Hi! I'm the saasuluk assistant — ask me to find products, compare plans, or dig through the docs.",
      system:
        "You are the assistant for saasuluk, a premium ecommerce + SaaS starter. Use tools to browse/search the catalog and to take actions the signed-in user asks for. Ground answers in tool results; prices are in cents. Confirm before any create/update/delete. Be concise.",
    }),
  ); // @suluk/chat — in-page agent (read+act, per-role)

  app.get("/config", (c) => {
    // config health (@suluk/env) — one registry, projected
    if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
    const h = configHealth(process.env as Record<string, string | undefined>);
    return (c.req.header("accept") ?? "").includes("text/html") ? c.html(renderConfigHealth(h)) : c.json(h);
  });
  app.post("/api/stripe/webhook", async (c) => {
    // Stripe billing
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "stripe webhook not configured (set STRIPE_WEBHOOK_SECRET)" }, 503);
    const raw = await c.req.text();
    // SAME verifier as the Worker (verifyStripeSignature) — dev + prod no longer diverge on webhook auth. Dev acks;
    // the Worker's scheduled/runtime handler runs the real event processing (markOrderPaid / refund / dispute).
    if (!(await verifyStripeSignature(raw, c.req.header("stripe-signature") ?? "", secret))) return c.json({ error: "bad signature" }, 400);
    const evt = JSON.parse(raw) as { type?: string };
    return c.json({ received: true, type: evt.type });
  });
  app.get("/api/health", (c) => c.json({ ok: true, name: "saasuluk", build: BUILD_ID }, 200, { [DEPLOYMENT_HEADER]: BUILD_ID }));
  app.get("/og.svg", (c) =>
    c.body(
      ogImageSvg({
        title: c.req.query("title") || "saasuluk",
        subtitle: c.req.query("subtitle") || undefined,
        brand: "saasuluk",
        eyebrow: "saasuluk",
      }),
      200,
      { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" },
    ),
  );
  return { app, sink, document };
}
