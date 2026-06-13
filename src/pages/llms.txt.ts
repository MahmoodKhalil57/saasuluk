/**
 * /llms.txt (llmstxt.org) — a curated, LLM-friendly map of the site, generated via @suluk/seo from the same seed
 * that renders the store. Lets an AI agent understand and navigate saasuluk: products, posts, the live API, docs.
 */
import type { APIRoute } from "astro";
import { llmsTxt } from "@suluk/seo";
import { SEED_PRODUCTS, SEED_POSTS } from "../server/seed";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const base = (site?.href ?? "https://saasuluk.dev/").replace(/\/$/, "");
  const body = llmsTxt({
    title: "saasuluk",
    summary: "A premium ecommerce + SaaS starter where every layer — data, API, docs, typed client, UI, admin, cost — is projected from ONE OpenAPI v4 contract. Built on Suluk (Astro + Hono + Drizzle on Cloudflare).",
    details: "saasuluk sells the very code that renders it — the products below are real slices of this repository. The whole API is live and typed; the cost of every request is metered to a public ledger.",
    sections: [
      { title: "Products", links: SEED_PRODUCTS.filter((p) => p.status === "published").map((p) => ({ title: p.name, url: `${base}/products/${p.slug}`, description: p.description })) },
      { title: "Blog", links: SEED_POSTS.map((p) => ({ title: p.title, url: `${base}/blogs/${p.slug}`, description: p.excerpt })) },
      { title: "Developers", links: [
        { title: "API reference (OpenAPI v4)", url: `${base}/reference`, description: "The live, contract-projected reference" },
        { title: "OpenAPI document", url: `${base}/openapi.json`, description: "The canonical v4 document" },
        { title: "Typed SDK", url: `${base}/sdk.ts`, description: "A generated ofetch SDK" },
        { title: "Cost ledger", url: `${base}/cost`, description: "Real per-request cost, metered" },
      ] },
      { title: "MCP (agent tools)", links: [
        { title: "MCP server", url: `${base}/mcp`, description: "Model Context Protocol endpoint (Streamable-HTTP, POST JSON-RPC). The same OpenAPI v4 contract projected into read-only tools — list/get products, posts, and categories. Call `initialize` then `tools/list`." },
      ] },
      { title: "Pages", links: [
        { title: "Pricing", url: `${base}/pricing` }, { title: "About", url: `${base}/about` },
        { title: "FAQ", url: `${base}/faqs` }, { title: "Contact", url: `${base}/contact` },
      ] },
    ],
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
