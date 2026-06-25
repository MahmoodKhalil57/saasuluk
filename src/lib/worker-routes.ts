/**
 * Worker-served (or non-HTML) routes the Astro ClientRouter must NOT soft-swap or speculatively prefetch — it can only
 * DOM-swap view-transitions HTML, and these are served by the Hono Worker (/api, /scalar, /reference, /panel, …) or are
 * .xml/.txt/.json/.svg. Stamping a link `data-astro-reload` + `data-astro-prefetch="false"` makes ClientRouter do a
 * clean full navigation and skips the warm.
 *
 * Mirrors the WORKER_PREFIXES list in src/layouts/Layout.astro (the legacy chrome stamps the same way; its runtime
 * scanner is the post-load safety net, while this render-time stamp also beats the FIRST-load prefetch warmer that runs
 * synchronously before astro:page-load). Keep the two lists in sync.
 */
export const WORKER_PREFIXES = [
  "/api/",
  "/scalar",
  "/swagger",
  "/reference",
  "/superadmin",
  "/cockpit",
  "/panel",
  "/cost",
  "/dashboard",
  "/openapi.json",
  "/mcp",
  "/og.svg",
  "/manifest.webmanifest",
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
];

export const isWorkerHref = (href: string): boolean =>
  typeof href === "string" &&
  WORKER_PREFIXES.some(
    (w) => href === w || href.startsWith(w + "/") || href.startsWith(w + "?") || (w.endsWith("/") && href.startsWith(w)),
  );

/** Attributes to spread onto a worker-route `<a>` (empty object for normal in-app routes). */
export const workerLinkAttrs = (href: string): Record<string, string> =>
  isWorkerHref(href) ? { "data-astro-reload": "", "data-astro-prefetch": "false" } : {};
