import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";

// Astro renders the marketing/app pages; a middleware delegates /api, /scalar, /superadmin, /cost and
// /openapi.json to the Suluk-powered Hono app (one server). On Cloudflare both run in the same Worker.
export default defineConfig({
  // canonical origin for SEO (canonical links, og:url, sitemap, robots). Override per deploy with SITE_URL.
  site: process.env.SITE_URL ?? "https://saasuluk.dev",
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
});
