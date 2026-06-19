import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import icon from "astro-icon";

// Astro renders the marketing/app pages; a middleware delegates /api, /scalar, /superadmin, /cost and
// /openapi.json to the Suluk-powered Hono app (one server). On Cloudflare both run in the same Worker.
export default defineConfig({
  // canonical origin for SEO (canonical links, og:url, sitemap, robots). Override per deploy with SITE_URL.
  // Fallback is the LIVE origin — saasuluk.dev was a dead placeholder, so every canonical/og/sitemap/JSON-LD URL 404'd.
  site: process.env.SITE_URL ?? "https://saasuluk.saastemly.com",
  output: "server",
  adapter: node({ mode: "standalone" }),
  // astro-icon (issue #6): build-time, local Iconify JSON — inlines only the referenced icons as currentColor SVGs.
  // No runtime/CDN fetch (offline-safe). Icon names funnel through src/icons.ts so swapping a set is a one-liner.
  integrations: [react(), icon()],
  // SvelteKit-feel navigation: ClientRouter (rendered in Layout.astro <head>) swaps the DOM instead of reloading.
  // prefetch with defaultStrategy:"load" is the most aggressive warm — EVERY internal <a> on the page is prefetched
  // immediately on load (not just when it scrolls into view). clientPrerender upgrades each warm from an HTML-only
  // <link rel=prefetch> to the Speculation Rules API — the browser prerenders the route AND all its assets with
  // eagerness "immediate" (Chromium throttles concurrency), falling back to a plain prefetch elsewhere. So every
  // linked route is rendered-and-ready before the click. Worker-served routes (/scalar, /reference, /dashboard…) are
  // excluded via data-astro-prefetch="false" + data-astro-reload (stamped server-side in Layout.astro's nav/footer).
  prefetch: { prefetchAll: true, defaultStrategy: "load" },
  experimental: { clientPrerender: true },
});
