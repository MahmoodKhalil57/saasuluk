/**
 * sitemap.xml — prerendered at build (static-assets topology), emitted from the public marketing routes. Uses
 * the configured `site` (astro.config → SITE_URL) so canonical URLs match the <head> canonical links. Private +
 * transactional routes (account/dashboard/checkout/login) and the API are intentionally excluded.
 */
import type { APIRoute } from "astro";

export const prerender = true;

const ROUTES = ["", "products", "pricing", "blogs", "about", "contact", "faqs", "metrics", "reference", "terms", "privacy", "license"];

export const GET: APIRoute = ({ site }) => {
  const base = (site?.href ?? "https://saasuluk.dev/").replace(/\/$/, "");
  const urls = ROUTES.map((r) => `  <url><loc>${base}/${r}</loc><changefreq>weekly</changefreq></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
