# saasuluk

A **SaaS starter on Astro + Hono, powered end-to-end by [Suluk](https://github.com/MahmoodKhalil57/suluk)** —
the OpenAPI v4 "Moonwalk" candidate framework. A homage to `saastarter`, reimplemented from the bottom up so
that **every layer is derived from one typed contract**: declare your data (Drizzle) and routes (Hono + Zod)
once, and the OpenAPI v4 document, Scalar docs, the typed client, the shadcn UI, request validation, the admin
panel, the cost ledger, and the Cloudflare deploy plan are all _projections_ of it. They can't drift — they're
the same source.

> Suluk is a **candidate** exploration of OpenAPI v4, not the official specification. saasuluk is its
> first-class template.

## Feature map — saastarter → Suluk

| saastarter (Next.js)                                                                          | saasuluk (Astro + Hono)                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better-Auth                                                                                   | **Better Auth** via `@suluk/better-auth` (wired into the v4 contract: securitySchemes + its OpenAPI ingested)                                                                             |
| Ecommerce (products, variants, categories, carts, orders, discount codes, reviews, wishlists) | **entities in the contract** — declared once in `src/server/schema.ts`, registered in `src/server/domain.ts`; CRUD API + docs + admin + client + UI + cost project automatically          |
| Blog, FAQs, newsletter, contact, media                                                        | the same: content **entities**, not bespoke collections                                                                                                                                   |
| Checkout, discounts, search, recommendations, analytics                                       | **custom operations** (`src/server/operations.ts`) — one factory, mounted in dev + the Worker, merged into the contract (Scalar + cost)                                                   |
| Cart / checkout / orders pages, blog, account, FAQ, contact, legal, metrics                   | **Astro pages** over the typed contract (`src/pages/*`) — storefront, reviews, wishlist, analytics dashboard                                                                              |
| API tokens / developer portal                                                                 | a real **token operation**: `/tokens/create` generates → hashes → returns once; a `Bearer sk_…` authenticates + owner-stamps + meters; `/tokens/:id/revoke`                               |
| Resend email                                                                                  | **Resend over fetch** (Worker-safe, graceful) — newsletter welcome + magic-link; `src/server/email.ts`                                                                                    |
| Passkey / passwordless                                                                        | **magic-link** sign-in (Better Auth) via the email module; passkey is a documented drop-in (`@better-auth/passkey`)                                                                       |
| i18n (en/ar/es, RTL)                                                                          | **client-side i18n** (`src/i18n.ts`) — one dictionary, a language switcher, RTL for Arabic, persisted                                                                                     |
| next-themes (dark mode)                                                                       | a **light/dark toggle** (CSS vars, persisted, applied pre-paint)                                                                                                                          |
| PWA                                                                                           | a **manifest + service worker** (offline shell) + maskable favicon                                                                                                                        |
| @dicebear avatars                                                                             | a **derived identicon** SVG (`/avatar?seed=…`) — dependency-free                                                                                                                          |
| PayloadCMS collections / ecommerce plugin                                                     | the **entity registry** (`domain.ts`) — one typed source instead of ~14 collection configs + a plugin                                                                                     |
| Stripe payments                                                                               | **Stripe Checkout** (real hosted checkout + signature-verified webhook) via the REST API                                                                                                  |
| Usage-based billing                                                                           | **@suluk/cost → Stripe Billing Meters** — connect a customer + metered subscription, report accrued cost as meter events (`/billing/connect`, `/billing/report`); the dashboard drives it |
| PayloadCMS admin                                                                              | the **`/superadmin` cockpit** via `@suluk/admin` (same brain as the Suluk VSCode extension)                                                                                               |
| openapi-typescript / openapi-fetch                                                            | the **typed client** via `@suluk/nano-stores` (Zod-guarded fetcher/mutator stores)                                                                                                        |
| OpenAPI generation                                                                            | the **v4 document** via `@suluk/hono` + `@suluk/drizzle` (derived from the schema)                                                                                                        |
| Postgres / PGlite                                                                             | **Drizzle on sqlite/D1** via `@suluk/drizzle` (sqlite-core _is_ Cloudflare D1)                                                                                                            |
| shadcn UI                                                                                     | **generated** forms/tables via `@suluk/shadcn`                                                                                                                                            |
| Vercel deploy                                                                                 | **Cloudflare** (Workers + D1 + assets) via `@suluk/deploy`                                                                                                                                |
| — (new)                                                                                       | **cost tracking**: every request's cost traced from the frontend action → operation → third party, shown raw at `/cost`                                                                   |

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

Navigation is SPA-style (Astro `ClientRouter` + aggressive prerender + persisted SWR stores) — instant, no flash,
optimistic data. Before adding a page, a link list, or a data source, read **[docs/navigation.md](docs/navigation.md)**:
it documents the patterns and the one place aggressive prefetch can bite as the catalogue grows.

## Deploy (Cloudflare)

The stack is Cloudflare-native: Hono → Workers, Drizzle(sqlite-core) → D1, the Astro build → assets.
`@suluk/deploy` generates the `wrangler.jsonc` + worker entry + D1 schema + the ordered `wrangler` steps.

## Notes

- **`@suluk/*` resolution:** this template installs the **published** `@suluk/*` packages from npm as normal
  dependencies — nothing local. Run `bun install` and you have the whole framework. (There are no `tsconfig.json`
  `paths` aliases to a sibling monorepo anymore.)
- **Run with Bun:** the data layer uses `bun:sqlite`, so run the built server with `bun dist/server/entry.mjs`
  (the `start` script), not `node`.
- **Live auth/payments need config** (a real `BETTER_AUTH_SECRET` + `better-auth migrate`, and Stripe keys) —
  same as any SaaS starter. The Suluk-derived surface (API · docs · admin · cost) works out of the box.
