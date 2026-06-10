/**
 * The bridge (Bun-hosted SSR mode): Astro owns the pages; the Suluk-powered Hono app owns the API, docs,
 * admin, and cost. We import the server DYNAMICALLY so a static build (which runs partly under Node) doesn't
 * pull bun:sqlite into the graph — on Cloudflare the static pages are assets and the Worker owns the API.
 */
import { defineMiddleware } from "astro:middleware";

let appPromise: Promise<{ fetch: (req: Request) => Response | Promise<Response> }> | undefined;
const getApp = async () => {
  if (!appPromise) appPromise = import("./server/api").then((m) => m.createApp()).then((r) => r.app);
  return appPromise;
};

const HONO = ["/api", "/scalar", "/openapi.json", "/superadmin", "/cost", "/project"];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  if (HONO.some((p) => path === p || path.startsWith(p + "/"))) {
    return (await getApp()).fetch(context.request);
  }
  return next();
});
