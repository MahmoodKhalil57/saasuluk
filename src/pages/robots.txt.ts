/**
 * robots.txt — prerendered at build via @suluk/seo. Allows the marketing surface, disallows the private/
 * transactional + API routes, and advertises the sitemap using the configured `site` (correct per deploy).
 */
import type { APIRoute } from "astro";
import { robotsTxt } from "@suluk/seo";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const base = (site?.href ?? "https://saasuluk.dev/").replace(/\/$/, "");
  const body = robotsTxt({
    groups: [{ userAgent: "*", allow: ["/"], disallow: ["/account", "/dashboard", "/panel", "/checkout", "/login", "/api/"] }],
    sitemaps: [`${base}/sitemap.xml`],
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
