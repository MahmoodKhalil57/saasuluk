# saasuluk

A **SaaS starter on Astro + Hono, powered end-to-end by [Suluk](https://github.com/MahmoodKhalil57/sig-moonwalk)** —
the OpenAPI v4 "Moonwalk" candidate framework. A homage to `saastarter`, reimplemented from the bottom up so
that **every layer is derived from one typed contract**: declare your data (Drizzle) and routes (Hono + Zod)
once, and the OpenAPI v4 document, Scalar docs, the typed client, the shadcn UI, request validation, the admin
panel, the cost ledger, and the Cloudflare deploy plan are all *projections* of it. They can't drift — they're
the same source.

> Suluk is a **candidate** exploration of OpenAPI v4, not the official specification. saasuluk is its
> first-class template.

## Feature map — saastarter → Suluk

| saastarter (Next.js) | saasuluk (Astro + Hono) |
|---|---|
| Better-Auth | **Better Auth** via `@suluk/better-auth` (wired into the v4 contract: securitySchemes + its OpenAPI ingested) |
| Stripe payments | **Stripe** via `@suluk/stripe` (Billing Meters) + **usage** via `@suluk/cost` |
| PayloadCMS admin | the **`/superadmin` cockpit** via `@suluk/admin` (same brain as the Suluk VSCode extension) |
| openapi-typescript / openapi-fetch | the **typed client** via `@suluk/nano-stores` (Zod-guarded fetcher/mutator stores) |
| OpenAPI generation | the **v4 document** via `@suluk/hono` + `@suluk/drizzle` (derived from the schema) |
| Postgres / PGlite | **Drizzle on sqlite/D1** via `@suluk/drizzle` (sqlite-core *is* Cloudflare D1) |
| shadcn UI | **generated** forms/tables via `@suluk/shadcn` |
| Vercel deploy | **Cloudflare** (Workers + D1 + assets) via `@suluk/deploy` |
| — (new) | **cost tracking**: every request's cost traced from the frontend action → operation → third party, shown raw at `/cost` |

## Quick start

```sh
bun install
cp .env.example .env        # add a BETTER_AUTH_SECRET (openssl rand -base64 32); Stripe keys are optional
bun run dev                 # Astro + the Suluk/Hono API on http://localhost:3000
```

Then open:

- `/` · `/dashboard` · `/pricing` — the Astro pages
- `/scalar` — the API docs (Scalar over the v4 document; shows declared cost + auth)
- `/superadmin` — the cockpit (gated: send `x-role: superadmin`)
- `/openapi.json` — the v4 document · `/cost` — the raw cost ledger
- `/api/auth/*` — Better Auth · `/api/health`

API-only (no frontend build): `bun run dev:api`.

## How it works

```
Drizzle (project)  ──▶  contract (Hono + Zod + Better Auth)  ──▶  v4 document (the hub)
   src/server/db.ts          src/server/contract.ts                 │
                                                                    ├──▶ Scalar / Swagger      (/scalar)
   src/server/api.ts mounts it all on Hono;                         ├──▶ /superadmin cockpit
   src/middleware.ts delegates /api,/scalar,/superadmin,/cost       ├──▶ cost ledger           (/cost)
   and the domain routes to Hono — Astro owns the pages.            └──▶ generated client + UI (@suluk/*)
```

Each request is metered (`@suluk/cost`): `src/server/api.ts` attributes cost to the user (`x-user`) and the
frontend action (`x-suluk-action`, set by the dashboard buttons) down to each source. You see the cost as it
is; pricing is the cost plus your margin (`@suluk/stripe` reports the usage to Stripe Billing Meters).

## Deploy (Cloudflare)

The stack is Cloudflare-native: Hono → Workers, Drizzle(sqlite-core) → D1, the Astro build → assets.
`@suluk/deploy` generates the `wrangler.jsonc` + worker entry + D1 schema + the ordered `wrangler` steps.

## Notes

- **`@suluk/*` resolution:** this template references the Suluk monorepo's package sources via `tsconfig.json`
  `paths` (the repo is expected as a sibling at `../sig-moonwalk`). Once Suluk is published, swap these for
  normal dependencies.
- **Run with Bun:** the data layer uses `bun:sqlite`, so run the built server with `bun dist/server/entry.mjs`
  (the `start` script), not `node`.
- **Live auth/payments need config** (a real `BETTER_AUTH_SECRET` + `better-auth migrate`, and Stripe keys) —
  same as any SaaS starter. The Suluk-derived surface (API · docs · admin · cost) works out of the box.
