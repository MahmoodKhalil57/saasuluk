/**
 * The slugs prerendered for the dynamic detail routes (`products/[slug]`, `blogs/[slug]`). On a static frontend
 * (Cloudflare assets, no SSR) a dynamic route needs its paths known at build time — these mirror the seed
 * (src/server/seed.ts). The detail pages fetch their data CLIENT-SIDE by slug, so each built page is the same
 * shell; this just enumerates which shells to emit. New items added via /superadmin are reachable through the
 * API; give them a static page by adding their slug here (or move to an SSR adapter).
 */
export const PRODUCT_SLUGS = [
  "frontend-lite", "frontend-pro", "fullstack-lite", "fullstack-pro",
  "ecommerce-module", "auth-module", "cost-ledger", "admin-cockpit", "stripe-billing", "saasuluk-starter",
];
export const POST_SLUGS = ["one-contract", "cost-as-a-fact", "meta-store"];
