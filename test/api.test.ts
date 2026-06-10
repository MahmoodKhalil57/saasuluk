import { test, expect, describe, beforeAll } from "bun:test";
import { validateDocument } from "@suluk/core";
import { createApp } from "../src/server/api";

let app: Awaited<ReturnType<typeof createApp>>["app"];
beforeAll(async () => { app = (await createApp()).app; });

const post = (p: string, body: unknown, h: Record<string, string> = {}) =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });

describe("saasuluk — the whole Suluk stack composes into a SaaS backend (one contract)", () => {
  test("health", async () => { expect((await app.request("/api/health")).status).toBe(200); });

  test("the v4 document is valid + carries cost (x-suluk-cost) + auth securitySchemes", async () => {
    const doc = await (await app.request("/openapi.json")).json() as any;
    expect(doc.openapi).toContain("4.");
    expect(validateDocument(doc).valid).toBe(true);
    expect(doc.paths.project.requests.createProject["x-suluk-cost"]).toBeDefined();
    expect(Object.keys(doc.components.securitySchemes)).toContain("sessionCookie");
  });

  test("the WHOLE domain projects from the registry — every entity has CRUD + cost (one source)", async () => {
    const doc = await (await app.request("/openapi.json")).json() as any;
    // saastarter's collections + ecommerce, now declared once and projected into the contract
    for (const e of ["product", "order", "cart", "review", "wishlistItem", "discountCode", "post", "faq", "newsletterSubscriber", "contactSubmission", "category", "variant", "media", "apiToken"]) {
      expect(doc.paths[e], `missing path: ${e}`).toBeDefined();
      expect(doc.paths[e].requests[`create${e[0].toUpperCase()}${e.slice(1)}`]["x-suluk-cost"]).toBeDefined();
    }
  });

  test("a new entity serves real Drizzle CRUD, owner-stamped + cost-metered (generic, not hand-written)", async () => {
    const created = await post("/product", { name: "Widget", slug: "widget", priceCents: 1999, status: "published" }, { "x-user": "u9", "x-suluk-action": "add-product" });
    expect(created.status).toBe(201);
    expect((await created.json()).name).toBe("Widget");
    expect(((await (await app.request("/product")).json()) as unknown[]).length).toBeGreaterThan(0);
    // an owned entity stamps the caller as customerId without the client sending it
    const order = await post("/order", { totalCents: 1999, status: "pending" }, { "x-user": "u9" });
    expect((await order.json()).customerId).toBe("u9");
    const cost = await (await app.request("/cost")).json() as any;
    expect(cost.byPrincipal.u9).toBeGreaterThan(0);
    expect(cost.byAction["add-product"]).toBeGreaterThan(0);
  });

  test("custom operations: checkout applies a discount, validate previews it, and both are in the contract + metered", async () => {
    const doc = await (await app.request("/openapi.json")).json() as any;
    for (const [path, op] of [["checkout", "checkout"], ["discount/validate", "validateDiscount"], ["search", "search"], ["analytics/summary", "analyticsSummary"]] as const) {
      expect(doc.paths[path]?.requests[op]["x-suluk-cost"], `op not costed: ${op}`).toBeDefined();
    }
    await post("/product", { name: "Pro", slug: "pro", priceCents: 5000, status: "published", categoryId: 1 }, { "x-user": "c1" });
    await post("/discountCode", { code: "SAVE10", discountType: "percent", discountValue: 10, isActive: true }, {});
    const co = await (await post("/checkout", { items: [{ productId: 1, qty: 2, priceCents: 5000 }], discountCode: "SAVE10" }, { "x-user": "c1", "x-suluk-action": "checkout-btn" })).json();
    expect(co.subtotalCents).toBe(10000);
    expect(co.totalCents).toBe(9000); // 10% off
    expect(co.discountApplied).toBe(true);
    expect(co.order.customerId).toBe("c1");
    const v = await (await post("/discount/validate", { code: "SAVE10", subtotalCents: 10000 }, {})).json();
    expect(v.valid).toBe(true); expect(v.newTotalCents).toBe(9000);
    const v2 = await post("/discount/validate", { code: "NOPE" }, {});
    expect(v2.status).toBe(422);
    const cost = await (await app.request("/cost")).json() as any;
    expect(cost.byAction["checkout-btn"]).toBeGreaterThan(0);
  });

  test("custom operations: search, analytics, newsletter (idempotent), avatar (derived SVG)", async () => {
    await post("/product", { name: "Findable", slug: "find", priceCents: 100, status: "published" }, {});
    expect((await (await app.request("/search?q=Findable")).json()).products.length).toBeGreaterThan(0);
    expect((await (await app.request("/analytics/summary")).json()).products).toBeGreaterThan(0);
    expect((await (await app.request("/analytics/top-products")).json()).topProducts).toBeDefined();
    const n1 = await post("/newsletter/subscribe", { email: "x@y.com" }, {}); expect(n1.status).toBe(201);
    const n2 = await (await post("/newsletter/subscribe", { email: "x@y.com" }, {})).json(); expect(n2.already).toBe(true); // idempotent
    const av = await app.request("/avatar?seed=alice");
    expect(av.headers.get("content-type")).toBe("image/svg+xml");
    expect(await av.text()).toContain("<svg");
  });

  test("Scalar renders the docs", async () => {
    expect(await (await app.request("/scalar")).text()).toContain("Scalar.createApiReference");
  });

  test("domain CRUD over Drizzle, with cost metered (user + frontend action + source)", async () => {
    const created = await post("/project", { name: "Acme" }, { "x-user": "u1", "x-suluk-action": "new-project-button" });
    expect(created.status).toBe(201);
    expect((await created.json()).name).toBe("Acme");
    expect(((await (await app.request("/project")).json()) as unknown[]).length).toBeGreaterThan(0);
    const cost = await (await app.request("/cost")).json() as any;
    expect(cost.byPrincipal.u1).toBeGreaterThan(0);
    expect(cost.byAction["new-project-button"]).toBeGreaterThan(0);
    expect(cost.bySource.compute).toBeGreaterThan(0);
  });

  test("/superadmin cockpit is mounted + gated", async () => {
    expect((await app.request("/superadmin")).status).toBe(403);
    expect((await app.request("/superadmin", { headers: { "x-role": "superadmin" } })).status).toBe(200);
  });

  test("Better Auth is mounted at /api/auth/* (handled, not our 404)", async () => {
    const r = await app.request("/api/auth/reference");
    expect(r.status).not.toBe(404); // Better Auth handles it (the OpenAPI reference UI)
  });

  test("Stripe webhook endpoint exists (503 until configured)", async () => {
    expect((await post("/api/stripe/webhook", {})).status).toBe(503);
  });
});
