# Navigation & prefetch — how it works, and the rules for growing it safely

saasuluk navigates like an SPA (no full reloads, no white flash, dynamic data shown optimistically) on top of an
Astro MPA. Three systems do this. Most of the time you don't touch them — but when you **add a page, a link list, a
piece of chrome, or a data source**, follow the rules below so you don't accidentally break the SPA or melt the
backend as the catalogue grows.

## The three systems

1. **`<ClientRouter />`** (in [`src/layouts/Layout.astro`](../src/layouts/Layout.astro) `<head>`) — intercepts internal
   `<a>` clicks and **swaps the DOM** instead of reloading. This is what kills the white flash.
2. **Prefetch** (`astro.config.mjs` → `prefetch: { prefetchAll: true, defaultStrategy: "load" }` + `experimental.clientPrerender`).
   Every **server-rendered** internal link is **prerendered** (route + all assets, via the Speculation Rules API) the
   moment a page loads, so the click resolves from a warm cache. This is what makes it *feel* instant.
3. **SWR data stores** ([`src/client/stores.ts`](../src/client/stores.ts), `@nanostores/query` on `window.$stores`) —
   dynamic data is cached across navigations, so a return visit paints from cache and revalidates in the background.
   Skeletons only show on a true cold cache.

Shared chrome (header, cart, popovers, toasts, chat, nav-progress) is kept alive across swaps with
`transition:persist`, and theme/scheme/lang/dir are re-applied on `astro:before-swap` so there's no flash.

---

## Rules for growing safely

### 1. Adding a page with a client `<script>`
Under ClientRouter, **bundled `<script>` modules run once per session** and **`<script is:inline>` does NOT re-run on
swap** unless you opt in. So a naive page script will either not re-run (dead page after a soft nav) or, if it declares
top-level `const`/`let`, throw "already declared" on re-run (those land in **global** scope). Pick the matching pattern:

| Page script shape | Pattern |
|---|---|
| Pure fetch-render / form-bind, only touches its own elements | Wrap the body in an **IIFE** + add **`data-astro-rerun`** to the `<script>`. (IIFE is required — it scopes the declarations so re-run is safe.) |
| Uses `define:vars` with per-page data | Emit the data as a `<script type="application/json">` tag (it's in `<main>`, so it swaps per page) and read it inside a function registered on **`astro:page-load`**. `data-astro-rerun` + `define:vars` collide across pages — don't. See [`products/[slug].astro`](../src/pages/products/[slug].astro). |
| Binds `window`/`document` listeners (scroll, `cart-changed`, `keydown`) | **Never** `data-astro-rerun` (it stacks the listener every visit). Either persist the element it belongs to, or remove the listener on `astro:before-swap` (`{ once: true }`). See `checkout.astro`. |
| Reads `window.$stores` | The stores module is deferred; page scripts run during parse first. Guard: `if (window.$stores) start(); else window.addEventListener("suluk:stores-ready", start, { once: true })`. |

Always tear down store subscriptions on leave: `const un = $x.subscribe(...); document.addEventListener("astro:before-swap", un, { once: true })`.

### 2. Adding a worker / non-Astro route (anything served by Hono, not `src/pages/`)
ClientRouter can't DOM-swap a page it doesn't render (Scalar, the admin panel, `/api/*`, raw `.xml`/`.txt`). **Add its
prefix to `WORKER_PREFIXES` in `Layout.astro`.** That single list drives both `data-astro-reload` (forces a clean full
load) and `data-astro-prefetch="false"` (keeps the aggressive prerender from loading Scalar's whole bundle in the
background). If you hardcode such a link in a page body, also stamp it: `<a href="/scalar" data-astro-reload data-astro-prefetch="false">`.

### 3. Adding a list of links — ⚠️ the one that bites at scale
The global strategy is `load` + `clientPrerender`: it **prerenders every server-rendered link on the page**. Great for
the **bounded, curated** chrome (nav, footer, a few CTAs). **Catastrophic for an unbounded list** — a server-rendered
grid of 1,000 products would try to prerender 1,000 pages *and* fire each one's on-load data requests, on every view.

- **Client-injected lists** (rendered via `innerHTML` after load, like the product/blog grids today) are invisible to
  the scan-based `load`/`viewport` strategies, so they don't trip the cliff. To make their clicks fast, drop them in a
  **`[data-prefetch-list]`** container — [`src/client/prefetch.ts`](../src/client/prefetch.ts) warms them with a
  cheap HTML-only `<link rel="prefetch">` on hover/focus intent. Cost scales with what you point at, not list size.
- **Server-rendered lists** (a paginated catalogue, archive, tag cloud, sitemap page): do **not** let them inherit the
  default. Put `data-astro-prefetch="hover"` (or `"false"`) on those links, or wrap them in `[data-prefetch-list]` and
  let `prefetch.ts` handle them. Never bulk-prerender a list that can grow.

Rule of thumb: **prerender = curated & bounded; intent-prefetch = dynamic & unbounded.**

### 4. Adding persistent chrome (a new drawer, banner, widget)
If it holds state or once-bound listeners and should survive navigation, give it a **unique** `transition:persist="<name>"`.
Because it's persisted, its server-rendered content (e.g. an active-link class) **won't update on nav** — re-sync it in
the `astro:page-load` handler in `Layout.astro` (that's how the active nav highlight + scroll state stay correct).

**Do NOT rely on persist alone for chrome whose state comes from an async source** (anything fetched, like the signed-in
account menu). `transition:persist` can be bypassed — a future refactor, or the browser activating a speculation-rules
prerender, hands you a freshly-rendered header. Sync state (theme, cart) re-derives from localStorage at parse with no
flash; async state would flicker to its default (e.g. "Sign in") until a refetch lands. So such chrome must **re-derive
on every `astro:page-load` from a single source of truth**, querying elements fresh each time — see
[`src/client/auth.ts`](../src/client/auth.ts): it paints the account menu from the `su_user` hint (synchronous) +
the cached `$session` store (authoritative), so the login state is correct on every route whether the header was kept,
rebuilt, or prerender-activated — and a flaky `get-session` never signs you out.

### 5. Adding a dynamic data source
Add a fetcher store to `stores.ts` (URL-keyed so pages sharing a key share one cache entry), expose it on
`window.$stores`, and read it cache-first in the page (`subscribe` → render on `.data`, skeleton only on `.loading && !.data`).
Mutations call the store's `.invalidate()`/`.revalidate()` instead of refetching cold.

---

## Backend cost knob (watch as traffic grows)
`load` + `clientPrerender` prerenders curated routes on every page view, and prerendering **executes** each page —
firing its on-load data requests in the background. That's bounded by the number of *routes* (grows slowly), not the
catalogue, but it still multiplies API traffic per human page view. Mitigations, in order:
1. Put cache headers on the API `GET`s so prerender fetches are cheap/served from cache.
2. If it's still too much, lower `defaultStrategy` to `"viewport"` (only prerender what's actually visible).
3. As a last resort, drop `experimental.clientPrerender` (falls back to HTML-only prefetch — instant nav, no early
   data fetches).

## Verifying a change didn't regress the SPA feel
Build (`bun run build`), serve the build (`bun dist/server/entry.mjs`), open it, and check:
- Set `window.__x = 1`, click an internal link, confirm `window.__x` is still `1` afterwards → it was a **swap, not a reload**.
- The header is the same DOM node before/after (persist), the active-nav class tracks the URL, and there's no
  light/LTR/English flash with a dark + RTL locale set.
- New pages: hard-load **and** soft-nav into them; confirm scripts run both ways and don't double-bind (no duplicate
  toasts/handlers, console error count flat across navigations).
- Prefetch: on a page, `document.querySelectorAll('script[type="speculationrules"]')` lists the curated routes and
  **no** worker routes; hovering a `[data-prefetch-list]` card adds a `<link rel="prefetch">` for it.
