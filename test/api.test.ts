import { test, expect, describe, beforeAll } from "bun:test";
import { validateDocument, sourceIndex, sourceCoverage, sourceKey, type OpenAPIv4Document } from "@suluk/core";
import { assertGrade } from "@suluk/harden";
import { createApp } from "../src/server/api";
import * as schema from "../src/server/schema";
import { OPERATION_PATHS } from "../src/server/operations";

let app: Awaited<ReturnType<typeof createApp>>["app"];
let document: OpenAPIv4Document; // the in-memory canonical (source-bearing) — for the provenance staleness gate
let adminCookie = ""; // a VERIFIED superadmin session (email in SUPERADMIN_EMAILS) — the only way to be admin
beforeAll(async () => {
  process.env.SUPERADMIN_EMAILS = '["admin@test.dev"]'; // the access layer reads this allowlist at app build
  const created = await createApp();
  app = created.app;
  document = created.document;
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
    // analytics expose revenue/customers → admin-only, ENFORCED on the wire (@suluk/hono enforceAccess): anon 401, admin 200
    expect((await app.request("/analytics/summary")).status).toBe(401);
    expect((await (await app.request("/analytics/summary", { headers: adminH() })).json()).products).toBeGreaterThan(0);
    expect((await (await app.request("/analytics/top-products", { headers: adminH() })).json()).topProducts).toBeDefined();
    const n1 = await post("/newsletter/subscribe", { email: "x@y.com" }, {}); expect(n1.status).toBe(201);
    const n2 = await (await post("/newsletter/subscribe", { email: "x@y.com" }, {})).json(); expect(n2.already).toBe(true); // idempotent
    const av = await app.request("/avatar?seed=alice");
    expect(av.headers.get("content-type")).toBe("image/svg+xml");
    expect(await av.text()).toContain("<svg");
  });

  test("developer portal: an API token is generated once, authenticates a Bearer request, owner-stamps + meters, then revokes", async () => {
    // SECURITY regression: createToken's name matches the CRUD regex (create+Token), so its facet was dropped and
    // anon could MINT a live token (adversarial review wh7os6uu0). Anon must now be denied (annotateAccess fix +
    // deny-by-default). createToken requires authentication.
    expect((await post("/tokens/create", { name: "anon-mint" }, {})).status).toBe(401);
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
    const after = await app.request("/project", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ name: "after" }) });
    expect(after.status).toBe(401); // the revoked token no longer authenticates → the owner op REJECTS it (not a silent null-owned row)
  });

  test("SECURITY: owner-scoped CRUD — a user can't see, read, or delete another user's owned rows", async () => {
    const a = await (await post("/order", { totalCents: 100, status: "pending" }, { "x-user": "alice" })).json();
    expect(a.customerId).toBe("alice");
    // bob's list excludes alice's order; bob can't GET or DELETE it
    expect(((await (await app.request("/order", { headers: { "x-user": "bob" } })).json()) as { id: number }[]).some((o) => o.id === a.id)).toBe(false);
    expect((await app.request(`/order/${a.id}`, { headers: { "x-user": "bob" } })).status).toBe(404);
    await app.request(`/order/${a.id}`, { method: "DELETE", headers: { "x-user": "bob" } });
    expect((await app.request(`/order/${a.id}`, { headers: { "x-user": "alice" } })).status).toBe(200); // bob's delete couldn't touch it
    // an UNidentified caller is REJECTED on an owner op (401) — the wire enforces x-suluk-access: authenticated,
    // so the facet can't lie (caught by @suluk/testgen's conformance suite; stronger than a null-scoped empty 200).
    expect((await app.request("/billingAccount")).status).toBe(401);
  });

  test("ACCESS: catalog + discounts are admin-write — no minting, no vandalism, no self-mark-paid, no code leak", async () => {
    // the underpayment vector: a self-minted near-100%-off code. CLOSED — discountCode is admin-only.
    // ENFORCED on the wire by @suluk/hono enforceAccess: anon → 401 (authenticate first, RFC 7235), signed-in-non-admin → 403 (forbidden).
    expect((await post("/discountCode", { code: "FREE99", discountType: "percent", discountValue: 99, isActive: true }, {})).status).toBe(401);
    expect((await post("/discountCode", { code: "FREE99", discountType: "percent", discountValue: 99, isActive: true }, { "x-user": "mallory" })).status).toBe(403);
    // listing every discount code (a leak) is admin-only
    expect((await app.request("/discountCode")).status).toBe(401);
    // catalog vandalism — anyone deleting/creating a store product. CLOSED.
    expect((await app.request("/product/1", { method: "DELETE" })).status).toBe(401);
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
    expect((await app.request("/contactSubmission")).status).toBe(401); // anon read of submissions → authenticate first
    expect((await app.request("/contactSubmission", { headers: adminH() })).status).toBe(200);
    // reviews are public-read, owner-write — everyone sees them
    expect((await app.request("/review")).status).toBe(200);
    // marking a review helpful requires auth (no anonymous vote-stuffing — a custom op, but still principal-gated)
    expect((await post("/review/1/helpful", {}, {})).status).toBe(401);
    expect([200, 404]).toContain((await post("/review/1/helpful", {}, { "x-user": "fan" })).status);
  });

  test("real validations are ENFORCED at runtime (not just graded): bad input is rejected, good input passes", async () => {
    // slug must be lowercase-dash (pattern) — "Bad Slug!" is rejected; "x-2" passes
    expect([400, 422]).toContain((await post("/product", { name: "X", slug: "Bad Slug!", priceCents: 10, status: "published" }, adminH())).status);
    expect((await post("/product", { name: "X2", slug: "x-2", priceCents: 10, status: "published" }, adminH())).status).toBe(201);
    // rating is bounded 1–5 (maximum) — 99 is rejected
    expect([400, 422]).toContain((await post("/review", { productId: 1, rating: 99, title: "Nope" }, { "x-user": "rater" })).status);
    // a display field rejects angle brackets (stored-XSS guard)
    expect([400, 422]).toContain((await post("/product", { name: "<script>x</script>", slug: "xss", priceCents: 10, status: "published" }, adminH())).status);
  });

  test("hardening (@suluk/harden): the contract is graded + GATED — our input surface is fully bounded (A)", async () => {
    const document = await (await app.request("/openapi.json")).json() as any;
    // the CI gate (the hard incentive): throws if our authored surface regresses below A (auth = third-party, excluded)
    const audit = assertGrade(document, "A", { ignore: (uri: string) => uri.toLowerCase().includes("auth") });
    expect(audit.grade).toBe("A");
    expect(audit.bySeverity.high).toBe(0);
    expect((await (await app.request("/reference")).text())).toContain("🛡 Hardening"); // surfaced in /reference (the soft incentive)
  });

  test("downloadable TypeScript SDK (@suluk/sdk): /sdk.ts generates a typed ofetch client from the contract", async () => {
    const r = await app.request("/sdk.ts");
    expect(r.headers.get("content-type")).toContain("typescript");
    expect(r.headers.get("content-disposition")).toContain("saasuluk-sdk.ts");
    const ts = await r.text();
    expect(ts).toContain("export function createClient");
    expect(ts).toContain('from "ofetch"');
    expect(ts).toContain("product: {");                 // entity-grouped methods (named-request identity)
    expect(ts).toContain("create: Object.assign");
    expect(ts).toContain("$manifest:");                 // the v4 superpowers manifest (for agents/tooling)
    expect(ts).toMatch(/requires: "(anyone|admin)"/);    // access facet as inert metadata
    // COMPLETE validations: the SDK ships the contract's JSON Schemas AS DATA + a generic, eval-free engine
    expect(ts).toContain('import { Validator } from "@cfworker/json-schema"');
    expect(ts).toContain("export const schemas = {");   // schemas shipped as data, not transpiled
    expect(ts).toContain('"~standard"');                 // each input is a Standard Schema (portable)
    expect(ts).toMatch(/"maxLength":\d+/);                // the hardened maxLength caps reached the schema, verbatim
    expect(ts).toMatch(/parse\([\w$]+Input, body\)/);     // input validated through the schema before send
    expect(ts).toContain("validate?: boolean");          // toggle (default on)
    expect((await (await app.request("/reference")).text())).toContain("⬇ TypeScript SDK"); // the download affordance
  });

  test("downloadable conformance suite (@suluk/testgen): /conformance.test.ts is the contract's claims, executable", async () => {
    const r = await app.request("/conformance.test.ts");
    expect(r.headers.get("content-type")).toContain("typescript");
    expect(r.headers.get("content-disposition")).toContain("saasuluk.conformance.test.ts");
    const ts = await r.text();
    expect(ts).toContain('import { Validator } from "@cfworker/json-schema"');
    expect(ts).toContain("async function call(method: string, path: string");        // a fetch-based suite
    // the ceiling-raiser: the server must ENFORCE x-suluk-access on the wire (a non-public op denies anon a 2xx)
    expect(ts).toContain("access — ENFORCED: anon gets NO success");
    expect(ts).toMatch(/expect\(\[200, 201, 204\],[^)]*\)\.not\.toContain\(r\.status\)/);
    expect(ts).toContain("access — public: anon is NOT auth-blocked");                 // public ops reachable
    expect(ts).toContain("createProduct");                                            // a known admin op is covered
    expect(ts).not.toContain("?as=");                                                 // asserts the WIRE, never a projection
    expect((await (await app.request("/reference")).text())).toContain("⬇ Conformance tests"); // the download affordance
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
    const ci = html.indexOf('data-op="createProduct"'); const create = html.slice(ci - 220, ci + 40);
    expect(create).toContain('data-reach="admin"');     // admin-only op — hidden from anon/user by the lens
    const li = html.indexOf('data-op="listProduct"'); const list = html.slice(li - 220, li + 40);
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

  test("L2 dynamic document (council-ratified): canonical is full + auth-free; ?as= is a provable SUBSET; /api/whoami", async () => {
    const canonical = await (await app.request("/openapi.json")).json() as any;
    const anon = await (await app.request("/openapi.json?as=anon")).json() as any;
    const ops = (d: any) => { const s = new Set<string>(); for (const p of Object.values<any>(d.paths)) for (const n of Object.keys(p.requests ?? {})) s.add(n); return s; };
    const canonOps = ops(canonical), anonOps = ops(anon);
    expect(anonOps.size).toBeLessThan(canonOps.size);                 // strictly fewer — admin/auth ops hidden
    for (const n of anonOps) expect(canonOps.has(n)).toBe(true);      // NON-ADDITIVE subset (council invariant #2): every projected op exists in canonical
    expect(canonOps.has("createProduct")).toBe(true);                 // admin op is IN canonical (full attack surface visible)
    expect(anonOps.has("createProduct")).toBe(false);                 // but hidden from the anon projection
    expect(anon["x-suluk-projection"]).toMatchObject({ canonical: "/openapi.json", derived: true, scope: "anon" }); // self-describing (#7)
    expect(typeof anon["x-suluk-projection"].canonicalHash).toBe("string");
    expect(canonical["x-suluk-projection"]).toBeUndefined();          // canonical is authoritative, not a projection
    expect((await (await app.request("/api/whoami")).json()).viewer).toBe("anon"); // anon session → anon view
  });

  describe("provenance (x-suluk-source, council whuovh6gs L2): stamped, traceable, scrubbed from external views", () => {
    const opEntries = (d: any) => Object.entries(d.paths as Record<string, any>).flatMap(([path, pi]) => Object.entries(pi.requests ?? {}).map(([name, req]) => ({ path, name, req: req as any })));

    test("every operation is STAMPED with a stable file#symbol source pointer (full coverage)", () => {
      const cov = sourceCoverage(document);
      expect(cov.total).toBeGreaterThan(0);
      expect(cov.stamped).toBe(cov.total);                                       // no op left unstamped
      expect((document as any).paths.product.requests.createProduct["x-suluk-source"]) // CRUD → the Drizzle table
        .toMatchObject({ file: "src/server/schema.ts", symbol: "product", kind: "drizzle-table" });
      expect(opEntries(document).find((o) => o.name === "checkout")!.req["x-suluk-source"]) // custom → operations.ts
        .toMatchObject({ file: "src/server/operations.ts", symbol: "checkout", kind: "operation" });
    });

    test("STALENESS GATE: every source pointer resolves to a real authored symbol (no rotting pointers)", () => {
      const exports = new Set(Object.keys(schema));                              // the real schema.ts exports
      const customOps = new Set(Object.values(OPERATION_PATHS).flatMap((pi: any) => Object.keys(pi.requests ?? {})));
      const stale: string[] = [];
      for (const { name, req } of opEntries(document)) {
        const src = req["x-suluk-source"];
        if (!src) { stale.push(`${name}: unstamped`); continue; }
        if (src.kind === "drizzle-table" && !exports.has(src.symbol)) stale.push(`${name} → schema.ts#${src.symbol}`);
        else if (src.kind === "operation" && !customOps.has(src.symbol)) stale.push(`${name} → operations.ts#${src.symbol}`);
        else if (src.kind === "better-auth" && src.file !== "src/server/auth.ts") stale.push(`${name} → ${src.file}`);
      }
      expect(stale).toEqual([]); // a non-empty list = a pointer drifted out of sync with the source (CI catches it)
    });

    test("the DERIVED reverse index groups operations by source (a table → its CRUD fan-out)", () => {
      const idx = sourceIndex(document);
      const product = idx.find((g) => sourceKey(g) === "src/server/schema.ts#product");
      expect(product).toBeDefined();
      const names = new Set(product!.operations.map((o) => o.name));
      for (const op of ["listProduct", "getProduct", "createProduct", "updateProduct", "deleteProduct"]) expect(names.has(op)).toBe(true);
    });

    test("SCRUBBED from external views: anon /openapi.json keeps cost but not source; /source is admin-only (403)", async () => {
      const anon = await (await app.request("/openapi.json")).json() as any;
      expect(anon.paths.product.requests.createProduct["x-suluk-source"]).toBeUndefined(); // internal-layout disclosure scrubbed
      expect(anon.paths.product.requests.createProduct["x-suluk-cost"]).toBeDefined();     // cost/access stay (not internal)
      expect((await app.request("/source")).status).toBe(403);                              // the reverse index is maintainer-only
    });

    test("VISIBLE to the maintainer (admin): /openapi.json + /source + the /reference ↗ src affordance", async () => {
      const admin = await (await app.request("/openapi.json", { headers: adminH() })).json() as any;
      expect(admin.paths.product.requests.createProduct["x-suluk-source"]).toMatchObject({ file: "src/server/schema.ts", symbol: "product" });
      const src = await (await app.request("/source", { headers: adminH() })).json() as any;
      expect(src.coverage.stamped).toBe(src.coverage.total);
      expect(Array.isArray(src.index)).toBe(true);
      expect((await (await app.request("/reference", { headers: adminH() })).text())).toContain("schema.ts#product"); // maintainer sees source
      expect((await (await app.request("/reference")).text())).not.toContain("schema.ts#product");                    // public does not
    });
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
