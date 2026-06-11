/**
 * The Hono app — every Suluk surface, from ONE contract. Better Auth at /api/auth/*; the cost meter on every
 * request; the contract-derived domain CRUD (Drizzle-backed); Scalar docs + the raw v4 doc; the /superadmin
 * cockpit (same brain as the vscode extension); the cost ledger; and the Stripe webhook. Same `app` deploys
 * to a Cloudflare Worker (Hono is native there).
 */
import { Hono } from "hono";
import { mount, type RouteContract } from "@suluk/hono";
import { buildAda, matchRequest } from "@suluk/core";
import { scalarResponse } from "@suluk/scalar";
import { referenceResponse } from "@suluk/reference";
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
  app.get("/reference", () => referenceResponse(document, { pageTitle: "Saasuluk — v4 reference" })); // PRIMARY docs: the v4 doc rendered AS v4 (cost facet + requests-shape)
  app.get("/scalar", () => scalarResponse(document));                                            // 3.1 compatibility view (Scalar renders OpenAPI 3.x)
  app.get("/openapi.json", (c) => c.json(document as unknown as Record<string, unknown>));
  app.get("/cost", (c) => {                                                                      // raw cost ledger — SCOPED to the caller (a VERIFIED superadmin sees all)
    const who = principal(c);
    const all = sink.events();
    return c.json(summarize(isAdmin(c) ? all : all.filter((e) => e.principal === who)));
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
