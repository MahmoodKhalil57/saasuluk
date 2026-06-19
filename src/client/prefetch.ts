/**
 * Intent-prefetch for DYNAMIC, high-cardinality link lists — product/blog grids, related/recent strips, search
 * results: anything rendered client-side into a `[data-prefetch-list]` container.
 *
 * Why this exists (and why it's separate from the global astro.config prefetch):
 *  - The global strategy is `load` + clientPrerender, which fully PRERENDERS every link (route + assets). That's
 *    perfect for the BOUNDED, curated chrome (nav, footer, CTAs) but must NOT be inherited by unbounded lists — a
 *    1,000-product grid would try to prerender 1,000 pages (and fire 1,000× their on-load data requests) on view.
 *  - Astro's scan-based `load`/`viewport` strategies also never SEE these links anyway: the grids are injected via
 *    innerHTML AFTER page-load, so the one-time scan misses them.
 *
 * So for these lists we do the opposite of the global default — the cheapest thing that still makes the click feel
 * instant: a plain `<link rel="prefetch">` of the (static) target HTML, fired on hover/focus INTENT, via event
 * delegation (so it catches injected links). HTML-only means no JS executes and no data requests fire during the
 * warm — the detail page's own fetches happen normally when you actually navigate. Cost scales with what you point
 * at, not with catalog size. This is the canonical pattern for any list that can grow large — see docs/navigation.md.
 */
const warmed = new Set<string>();

function warm(href: string) {
  if (!href || warmed.has(href)) return;
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin || u.pathname === location.pathname) return; // same-origin, not the current page
  } catch {
    return;
  }
  warmed.add(href);
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "document";
  link.href = href;
  document.head.appendChild(link);
}

let timer: number | undefined;
function onIntent(e: Event) {
  const target = e.target as HTMLElement | null;
  const a = target?.closest?.("[data-prefetch-list] a[href^='/']") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") || "";
  clearTimeout(timer);
  timer = window.setTimeout(() => warm(href), 90); // small debounce so a fast cursor sweep doesn't warm everything
}

// Delegated on the document so it works for links injected after page-load and survives ClientRouter swaps (document
// is never replaced). pointerover bubbles (mouse intent); focusin covers keyboard intent.
document.addEventListener("pointerover", onIntent, { passive: true });
document.addEventListener("focusin", onIntent, { passive: true });
