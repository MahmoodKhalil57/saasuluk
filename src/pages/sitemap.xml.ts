/**
 * sitemap.xml — prerendered at build via @suluk/seo. Emits the public marketing routes PLUS every published
 * product and blog post (with its image), so the whole catalog is discoverable — not just the static pages.
 * Uses the configured `site` so URLs match the <head> canonical links. Private/transactional routes excluded.
 */
import type { APIRoute } from "astro";
import { sitemapXml, type SitemapUrl } from "@suluk/seo";
import { SEED_PRODUCTS, SEED_POSTS } from "../server/seed";

export const prerender = true;

const PAGES: { path: string; priority?: number; changefreq?: SitemapUrl["changefreq"] }[] = [
  { path: "", priority: 1.0, changefreq: "daily" },
  { path: "products", priority: 0.9, changefreq: "daily" },
  { path: "pricing", priority: 0.8, changefreq: "weekly" },
  { path: "blogs", priority: 0.7, changefreq: "weekly" },
  { path: "about", priority: 0.5 }, { path: "contact", priority: 0.5 }, { path: "faqs", priority: 0.6 },
  { path: "metrics", priority: 0.3 }, { path: "reference", priority: 0.4 },
  { path: "terms", priority: 0.2 }, { path: "privacy", priority: 0.2 }, { path: "license", priority: 0.2 },
];

export const GET: APIRoute = ({ site }) => {
  const base = (site?.href ?? "https://saasuluk.dev/").replace(/\/$/, "");
  const urls: SitemapUrl[] = [
    ...PAGES.map((p) => ({ loc: `${base}/${p.path}`, changefreq: p.changefreq ?? "weekly", priority: p.priority })),
    ...SEED_PRODUCTS.filter((p) => p.status === "published").map((p) => ({
      loc: `${base}/products/${p.slug}`, changefreq: "weekly" as const, priority: 0.8,
      images: [{ loc: `${base}/img/products/${p.slug}.jpg`, title: p.name }],
    })),
    ...SEED_POSTS.map((p) => ({
      loc: `${base}/blogs/${p.slug}`, changefreq: "monthly" as const, priority: 0.6,
      images: [{ loc: `${base}/img/blog/${p.slug}.jpg`, title: p.title }],
    })),
  ];
  return new Response(sitemapXml(urls), { headers: { "content-type": "application/xml; charset=utf-8" } });
};
