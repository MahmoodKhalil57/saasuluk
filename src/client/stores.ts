/**
 * Optimistic data layer — one @nanostores/query SWR instance, created ONCE and shared across DOM-swap navigations.
 *
 * Why a bundled module (not a per-page is:inline script): Astro's ClientRouter runs bundled <script> imports exactly
 * once for the tab session, so this module's `cache` Map survives every soft nav. The per-page is:inline scripts that
 * actually render can't import an ES module instance, so we publish the live store handles on `window.$stores` and
 * fire a `suluk:stores-ready` event (page scripts run during parse, BEFORE this deferred module, so they must wait).
 *
 * Behavior (verified against @nanostores/query@0.3.4 internals): on subscribe a fetcher store reads the shared cache
 * first — within dedupeTime it paints cached data with NO network and NO loading flash; past it, it paints the cached
 * (stale) data immediately AND revalidates in the background (SWR). So a return visit renders synchronously from cache
 * and the skeleton only ever shows on a true cold cache.
 */
import { nanoquery } from "@nanostores/query";

// Our OWN cache Map so we can pre-seed keys the SWR layer hasn't fetched yet (mutateCache only touches keys already
// present, so it cannot seed an unvisited product — see seedProduct).
const cache = new Map<string, { data?: unknown; error?: unknown; created?: number; expires?: number; retryCount?: number }>();

const [createFetcherStore, createMutatorStore, ctx] = nanoquery({
  cache,
  dedupeTime: 4_000, // within 4s a re-subscribe is served straight from cache, no refetch
  cacheLifetime: 300_000, // 5 min before an entry is considered cold
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
});

const json = (url: string, init?: RequestInit) =>
  fetch(url, init).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
const jsonOr = <T>(url: string, fallback: T): Promise<T> =>
  fetch(url)
    .then((r) => (r.ok ? (r.json() as Promise<T>) : fallback))
    .catch(() => fallback);

// URL-keyed list stores — the key IS the cache identity, so any page sharing a key shares one entry.
const $products = createFetcherStore(["/product"], { fetcher: () => json("/product") });
const $categories = createFetcherStore(["/category"], { fetcher: () => jsonOr("/category", [] as unknown[]) });
const $posts = createFetcherStore(["/post"], { fetcher: () => json("/post") });
const $faqs = createFetcherStore(["/faq"], { fetcher: () => json("/faq") });
const $reviews = createFetcherStore(["/review"], { fetcher: () => json("/review") });
// Session: the avatar must NOT flip to "Sign in" on a flaky request. Only a DEFINITIVE answer changes the UI —
// 200 (the session object, or null when genuinely signed out) and 401/403 (signed out). A 5xx / network error THROWS,
// so the store keeps its last-known-good data (SWR) and the header stays as it was instead of bouncing to logged-out.
// (get-session 500s intermittently in prod — the trace caught it twice — and clientPrerender calls it more, so a
// transient failure must never be read as "logged out".) Long cacheLifetime so it isn't re-fetched per navigation.
const $session = createFetcherStore(["/api/auth/get-session"], {
  fetcher: () =>
    fetch("/api/auth/get-session", { credentials: "same-origin" }).then((r) => {
      if (r.ok) return r.json(); // 200 → session object, or null when signed out
      if (r.status === 401 || r.status === 403) return null; // definitively signed out
      throw new Error("session " + r.status); // 5xx / transient — keep the last-known state, do NOT sign out
    }),
  cacheLifetime: 600_000,
});

// Per-id factories, memoized so we don't spin up a fresh store object on every read.
const _productStores = new Map<string, ReturnType<typeof createFetcherStore>>();
const productStore = (id: string | number) => {
  const k = String(id);
  let s = _productStores.get(k);
  if (!s) {
    s = createFetcherStore(["/product/", k], { fetcher: () => json("/product/" + k, { headers: { accept: "application/json" } }) });
    _productStores.set(k, s);
  }
  return s;
};
const _recStores = new Map<string, ReturnType<typeof createFetcherStore>>();
const recommendations = (id: string | number) => {
  const k = String(id);
  let s = _recStores.get(k);
  if (!s) {
    s = createFetcherStore(["/recommendations/", k], { fetcher: () => json("/recommendations/" + k) });
    _recStores.set(k, s);
  }
  return s;
};

/**
 * Optimistic list→detail handoff. The store list already has each product's row, so on a card click we write that row
 * straight into the cache under the detail key (`/product/<id>`). created:0 marks it stale, so the detail store paints
 * the seeded row on first subscribe AND revalidates live (inventory) in the background. We never clobber a row that
 * was already fetched fresh.
 */
function seedProduct(row: { id?: number | string } | null | undefined) {
  if (!row || row.id == null) return;
  const key = "/product/" + String(row.id);
  const existing = cache.get(key);
  if (existing && existing.data !== undefined) return;
  cache.set(key, { data: row, created: 0, expires: Date.now() + 300_000 });
}

const stores = {
  ctx,
  cache,
  $products,
  $categories,
  $posts,
  $faqs,
  $reviews,
  $session,
  productStore,
  recommendations,
  seedProduct,
  createFetcherStore,
  createMutatorStore,
};

// Publish for the per-page is:inline readers and signal readiness (they run during parse, before this deferred module).
(window as unknown as { $stores: typeof stores }).$stores = stores;
window.dispatchEvent(new Event("suluk:stores-ready"));

export default stores;
export { $products, $categories, $posts, $faqs, $reviews, $session, productStore, recommendations, seedProduct, ctx, cache };
