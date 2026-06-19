/**
 * Deploy the **Suluk v4 editor** (editor.suluk.saastemly.com) — an INDEPENDENT static Cloudflare worker, separate from
 * the saasuluk app worker. It serves three assets: the editor page (from @suluk/editor's editorHtml), the package's
 * client bundle, and the suluk Scalar fork. No D1/KV/R2/secrets/cron — it's a pure static site (client-only; see C033).
 *
 * Reuses saasuluk's CLOUDFLARE_API_TOKEN (the repo that holds the Cloudflare creds) but is its own script + domain, so
 * it is not coupled to the demo app. Run: `bun run deploy:editor`.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deployWith, CloudflareClient, type AssetFile } from "@suluk/cloudflare";
import { editorHtml } from "@suluk/editor";

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error("✗ Set CLOUDFLARE_API_TOKEN in saasuluk/.env (Workers Scripts: Edit; Zone: Read for the custom domain).");
  process.exit(1);
}

const SCRIPT = "suluk-editor";
const HOSTNAME = "editor.suluk.saastemly.com";
const ZONE = "saastemly.com";

const root = new URL("..", import.meta.url).pathname;
const clientBundle = join(root, "node_modules/@suluk/editor/dist/editor.client.js");
const forkBundle = join(root, "public/vendor/scalar/standalone-suluk.js");
for (const [label, p] of [
  ["@suluk/editor client bundle", clientBundle],
  ["Scalar fork bundle", forkBundle],
] as const) {
  if (!existsSync(p)) {
    console.error(`✗ Missing ${label}: ${p}\n  (run \`bun install\` and \`bun run scripts/vendor-scalar.ts\`).`);
    process.exit(1);
  }
}

// The page references the two bundles at the site root; serve all three from the ASSETS binding.
const page = editorHtml({
  brand: "Suluk",
  pageTitle: "Suluk — OpenAPI v4 editor",
  forkSrc: "/standalone-suluk.js",
  clientSrc: "/editor.client.js",
});
const enc = new TextEncoder();
const assets: AssetFile[] = [
  { path: "/index.html", bytes: enc.encode(page), contentType: "text/html" },
  { path: "/editor.client.js", bytes: new Uint8Array(readFileSync(clientBundle)), contentType: "text/javascript" },
  { path: "/standalone-suluk.js", bytes: new Uint8Array(readFileSync(forkBundle)), contentType: "text/javascript" },
];

// Minimal assets-only worker: hand every request to the static ASSETS binding (index.html at "/", etc.).
const workerModule = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };`;

console.log(`Deploying ${SCRIPT} — ${assets.length} assets (${(assets.reduce((n, a) => n + a.bytes.length, 0) / 1e6).toFixed(2)} MB)…`);

const res = await deployWith(
  { apiToken: token, accountId: process.env.CLOUDFLARE_ACCOUNT_ID },
  {
    scriptName: SCRIPT,
    module: workerModule,
    compatibilityDate: "2026-06-01",
    assets,
    assetsConfig: { html_handling: "auto-trailing-slash", not_found_handling: "single-page-application" },
    observability: true,
  },
  (m) => console.log("  " + m),
);

const cf = new CloudflareClient({ apiToken: token, accountId: res.accountId });

// Enable the workers.dev URL for immediate verification (independent of the custom-domain cert provisioning lag).
let workersDev = "";
try {
  const sub = await cf.request<{ subdomain?: string }>("GET", `/accounts/${res.accountId}/workers/subdomain`);
  await cf.request("POST", `/accounts/${res.accountId}/workers/scripts/${SCRIPT}/subdomain`, {
    json: { enabled: true, previews_enabled: false },
  });
  if (sub?.subdomain) workersDev = `https://${SCRIPT}.${sub.subdomain}.workers.dev`;
} catch (e) {
  console.warn("  workers.dev: skipped —", (e as Error).message);
}

// Attach the custom domain editor.suluk.saastemly.com (idempotent PUT). Needs Zone:Read + Workers Routes:Edit on the token.
let customDomain = "";
try {
  const zones = await cf.request<Array<{ id: string; name: string }>>("GET", "/zones", { query: { name: ZONE } });
  const zone = zones?.find((z) => z.name === ZONE);
  if (!zone) throw new Error(`zone ${ZONE} not visible to this token`);
  await cf.request("PUT", `/accounts/${res.accountId}/workers/domains`, {
    json: { environment: "production", hostname: HOSTNAME, service: SCRIPT, zone_id: zone.id },
  });
  customDomain = `https://${HOSTNAME}`;
  console.log(`  custom domain attached: ${HOSTNAME} → ${SCRIPT} (zone ${zone.id.slice(0, 6)}…)`);
} catch (e) {
  console.warn(`  custom domain: NOT attached — ${(e as Error).message}`);
  console.warn(`    Attach once via dashboard (Workers → ${SCRIPT} → Triggers → Custom Domains) or:`);
  console.warn(`    wrangler triggers ... / add { pattern: "${HOSTNAME}", custom_domain: true } to a wrangler config for ${SCRIPT}.`);
}

console.log(`\n✓ Deployed "${res.scriptName}" to account ${res.accountId} · assets: ${res.assetsUploaded}`);
if (workersDev) console.log(`  workers.dev:   ${workersDev}`);
console.log(`  custom domain: ${customDomain || "https://" + HOSTNAME + "  (pending manual attach / cert)"}`);
