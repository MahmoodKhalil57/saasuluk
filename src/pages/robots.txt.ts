/**
 * robots.txt — prerendered at build. Allows crawling of the marketing surface, disallows the private/transactional
 * + API routes, and points at the sitemap using the configured `site` (so it's correct per deploy).
 */
import type { APIRoute } from "astro";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const base = (site?.href ?? "https://saasuluk.dev/").replace(/\/$/, "");
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /account",
    "Disallow: /dashboard",
    "Disallow: /checkout",
    "Disallow: /login",
    "Disallow: /api/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
