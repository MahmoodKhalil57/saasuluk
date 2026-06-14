import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";

// Astro renders the marketing/app pages; a middleware delegates /api, /scalar, /superadmin, /cost and
// /openapi.json to the Suluk-powered Hono app (one server). On Cloudflare both run in the same Worker.
export default defineConfig({
  // canonical origin for SEO (canonical links, og:url, sitemap, robots). Override per deploy with SITE_URL.
  // Fallback is the LIVE origin — saasuluk.dev was a dead placeholder, so every canonical/og/sitemap/JSON-LD URL 404'd.
  site: process.env.SITE_URL ?? "https://saasuluk.saastemly.com",
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
});
