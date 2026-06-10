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
