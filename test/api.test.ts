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
