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
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { mount, enforceAccess, enforceRateLimit, MemoryRateLimitStore, type RouteContract } from "@suluk/hono";
import { kvRateLimitStore } from "@suluk/cloudflare";
import { RATE_LIMITS } from "../src/server/ratelimits";
import { buildApp } from "@suluk/builder";
import { tableComponents, crudHandlers } from "@suluk/drizzle";
import { annotateCosts, computeCost, summarize, type CostEvent } from "@suluk/cost";
import { authSecuritySchemes, mergeAuth } from "@suluk/better-auth";
import { buildAda, matchRequest, scrubSource, sourceIndex, sourceCoverage } from "@suluk/core";
import { scalarResponse, scalarV4Response, enrichedSpec, enrichedV4, SCALAR_VERSION } from "@suluk/scalar";
import { swaggerResponse } from "@suluk/swagger";
import { ogImageSvg, DEPLOYMENT_HEADER } from "@suluk/seo";
import { renderCockpitPage } from "../src/server/cockpit-view";
import { themeHeadHtml } from "../src/themes/head";
import { BUILD_ID } from "../src/build-id";
import { referenceInsightsResponse } from "@suluk/reference";
import { SCALAR_FORK_HASH } from "./gen/scalar-fork";
import { v4ShowcaseDoc } from "../src/server/v4-showcase";
import { generateSdk } from "@suluk/sdk";
import { generateTests } from "@suluk/testgen";
import { adminApp } from "@suluk/admin";
import { panelApp } from "@suluk/panel";
import { mcpApp, appExec } from "@suluk/mcp";
import { chatApp, chatWidget } from "@suluk/chat";
import { dashboardSections, dashboardGroups, dashboardHiddenEntities, dashboardHome, userStats, adminStats, adminGroups, adminSections } from "../src/server/dashboard";
import { getAuth } from "./auth-d1";
import { entitySchemas, costs as domainCosts, tableByEntity, allTables } from "../src/server/domain";
import { OPERATION_PATHS, OPERATION_COSTS, mountOperations, verifyApiToken, principal, sweepBillingUsage, markOrderPaid, cancelPendingOrder, reapAbandonedOrders, sweepAbandonedCartEmails, refundOrder, sendOrderReceipt, crudAfterUpdate, CRUD_AFTER_UPDATE_TABLES } from "../src/server/operations";
import { verifyStripeSignature, retrievePaymentIntent, webhookRouter, STRIPE_EVENTS, type WebhookEvent } from "@suluk/stripe";
import { isAdmin, redactRow, superadminEmails, type AccessMode } from "../src/server/access";
import { configHealth, renderConfigHealth, loadConfig, METER_EVENT_DEFAULT } from "../src/server/env";
import { annotateAccess, accessIndex } from "../src/server/access-facet";
import { annotateSource } from "../src/server/source-facet";
import { hardenDocument } from "@suluk/harden";
import { projectDocument, requestedViewer, viewerOf, docHash } from "../src/server/project";

const costs = { ...domainCosts, ...OPERATION_COSTS };
const built = buildApp({ entities: entitySchemas, info: { title: "Saasuluk API (Cloudflare)", version: "0.1.0" } });
built.backend.document.paths = { ...built.backend.document.paths, ...(OPERATION_PATHS as typeof built.backend.document.paths) };
// name every entity schema into components.schemas so the WHOLE domain is in the runtime doc (the data-admin,
// SDK + conformance project from it) — without this the prod /superadmin can't see or manage any domain entity.
built.backend.document.components = { ...(built.backend.document.components ?? {}), schemas: { ...(built.backend.document.components?.schemas ?? {}), ...tableComponents(allTables) } };
const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
const document = hardenDocument(annotateSource(annotateAccess(mergeAuth(annotateCosts(built.backend.document, costs), {}, { securitySchemes })))); // cost + access + source (provenance) facets + baseline hardening
const CANON_HASH = docHash(document); // canonical hash — the L2 projection's integrity pointer (council wcavrm7zk)
const ada = buildAda(document);
const access = accessIndex(document); // op → x-suluk-access, for the wire enforcer

// minimal R2 surface (avoids pulling @cloudflare/workers-types) — for @suluk/panel media uploads.
type R2Object = { body: ReadableStream; httpMetadata?: { contentType?: string } };
type MediaBucket = { put(key: string, value: ReadableStream | ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; get(key: string): Promise<R2Object | null> };
type KvLike = { get: (k: string) => Promise<string | null>; put: (k: string, v: string, opts?: { expirationTtl?: number }) => Promise<void> };
type Env = { DB: D1Database; MEDIA?: MediaBucket; RATE_LIMIT_KV?: KvLike; BETTER_AUTH_SECRET?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; RESEND_API_KEY?: string; RESEND_AUDIENCE_ID?: string; EMAIL_FROM?: string; BASE_URL?: string; STRIPE_METER_EVENT_NAME?: string; STRIPE_METERED_PRICE_ID?: string; SUPERADMIN_EMAILS?: string; OPENROUTER_API_KEY?: string };
const app = new Hono<{ Bindings: Env; Variables: { tokenUser?: string; sessionUser?: string; sessionEmail?: string; isAdmin?: boolean } }>();

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
      if (s?.user?.id) { c.set("sessionUser", s.user.id); if (s.user.email) { c.set("sessionEmail", s.user.email); if (admins.includes(s.user.email.toLowerCase())) c.set("isAdmin", true); } } // email stashed so checkout snapshots it onto the order + sends a receipt
    } catch { /* anonymous */ }
  }
  await next();
});

// WIRE-enforce x-suluk-access (C022 inv.3) — the facet is load-bearing on custom ops too, not just CRUD. Runs
// before the meter so a rejected request isn't billed.
app.use("*", enforceAccess({
  operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
  accessOf: (op) => access[op],
  principal: (c) => principal(c),
  isAdmin: (c) => isAdmin(c as unknown as Context),
}));

// RATE LIMIT (parity with the dev server) — a DISTRIBUTED counter backed by Workers KV so the budget holds across
// isolates, not just per-instance. The KV binding lives in c.env (per-request), but enforceRateLimit takes one store
// at config time, so we capture the binding into RL_KV on the first request. Fails OPEN to a per-isolate memory store
// when KV is unbound or hiccups (a rate-limit outage must never take checkout down).
let RL_KV: KvLike | undefined;
// KV-backed fixed-window store (from @suluk/cloudflare), lazy KV getter + fail-open to a per-isolate memory store.
const rlStore = kvRateLimitStore(() => RL_KV, { fallback: new MemoryRateLimitStore() });
app.use("*", async (c, next) => { if (!RL_KV && (c.env as Env).RATE_LIMIT_KV) RL_KV = (c.env as Env).RATE_LIMIT_KV; return next(); });
app.use("*", enforceRateLimit({
  operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
  rateLimitOf: (op) => RATE_LIMITS[op],
  store: rlStore,
  // KEY off Cloudflare's cf-connecting-ip — the REAL client IP, set by CF and NOT client-forgeable. The library default
  // keys off x-forwarded-for, which on Workers is a client-supplied passthrough: an attacker rotates it to bypass the
  // budget, while honest clients (who send no XFF) collapse into one shared "unknown" bucket and DoS each other.
  keyOf: (c, facet) => facet.key === "global" ? "global" : (c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || "unknown"),
  defaultFacet: { windowMs: 60000, maxRequests: 300, key: "ip" }, // generous blanket so every op has basic protection
}));

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
// The D1 binding of @suluk/drizzle's crudHandlers factory — the SAME implementation the dev server uses
// (src/server/crud.ts), differing ONLY in the injected db resolver (D1 here vs bun:sqlite there). No twin to drift.
function d1Crud(table: SQLiteTable, ownerCol?: string, access?: AccessMode) {
  return crudHandlers(table, {
    ownerCol, access,
    db: (c) => drizzle((c as Context<{ Bindings: Env }>).env.DB) as never,
    principal, isAdmin, redact: redactRow,
    afterUpdate: crudAfterUpdate, afterUpdateTables: CRUD_AFTER_UPDATE_TABLES,
  });
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

// /reference — the ONE v4 reference: the self-hosted Scalar UI faithfully fed the v4 doc + ALL suluk superpowers
// (cost/access badges + breakdowns) + the "View as" role projector + the v4-native panels (cost explorer,
// reachability matrix, ADA playground, hardening) rendered INLINE in Scalar's own content (via the fork's
// content-start slot — no second page, no bolt-on drawer). The `?v=` hash cache-busts on every fork rebuild.
const SCALAR_SELF = `/vendor/scalar/standalone-${SCALAR_VERSION}.js`; // upstream Scalar (for /scalar, vanilla)
const SCALAR_FORK = `/vendor/scalar/standalone-suluk.js?v=${SCALAR_FORK_HASH}`; // OUR fork: latest Scalar + suluk v4 patches (for /reference)
const refBase = (c: Context) => (isAdmin(c) ? document : scrubSource(document));
const refProjected = (c: Context) => { const v = requestedViewer(c, c.req.query("as")); const b = refBase(c); return v ? projectDocument(b, v, CANON_HASH) : b; };
app.get("/reference", (c) => scalarV4Response(refBase(c as unknown as Context), {
  cdn: SCALAR_FORK, pageTitle: "saasuluk — OpenAPI v4 reference", brand: "saasuluk", specUrl: "/reference/spec",
  views: [{ label: "Anonymous", value: "anon" }, { label: "Signed-in", value: "user" }, { label: "Admin", value: "admin" }],
  insightsUrl: "/reference/insights",
}));
// The "View as" projector fetches this: the role-projected v4 doc, facet-enriched and served AS v4 (the forked Scalar
// ingests it natively). A non-admin never sees provenance (scrubbed base); projection only HIDES ops a role can't
// reach (concealment, not authz).
app.get("/reference/spec", (c) => c.json(enrichedV4(refProjected(c as unknown as Context)).spec));
// The ⚡ Insights drawer iframes this: the v4 superpower PANELS (cost explorer, reachability, ADA, hardening) — same
// role projection as the spec, so the drawer reflects the selected "View as".
app.get("/reference/insights", (c) => referenceInsightsResponse(refProjected(c as unknown as Context), { costLedgerUrl: "/cost", whoamiUrl: "/api/whoami" }));
// /reference/showcase — a self-contained v4 doc demonstrating MULTI-REQUEST-PER-METHOD (the one v4 capability 3.1
// can't express): /checkout has two requests sharing POST, rendered by the forked Scalar as distinct operations.
app.get("/reference/showcase", () => scalarV4Response(v4ShowcaseDoc as never, { cdn: SCALAR_FORK, pageTitle: "OpenAPI v4 — Multi-Request Showcase", brand: "v4 showcase" }));
app.get("/sdk.ts", (c) => new Response(generateSdk(document, { baseURL: new URL(c.req.url).origin }), { headers: { "content-type": "application/typescript; charset=utf-8", "content-disposition": 'attachment; filename="saasuluk-sdk.ts"' } })); // a complete typed ofetch SDK from the contract
app.get("/conformance.test.ts", (c) => new Response(generateTests(isAdmin(c) ? document : scrubSource(document), { baseURL: new URL(c.req.url).origin }), { headers: { "content-type": "application/typescript; charset=utf-8", "content-disposition": 'attachment; filename="saasuluk.conformance.test.ts"' } })); // a runnable suite asserting the SERVER ENFORCES the contract (access on the wire, status, schema, cost)
// /scalar — VANILLA Scalar: the plain v4→3.1 downgrade fed to stock Scalar (no badges, no theme, no suluk superpowers).
// The honest "what upstream Scalar shows" baseline; the fancy v4 view lives at /reference.
app.get("/scalar", () => scalarResponse(scrubSource(document), { cdn: SCALAR_SELF, facetBadges: false, customCss: "" }));
app.get("/swagger", () => swaggerResponse(scrubSource(document)));                              // Swagger UI — a second contract-rendered docs lens (@suluk/swagger)
app.get("/cockpit", (c) => isAdmin(c) ? c.html(renderCockpitPage(document)) : c.json({ error: "forbidden" }, 403)); // admin: ship gates + convergence + diagrams (@suluk/cockpit + docs + visual)
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

// Signed-in (verified session OR API token) — the gate for the user /dashboard.
const isSignedIn = (c: Context): boolean => { const g = c as unknown as { get: (k: string) => unknown }; return !!(g.get("sessionUser") || g.get("tokenUser")); };

// the /superadmin cockpit — the same brain as the VSCode extension, now running on a Worker. Gated on a VERIFIED
// superadmin session (SUPERADMIN_EMAILS), not a spoofable header — it surfaces the whole store's cost ledger.
app.route("/", adminApp({ document, title: "Saasuluk (Cloudflare)", authorize: (c) => isAdmin(c as unknown as Context), headHtml: themeHeadHtml() }));
// /superadmin's admin panel — @suluk/panel as a full dashboard: every entity (grouped), admin KPIs, the global cost
// ledger (moved here from the old user /dashboard). Admin-gated; full document.
app.route("/", panelApp({ document, basePath: "/panel", title: "saasuluk", authorize: (c) => isAdmin(c as unknown as Context), headHtml: themeHeadHtml(), uploadPath: "/panel/upload",
  homeHeading: "Superadmin", homeLabel: "Overview", groups: adminGroups, sections: adminSections, stats: (c) => adminStats(drizzle(c.env.DB) as never) }));

// The signed-in USER's /dashboard — the consolidated self-service area (replaces /account + /dashboard). Same panel
// framework, but projected to the CALLER's role: they get ONLY their own entities (orders, wishlist, reviews,
// projects, cart) plus the custom sections (profile, security, sessions, billing, API keys, danger zone). Anonymous
// visitors are bounced to /login.
app.use("/dashboard", (c, next) => (isSignedIn(c) ? next() : Promise.resolve(c.redirect("/login"))));
app.use("/dashboard/*", (c, next) => (isSignedIn(c) ? next() : Promise.resolve(c.redirect("/login"))));
app.route("/", panelApp({
  document: (c) => projectDocument(document, viewerOf(c as unknown as Context), CANON_HASH),
  basePath: "/dashboard", title: "saasuluk", authorize: (c) => isSignedIn(c), headHtml: themeHeadHtml(), uploadPath: "/panel/upload",
  homeHeading: "Your dashboard", homeLabel: "Overview",
  sections: dashboardSections, groups: dashboardGroups, hideEntities: dashboardHiddenEntities,
  home: (c) => dashboardHome({ admin: isAdmin(c as unknown as Context) }), // bespoke, role-aware product overview
  stats: (c) => userStats(drizzle(c.env.DB) as never, principal(c as unknown as Context)),
}));
// /account is retired — fold it into /dashboard.
app.get("/account", (c) => c.redirect("/dashboard", 301));
app.get("/account/*", (c) => c.redirect("/dashboard", 301));

// Media uploads for @suluk/panel — admin-only, raster images only (no SVG → no inline-script vector), 5 MB cap,
// random key (no path traversal / overwrite); stored in R2 and served back with nosniff + a locked-down CSP.
const UPLOAD_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
app.post("/panel/upload", async (c) => {
  if (!isAdmin(c as unknown as Context)) return c.json({ error: "forbidden" }, 403);
  if (!c.env.MEDIA) return c.json({ error: "media storage not configured" }, 503);
  // Cheap fast-path: reject by declared length BEFORE formData() buffers the whole body into isolate memory.
  // Client-supplied + absent under chunked encoding, so the post-parse file.size check below stays authoritative.
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > 5 * 1024 * 1024) return c.json({ error: "file too large (max 5 MB)" }, 413);
  const file = (await c.req.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) return c.json({ error: "no file uploaded" }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: "file too large (max 5 MB)" }, 413);
  const ext = UPLOAD_EXT[file.type];
  if (!ext) return c.json({ error: "unsupported type — raster images only (png/jpg/webp/gif/avif)" }, 415);
  const key = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  return c.json({ url: `/media/${key}` });
});
app.get("/media/:key", async (c) => {
  if (!c.env.MEDIA) return c.notFound();
  const obj = await c.env.MEDIA.get(c.req.param("key")); // :key is a single segment → no traversal
  if (!obj) return c.notFound();
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
});

// @suluk/mcp — the contract projected ONE more way: a Model Context Protocol server at /mcp. Tools = exactly what
// the CALLER's role may READ (projectDocument per viewer, read-only), each executed as a same-origin subrequest so
// the store's own enforceAccess gate is the real boundary on every call. Anonymous agents browse the public catalog
// (products/posts/categories); the machine-callable companion to /llms.txt. Streamable-HTTP JSON-RPC (POST /mcp).
app.route("/", mcpApp({
  document: (c) => projectDocument(document, viewerOf(c as unknown as Context), CANON_HASH),
  basePath: "/mcp",
  name: "saasuluk",
  version: BUILD_ID,
  include: "read",
  exec: appExec(app), // dispatch tool calls in-process through THIS app (no edge self-loop / 522 on Workers)
  instructions: "Browse the saasuluk store: list and read products, posts, and categories. The tool set mirrors the caller's role — anonymous callers see the public catalog.",
}));

// @suluk/chat — the in-page floating ASSISTANT. Same contract → an agent that can BROWSE and (when the user is
// signed in) ACT: it runs an OpenRouter tool-use loop (model chosen by @suluk/models) over the role-projected
// operations, executed in-process through enforceAccess — so the agent is exactly as capable as the caller is.
app.route("/", chatApp({
  document: (c) => projectDocument(document, viewerOf(c as unknown as Context), CANON_HASH),
  basePath: "/chat",
  include: "all", // read + act; the per-role projection + enforceAccess decide what a given caller may actually do
  exec: appExec(app),
  apiKey: (c) => c.env.OPENROUTER_API_KEY,
  referer: "https://saasuluk.saastemly.com",
  title: "saasuluk",
  greeting: "Hi! I'm the saasuluk assistant. I can find products, compare plans, add things to your cart (no sign-in needed), switch the theme, navigate the site, and dig through the docs. What can I do for you?",
  system:
    "You are the assistant for saasuluk, a premium ecommerce + SaaS starter whose products are real slices of its own codebase. " +
    "Use the tools to browse and search the catalog (products, categories, posts, FAQs) and to take actions the signed-in user asks for (e.g. placing an order). " +
    "You can ALSO act directly in the user's browser: add/remove items in their cart (this works even when they are NOT signed in — the cart is local), set the quantity, open the cart, go to checkout, switch light/dark theme, apply a color scheme, and navigate to pages. " +
    "To add a product to the cart, first find its numeric id via search or listProduct, then call addToCart with that id. The user's current cart and page are given to you as read-only browser state — use it to answer 'what's in my cart' and to avoid re-adding duplicates. " +
    "Ground every answer in tool results — never invent products, prices, or availability. Prices are stored in cents; present them as currency. " +
    "Briefly confirm before checkout or before deleting anything. If a server tool returns an authorization error, tell them they may need to sign in. " +
    "Be concise and friendly; use short markdown and link to pages like /products/<slug>, /pricing, or /blogs/<slug> when helpful.",
}));

// config health (@suluk/env) — one declared registry (src/server/env.ts) projected into the admin surface. The
// browser gets the premium HTML panel; an API client gets JSON. Values are NEVER returned — presence only.
app.get("/config", (c) => {
  if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
  const h = configHealth(c.env as unknown as Record<string, string | undefined>);
  return (c.req.header("accept") ?? "").includes("text/html") ? c.html(renderConfigHealth(h)) : c.json(h);
});
app.get("/api/health", (c) => c.json({ ok: true, on: "cloudflare-workers", name: "saasuluk", build: BUILD_ID }, 200, { [DEPLOYMENT_HEADER]: BUILD_ID })); // build id → @suluk/seo skew-protection
app.get("/og.svg", (c) => c.body(ogImageSvg({ title: c.req.query("title") || "saasuluk", subtitle: c.req.query("subtitle") || undefined, brand: "saasuluk", eyebrow: "saasuluk" }), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" })); // dynamic branded OG card (@suluk/seo)

// Stripe webhook — verifies the signature with Web Crypto (no SDK) and marks the order paid on completion.
// Secondary to the success-page confirm (which retrieves the session directly); add an endpoint in Stripe
// (https://saasuluk.saastemly.com/api/stripe/webhook) and put its signing secret in STRIPE_WEBHOOK_SECRET.
/** Resolve an order id from a Stripe PaymentIntent (its metadata.orderId, stamped at checkout) — for dispute events
 *  whose object carries the PI but not the order metadata directly. One read-only Stripe call; 0 if unresolvable. */
async function orderIdFromPI(piId: string, key: string): Promise<number> {
  const pi = await retrievePaymentIntent<{ metadata?: { orderId?: string } }>(key, piId);
  return Number(pi?.metadata?.orderId) || 0;
}
app.post("/api/stripe/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "stripe webhook not configured" }, 503);
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(raw, c.req.header("stripe-signature") ?? "", secret))) return c.json({ error: "bad signature" }, 400);
  const evt = JSON.parse(raw) as WebhookEvent;
  const obj = (evt.data as { object?: { client_reference_id?: string; metadata?: { orderId?: string }; refunded?: boolean; status?: string; payment_intent?: string } } | undefined)?.object;
  const oid = Number(obj?.client_reference_id ?? obj?.metadata?.orderId);
  const dz = drizzle(c.env.DB);
  let disputeUnresolved = false;
  // structured dispatch via @suluk/stripe's webhookRouter (typo-safe STRIPE_EVENTS keys) — replaces a hand-rolled switch.
  await webhookRouter()
    // mark paid AND send the receipt — gated on the once-only transition so a buyer who closed the tab (never hit the
    // success page → confirmCheckout) still gets their receipt, and a tab-returner + this webhook can't double-send.
    .on(STRIPE_EVENTS.checkoutCompleted, async () => { if (oid && await markOrderPaid(c as unknown as Parameters<typeof markOrderPaid>[0], dz, oid)) await sendOrderReceipt(c as unknown as Parameters<typeof sendOrderReceipt>[0], dz, oid); })
    .on(STRIPE_EVENTS.checkoutExpired, async () => { if (oid) await cancelPendingOrder(dz, oid); }) // buyer abandoned the hosted checkout → release the pending order
    // charge.refunded also fires on PARTIAL refunds (refunded=false); only a FULL refund cancels + restocks the order.
    .on(STRIPE_EVENTS.chargeRefunded, async () => { if (oid && obj?.refunded === true) await refundOrder(dz, oid); })
    // best practice: a WON dispute keeps the order paid; a LOST dispute reverses the funds → reverse the order (cancel +
    // restock, like a refund). The dispute object carries no order metadata, so resolve via its PaymentIntent.
    .on(STRIPE_EVENTS.disputeClosed, async () => {
      if (obj?.status !== "lost") return;
      const did = oid || await orderIdFromPI(obj?.payment_intent ?? "", c.env.STRIPE_SECRET_KEY ?? "");
      if (did) await refundOrder(dz, did); else disputeUnresolved = true; // can't resolve → 5xx below so Stripe re-delivers
    })
    .handle(evt);
  // charge.dispute.created is intentionally NOT handled — a dispute can still be WON; pre-emptively reversing would be wrong.
  if (disputeUnresolved) return c.json({ error: "could not resolve the order for a lost dispute — retry" }, 500);
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
    // reap abandoned pending orders (>24h) every run so the fulfillment queue stays clean — independent of Stripe config.
    ctx.waitUntil(reapAbandonedOrders(drizzle(env.DB)).catch(() => 0));
    // abandoned-cart recovery: one "complete your order" email for pending orders idle ≥1h (before the 24h reap).
    ctx.waitUntil(sweepAbandonedCartEmails(drizzle(env.DB), { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, origin: env.BASE_URL ?? "https://saasuluk.saastemly.com" }).catch(() => 0));
    if (!env.STRIPE_SECRET_KEY) return;
    ctx.waitUntil(sweepBillingUsage(drizzle(env.DB), env.STRIPE_SECRET_KEY, env.STRIPE_METER_EVENT_NAME ?? METER_EVENT_DEFAULT).catch(() => ({ swept: 0, reported: 0 })));
  },
};
