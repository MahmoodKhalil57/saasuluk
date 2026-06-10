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
const HONO = [
  "/api", "/scalar", "/openapi.json", "/superadmin", "/cost",
  ...ENTITIES.map((e) => `/${lowerFirst(e.name)}`),
  "/checkout", "/discount", "/search", "/analytics", "/recommendations", "/newsletter", "/avatar",
];
// the rare path that names BOTH an Astro page and an API operation: the page is GET, the operation is POST.
// GET → Astro (the page); any other method → Hono (the operation). Keeps /checkout working as both.
const PAGE_GET_OVERRIDES = new Set(["/checkout"]);

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  if (context.request.method === "GET" && PAGE_GET_OVERRIDES.has(path)) return next(); // serve the page
  if (HONO.some((p) => path === p || path.startsWith(p + "/"))) {
    return (await getApp()).fetch(context.request);
  }
  return next();
});
