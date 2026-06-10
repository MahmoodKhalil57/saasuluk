/**
 * The bridge: Astro owns the pages; the Suluk-powered Hono app owns the API, the docs, the admin, and the
 * cost ledger. This middleware routes those prefixes to Hono and lets everything else fall through to Astro.
 */
import { defineMiddleware } from "astro:middleware";
import { createApp } from "./server/api";

let appPromise: Promise<Awaited<ReturnType<typeof createApp>>["app"]> | undefined;
const getApp = () => (appPromise ??= createApp().then((r) => r.app));

const HONO = ["/api", "/scalar", "/openapi.json", "/superadmin", "/cost", "/project"]; // domain entity bases go here too

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  if (HONO.some((p) => path === p || path.startsWith(p + "/"))) {
    return (await getApp()).fetch(context.request);
  }
  return next();
});
