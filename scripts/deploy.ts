/**
 * saasuluk → Cloudflare, the @suluk/cloudflare way (no wrangler): reads the built worker + static assets + D1
 * migrations from disk and runs one API-driven deploy() that provisions D1, uploads assets, deploys the worker with
 * its bindings/vars, and pushes secrets from the environment. Run: `bun run deploy:cf` (it builds first).
 *
 * Needs CLOUDFLARE_API_TOKEN in .env — an Account-scoped token with: Workers Scripts (Edit), D1 (Edit), and Account
 * Settings (Read). Optional: CLOUDFLARE_ACCOUNT_ID (else the token's first account is used).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deployWith, CloudflareClient, queryD1, type AssetFile } from "@suluk/cloudflare";
import { SEED_SQL } from "../src/server/seed";

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error("✗ Set CLOUDFLARE_API_TOKEN in saasuluk/.env (Account: Workers Scripts Edit, D1 Edit, Account Settings Read).");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const workerPath = join(root, "worker/dist/worker.js");
const assetsDir = join(root, "dist/client");
if (!existsSync(workerPath) || !existsSync(assetsDir)) {
  console.error("✗ Build first: `bun run build && bun run build:worker` (or use `bun run deploy:cf`).");
  process.exit(1);
}

const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".wasm": "application/wasm",
};
const ctype = (p: string): string => CONTENT_TYPE[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

function collectAssets(dir: string): AssetFile[] {
  const out: AssetFile[] = [];
  (function walk(d: string) {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        out.push({
          path: "/" + relative(dir, full).split(sep).join("/"),
          bytes: new Uint8Array(readFileSync(full)),
          contentType: ctype(full),
        });
    }
  })(dir);
  return out;
}

const migrationsDir = join(root, "migrations");
const migrations = existsSync(migrationsDir)
  ? readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ name: f, sql: readFileSync(join(migrationsDir, f), "utf8") }))
  : [];

const assets = collectAssets(assetsDir);
console.log(`Deploying saasuluk — ${assets.length} assets, ${migrations.length} migration(s)…`);

const res = await deployWith(
  { apiToken: token, accountId: process.env.CLOUDFLARE_ACCOUNT_ID },
  {
    scriptName: "saasuluk",
    module: readFileSync(workerPath, "utf8"),
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    d1: { binding: "DB", databaseName: "saasuluk-db", migrations },
    r2: [{ binding: "MEDIA", bucketName: "saasuluk-media" }], // @suluk/panel media uploads (provisioned + bound)
    kv: [{ binding: "RATE_LIMIT_KV", title: "saasuluk-ratelimit" }], // distributed rate-limit counter (provisioned + bound)
    assets,
    assetsConfig: { html_handling: "auto-trailing-slash" },
    vars: {
      STRIPE_METER_EVENT_NAME: process.env.STRIPE_METER_EVENT_NAME ?? "saasuluk_cost",
      STRIPE_METERED_PRICE_ID: process.env.STRIPE_METERED_PRICE_ID ?? "",
      // owner-recipient list for contact-form + low-stock alerts (non-secret; a var matches its env.ts surface)
      ...(process.env.SUPERADMIN_EMAILS ? { SUPERADMIN_EMAILS: process.env.SUPERADMIN_EMAILS } : {}),
      ...(process.env.LOW_STOCK_THRESHOLD ? { LOW_STOCK_THRESHOLD: process.env.LOW_STOCK_THRESHOLD } : {}),
    },
    secrets: {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_AUDIENCE_ID: process.env.RESEND_AUDIENCE_ID, // newsletter → Resend audience mirror
      EMAIL_FROM: process.env.EMAIL_FROM,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, // powers the @suluk/chat in-page agent
    },
    crons: ["0 * * * *"],
    observability: true,
  },
  (m) => console.log("  " + m),
);

// Re-seed the demo content (idempotent INSERT OR REPLACE — same SQL the dev DB runs on boot), so the live
// products/posts carry their image URLs. Surgical to the seed rows; runs after the schema migrations are applied.
if (res.d1?.id) {
  try {
    const cf = new CloudflareClient({ apiToken: token, accountId: res.accountId });
    await queryD1(cf, res.d1.id, SEED_SQL);
    console.log("  seed: demo content applied (products/posts now carry /img URLs)");
  } catch (e) {
    console.warn("  seed: skipped —", (e as Error).message);
  }
}

console.log(`\n✓ Deployed "${res.scriptName}" to account ${res.accountId}`);
console.log(
  `  D1: ${res.d1?.id ?? "—"} · assets: ${res.assetsUploaded} · secrets: ${res.secretsSet.join(", ") || "none"} · crons: ${res.crons.join(" ") || "none"}`,
);
console.log("  Live at your configured route (e.g. https://saasuluk.saastemly.com).");
