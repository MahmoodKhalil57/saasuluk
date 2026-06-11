import { test, expect, describe, beforeAll } from "bun:test";
import { validateDocument } from "@suluk/core";
import { createApp } from "../src/server/api";

let app: Awaited<ReturnType<typeof createApp>>["app"];
let adminCookie = ""; // a VERIFIED superadmin session (email in SUPERADMIN_EMAILS) — the only way to be admin
beforeAll(async () => {
  process.env.SUPERADMIN_EMAILS = '["admin@test.dev"]'; // the access layer reads this allowlist at app build
  app = (await createApp()).app;
  // sign up the allowlisted email → the databaseHook promotes it to role:"admin", and its session is admin.
  const res = await app.request("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@test.dev", password: "test-password-123", name: "Admin" }) });
  const set = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  adminCookie = set.map((c) => c.split(";")[0]).join("; ");
});
const adminH = () => ({ cookie: adminCookie }); // headers that authenticate as the verified superadmin

const post = (p: string, body: unknown, h: Record<string, string> = {}) =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
const patch = (p: string, body: unknown, h: Record<string, string> = {}) =>
  app.request(p, { method: "PATCH", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });

describe("saasuluk — the whole Suluk stack composes into a SaaS backend (one contract)", () => {
  test("health", async () => { expect((await app.request("/api/health")).status).toBe(200); });

  test("a verified superadmin session was established (the access layer's admin identity)", () => {
    expect(adminCookie.length).toBeGreaterThan(0);
  });

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
    // the catalog is admin-write — an admin creates a product (public entity, no owner stamp)
    const created = await post("/product", { name: "Widget", slug: "widget", priceCents: 1999, status: "published" }, { ...adminH(), "x-suluk-action": "add-product" });
    expect(created.status).toBe(201);
    expect((await created.json()).name).toBe("Widget");
    expect(((await (await app.request("/product")).json()) as unknown[]).length).toBeGreaterThan(0);
    // an owned entity stamps the caller as customerId without the client sending it
    const order = await post("/order", { totalCents: 1999, status: "pending" }, { "x-user": "u9" });
    expect((await order.json()).customerId).toBe("u9");
    const cost = await (await app.request("/cost", { headers: adminH() })).json() as any;
    expect(cost.byPrincipal.u9).toBeGreaterThan(0);
    expect(cost.byAction["add-product"]).toBeGreaterThan(0);
  });

  test("custom operations: checkout applies a discount, validate previews it, and both are in the contract + metered", async () => {
    const doc = await (await app.request("/openapi.json")).json() as any;
    for (const [path, op] of [["checkout/order", "checkout"], ["discount/validate", "validateDiscount"], ["search", "search"], ["analytics/summary", "analyticsSummary"]] as const) {
      expect(doc.paths[path]?.requests[op]["x-suluk-cost"], `op not costed: ${op}`).toBeDefined();
    }
    await post("/product", { name: "Pro", slug: "pro", priceCents: 5000, status: "published", categoryId: 1 }, adminH());
    await post("/discountCode", { code: "SAVE10", discountType: "percent", discountValue: 10, isActive: true }, adminH());
    const co = await (await post("/checkout/order", { items: [{ productId: 1, qty: 2, priceCents: 5000 }], discountCode: "SAVE10" }, { "x-user": "c1", "x-suluk-action": "checkout-btn" })).json();
    expect(co.subtotalCents).toBe(10000);
    expect(co.totalCents).toBe(9000); // 10% off
    expect(co.discountApplied).toBe(true);
    expect(co.order.customerId).toBe("c1");
    const v = await (await post("/discount/validate", { code: "SAVE10", subtotalCents: 10000 }, {})).json();
    expect(v.valid).toBe(true); expect(v.newTotalCents).toBe(9000);
    const v2 = await post("/discount/validate", { code: "NOPE" }, {});
    expect(v2.status).toBe(422);
    const cost = await (await app.request("/cost", { headers: adminH() })).json() as any;
    expect(cost.byAction["checkout-btn"]).toBeGreaterThan(0);
  });

  test("custom operations: search, analytics, newsletter (idempotent), avatar (derived SVG)", async () => {
    await post("/product", { name: "Findable", slug: "find", priceCents: 100, status: "published" }, adminH());
    expect((await (await app.request("/search?q=Findable")).json()).products.length).toBeGreaterThan(0);
    expect((await (await app.request("/analytics/summary")).json()).products).toBeGreaterThan(0);
    expect((await (await app.request("/analytics/top-products")).json()).topProducts).toBeDefined();
    const n1 = await post("/newsletter/subscribe", { email: "x@y.com" }, {}); expect(n1.status).toBe(201);
    const n2 = await (await post("/newsletter/subscribe", { email: "x@y.com" }, {})).json(); expect(n2.already).toBe(true); // idempotent
    const av = await app.request("/avatar?seed=alice");
    expect(av.headers.get("content-type")).toBe("image/svg+xml");
    expect(await av.text()).toContain("<svg");
  });

  test("developer portal: an API token is generated once, authenticates a Bearer request, owner-stamps + meters, then revokes", async () => {
    const tok = await (await post("/tokens/create", { name: "CI" }, { "x-user": "dev-1" })).json();
    expect(tok.token).toMatch(/^sk_/);
    expect(tok.prefix.length).toBeLessThan(tok.token.length); // only a prefix is shown in listings
    // a Bearer token authenticates with NO x-user header — the row is owner-stamped to the token's user
    const made = await (await app.request("/project", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ name: "via-token" }) })).json();
    expect(made.ownerId).toBe("dev-1");
    const cost = await (await app.request("/cost", { headers: adminH() })).json() as any;
    expect(cost.byPrincipal["dev-1"]).toBeGreaterThan(0);
    // another user can't revoke dev-1's token (owner-scoped) → 404, and the token still works
    expect((await post(`/tokens/${tok.id}/revoke`, {}, { "x-user": "someone-else" })).status).toBe(404);
    const still = await (await app.request("/project", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ name: "still" }) })).json();
    expect(still.ownerId).toBe("dev-1"); // the foreign revoke didn't touch it
    expect((await post(`/tokens/${tok.id}/revoke`, {}, { "x-user": "dev-1" })).status).toBe(200); // the owner revokes
    const after = await (await app.request("/project", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ name: "after" }) })).json();
    expect(after.ownerId).toBeNull();
  });

  test("SECURITY: owner-scoped CRUD — a user can't see, read, or delete another user's owned rows", async () => {
    const a = await (await post("/order", { totalCents: 100, status: "pending" }, { "x-user": "alice" })).json();
    expect(a.customerId).toBe("alice");
    // bob's list excludes alice's order; bob can't GET or DELETE it
    expect(((await (await app.request("/order", { headers: { "x-user": "bob" } })).json()) as { id: number }[]).some((o) => o.id === a.id)).toBe(false);
    expect((await app.request(`/order/${a.id}`, { headers: { "x-user": "bob" } })).status).toBe(404);
    await app.request(`/order/${a.id}`, { method: "DELETE", headers: { "x-user": "bob" } });
    expect((await app.request(`/order/${a.id}`, { headers: { "x-user": "alice" } })).status).toBe(200); // bob's delete couldn't touch it
    // an UNidentified caller sees nothing (no cross-tenant dump)
    expect(((await (await app.request("/billingAccount")).json()) as unknown[]).length).toBe(0);
  });

  test("ACCESS: catalog + discounts are admin-write — no minting, no vandalism, no self-mark-paid, no code leak", async () => {
    // the underpayment vector: a self-minted near-100%-off code. CLOSED — discountCode is admin-only.
    expect((await post("/discountCode", { code: "FREE99", discountType: "percent", discountValue: 99, isActive: true }, {})).status).toBe(403);
    expect((await post("/discountCode", { code: "FREE99", discountType: "percent", discountValue: 99, isActive: true }, { "x-user": "mallory" })).status).toBe(403);
    // listing every discount code (a leak) is admin-only
    expect((await app.request("/discountCode")).status).toBe(403);
    // catalog vandalism — anyone deleting/creating a store product. CLOSED.
    expect((await app.request("/product/1", { method: "DELETE" })).status).toBe(403);
    expect((await post("/product", { name: "spam", slug: "spam" }, { "x-user": "nobody" })).status).toBe(403);
    // a user can PLACE an order but can't PATCH it to paid (status changes are system/admin-only)
    const o = await (await post("/order", { totalCents: 999, status: "pending" }, { "x-user": "mallory" })).json();
    expect((await patch(`/order/${o.id}`, { status: "paid" }, { "x-user": "mallory" })).status).toBe(403);
    expect((await (await app.request(`/order/${o.id}`, { headers: { "x-user": "mallory" } })).json()).status).toBe("pending");
    // a VERIFIED superadmin CAN manage the catalog + discounts
    expect((await post("/discountCode", { code: "ADMIN50", discountType: "percent", discountValue: 50, isActive: true }, adminH())).status).toBe(201);
    expect((await post("/product", { name: "Admin Product", slug: "admin-product", priceCents: 100, status: "published" }, adminH())).status).toBe(201);
    // public submissions: anyone may submit contact/newsletter, but only an admin reads them
    expect((await post("/contactSubmission", { name: "Q", email: "q@x.com", subject: "Hello", message: "hi" }, {})).status).toBe(201);
    expect((await app.request("/contactSubmission")).status).toBe(403);
    expect((await app.request("/contactSubmission", { headers: adminH() })).status).toBe(200);
    // reviews are public-read, owner-write — everyone sees them
    expect((await app.request("/review")).status).toBe(200);
    // marking a review helpful requires auth (no anonymous vote-stuffing — a custom op, but still principal-gated)
    expect((await post("/review/1/helpful", {}, {})).status).toBe(401);
    expect([200, 404]).toContain((await post("/review/1/helpful", {}, { "x-user": "fan" })).status);
  });

  test("Scalar renders the docs (the 3.1 compatibility view)", async () => {
    expect(await (await app.request("/scalar")).text()).toContain("Scalar.createApiReference");
  });

  test("/reference renders the contract NATIVELY as v4 — cost + access projection + requests-shape, not a 3.1 downgrade", async () => {
    const html = await (await app.request("/reference")).text();
    expect(html).toContain("OpenAPI 4.0.0-candidate"); // the real identity, not 3.1.0
    expect(html).not.toContain("3.1.0");
    expect(html).toContain("⛁");                        // the cost facet surfaced as a first-class badge
    expect(html).toContain("createProduct");            // the by-name request handle (the v4 requests-shape)
    // the View-as access projection (x-suluk-access derived from the access model)
    expect(html).toContain("View as");
    expect(html).toContain('id="reachability"');        // the reachability matrix
    const create = html.slice(html.indexOf('id="op-createProduct"'), html.indexOf('id="op-createProduct"') + 300);
    expect(create).toContain('data-reach="admin"');     // admin-only op — hidden from anon/user by the lens
    const list = html.slice(html.indexOf('id="op-listProduct"'), html.indexOf('id="op-listProduct"') + 300);
    expect(list).toContain('data-reach="anon user admin"'); // public op — reachable by everyone
  });

  test("domain CRUD over Drizzle, with cost metered (user + frontend action + source)", async () => {
    const created = await post("/project", { name: "Acme" }, { "x-user": "u1", "x-suluk-action": "new-project-button" });
    expect(created.status).toBe(201);
    expect((await created.json()).name).toBe("Acme");
    expect(((await (await app.request("/project", { headers: { "x-user": "u1" } })).json()) as unknown[]).length).toBeGreaterThan(0);
    const cost = await (await app.request("/cost", { headers: adminH() })).json() as any;
    expect(cost.byPrincipal.u1).toBeGreaterThan(0);
    expect(cost.byAction["new-project-button"]).toBeGreaterThan(0);
    expect(cost.bySource.compute).toBeGreaterThan(0);
  });

  test("/superadmin cockpit is mounted + gated on a verified superadmin (not a spoofable header)", async () => {
    expect((await app.request("/superadmin")).status).toBe(403);
    expect((await app.request("/superadmin", { headers: { "x-role": "superadmin" } })).status).toBe(403); // header is NOT enough
    expect((await app.request("/superadmin", { headers: adminH() })).status).toBe(200);
  });

  test("config health (@suluk/env): admin-only, projects the registry, never leaks values", async () => {
    expect((await app.request("/config")).status).toBe(403); // not admin
    const r = await app.request("/config", { headers: adminH() });
    expect(r.status).toBe(200);
    const h = await r.json() as any;
    expect(h.vars.some((v: any) => v.name === "STRIPE_SECRET_KEY")).toBe(true);
    expect(h.surfaces.cloudflare).toContain("STRIPE_METERED_PRICE_ID");
    // the manifest carries presence/health, NEVER the secret value
    expect(JSON.stringify(h)).not.toContain(process.env.BETTER_AUTH_SECRET ?? "no-secret-set-xyz");
    expect(h.vars.every((v: any) => !("value" in v))).toBe(true);
    // the HTML panel renders for a browser
    const html = await (await app.request("/config", { headers: { ...adminH(), accept: "text/html" } })).text();
    expect(html).toContain("Configuration health");
  });

  test("Better Auth is mounted at /api/auth/* (handled, not our 404)", async () => {
    const r = await app.request("/api/auth/reference");
    expect(r.status).not.toBe(404); // Better Auth handles it (the OpenAPI reference UI)
  });

  test("Stripe webhook endpoint exists (rejects an unsigned request: 400 when configured, 503 when not)", async () => {
    expect([400, 503]).toContain((await post("/api/stripe/webhook", {})).status);
  });
});
