/**
 * The bridge (Bun-hosted SSR mode): Astro owns the pages; the Suluk-powered Hono app owns the API, docs,
 * admin, and cost. The set of API paths is DERIVED from the same entity registry the contract is — so adding an
 * entity in domain.ts makes its CRUD reachable here automatically, no list to maintain. We import the *server*
 * dynamically so a static build (partly Node) doesn't pull bun:sqlite into the graph; the registry import is
 * bun:sqlite-free, so it is safe to import statically.
 */
import { defineMiddleware } from "astro:middleware";
import { ENTITIES } from "./server/domain";

let appPromise: Promise<{ fetch: (req: Request) => Response | Promise<Response> }> | undefined;
const getApp = async () => {
  if (!appPromise) appPromise = import("./server/api").then((m) => m.createApp()).then((r) => r.app);
  return appPromise;
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
// every entity's CRUD path (e.g. /product, /order, /wishlistItem) + the infra + custom-operation prefixes.
// Pages live at DISTINCT routes (plural: /products, /blogs, /faqs) so they never shadow a singular entity API.
// Operation paths live at routes DISTINCT from any page so a static asset never shadows them on Cloudflare
// (where assets are served before the worker and reject non-GET). Notably the checkout OPERATION is
// `/checkout/order`, not `/checkout` — the latter is the checkout PAGE. So no path is both a page and an op.
const HONO = [
  "/api", "/scalar", "/openapi.json", "/superadmin", "/cost",
  ...ENTITIES.map((e) => `/${lowerFirst(e.name)}`),
  "/checkout/order", "/checkout/pay", "/checkout/confirm", "/billing", "/discount", "/search", "/analytics", "/recommendations", "/newsletter", "/avatar", "/tokens",
];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname.replace(/(.)\/$/, "$1"); // normalize a trailing slash (prerender hits "/x/")
  if (HONO.some((p) => path === p || path.startsWith(p + "/"))) {
    return (await getApp()).fetch(context.request);
  }
  return next();
});
