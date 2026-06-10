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
import { adminApp } from "@suluk/admin";
import { costMeter, MemoryCostSink, summarize } from "@suluk/cost";
import { stripeProvider, type StripeLike } from "@suluk/stripe";
import { auth, ensureAuthTables } from "./auth";
import { buildContract, costs } from "./contract";
import { tableByEntity } from "./domain";
import { crudHandlers, type CrudHandlers } from "./crud";
import { mountOperations } from "./operations";
import { db } from "./db";

export async function createApp() {
  await ensureAuthTables();
  const { built, document } = await buildContract();
  const sink = new MemoryCostSink();
  const ada = buildAda(document);

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
    if (!h) { h = crudHandlers(def.table, def.ownerCol); handlerCache.set(entity, h); }
    return { ...r, handler: h[verb as keyof CrudHandlers] as RouteContract["handler"] };
  });

  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));                       // Better Auth
  app.use("*", costMeter({                                                                      // meter every op
    sink, costs,
    operationOf: (c) => matchRequest(ada, c.req.method, new URL(c.req.url).pathname)?.operation.name,
    principalOf: (c) => c.req.header("x-user") || undefined,
  }));
  mount(app, routes);                                                                            // contract-derived CRUD
  mountOperations(app, () => db);                                                                // custom ops (checkout, search, analytics, …)
  app.get("/scalar", () => scalarResponse(document));                                            // docs (cost + auth shown)
  app.get("/openapi.json", (c) => c.json(document as unknown as Record<string, unknown>));
  app.get("/cost", (c) => c.json(summarize(sink.events())));                                     // raw cost ledger
  app.route("/", adminApp({ document, title: "Saasuluk", authorize: (c) => c.req.header("x-role") === "superadmin" })); // /superadmin
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
