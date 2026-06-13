/**
 * A tiny OpenAPI v4 ("Moonwalk") document whose sole purpose is to demonstrate **multi-request-per-method** — the
 * one v4 capability a 3.1 view literally cannot express. The `/checkout` path carries TWO named requests that share
 * the `POST` method (`guestCheckout`, `memberCheckout`); the forked Scalar renders them as DISTINCT operations (own
 * params/body/responses/try-it), keyed apart by a synthetic path key that is stripped back to `/checkout` for
 * display + the try-it URL. The `/ping` path (one GET) proves the non-colliding common case is unchanged.
 *
 * Served at `/reference/showcase` via the SAME forked Scalar bundle that powers `/reference`. It does NOT touch the
 * real saasuluk API contract — it's a self-contained capability demo.
 */
export const v4ShowcaseDoc = {
  openapi: "4.0.0-candidate",
  info: {
    title: "OpenAPI v4 — Multi-Request Showcase",
    version: "1.0.0",
    description:
      "A minimal **OpenAPI 4.0.0-candidate** document demonstrating **multi-request-per-method**: one path " +
      "(`/checkout`) carries two named requests that share `POST` — `guestCheckout` and `memberCheckout` — which a " +
      "3.1 document cannot represent (it keys operations by method). The forked Scalar renders each as its own " +
      "operation with distinct parameters, body and try-it state, both targeting the same real endpoint.",
  },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/checkout": {
      summary: "Checkout",
      requests: {
        guestCheckout: {
          method: "post",
          summary: "Guest checkout",
          description: "Place an order without an account — email + cart only.",
          parameterSchema: {
            body: {
              type: "object",
              properties: {
                cart: { type: "string", description: "Cart id" },
                email: { type: "string", format: "email" },
              },
              required: ["cart", "email"],
            },
          },
          responses: {
            ok: { status: 200, description: "Guest order placed" },
            badRequest: { status: 400, description: "Invalid cart or email" },
          },
          "x-suluk-access": { requires: "anyone" },
          "x-suluk-cost": { components: [{ source: "db-write", basis: "per-call", microUsd: 40 }] },
        },
        memberCheckout: {
          method: "post",
          summary: "Member checkout",
          description: "Place an order as a signed-in member — requires a member token, applies loyalty points.",
          parameterSchema: {
            header: {
              type: "object",
              properties: { "X-Member-Token": { type: "string", description: "Member session token" } },
              required: ["X-Member-Token"],
            },
            body: {
              type: "object",
              properties: {
                cart: { type: "string", description: "Cart id" },
                loyaltyId: { type: "string", description: "Loyalty account to credit points to" },
              },
              required: ["cart"],
            },
          },
          responses: {
            ok: { status: 200, description: "Member order placed (loyalty points credited)" },
            unauthorized: { status: 401, description: "Missing or invalid member token" },
          },
          "x-suluk-access": { requires: "authenticated" },
          "x-suluk-cost": {
            components: [
              { source: "db-write", basis: "per-call", microUsd: 40 },
              { source: "compute", basis: "per-call", microUsd: 20 },
            ],
          },
        },
      },
    },
    "/ping": {
      requests: {
        ping: {
          method: "get",
          summary: "Ping",
          description: "A single GET — the ordinary, non-colliding case (rendered exactly as before).",
          responses: { ok: { status: 200, description: "pong" } },
          "x-suluk-access": { requires: "anyone" },
        },
      },
    },
  },
} as const;
