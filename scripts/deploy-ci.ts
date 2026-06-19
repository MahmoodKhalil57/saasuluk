#!/usr/bin/env bun
/**
 * `wrangler deploy`, made robust against a known post-deploy quirk.
 *
 * With an ACCOUNT-scoped Cloudflare API token + a custom-domain-only Worker, wrangler still POSTs to the workers.dev
 * `/subdomain` endpoint AFTER it has already uploaded + deployed the new version — and that one call 403s
 * [code: 10000] because an account token can't manage the workers.dev subdomain. wrangler then exits 1 even though
 * the deploy actually landed. (workers_dev:false in wrangler.jsonc doesn't suppress the call.)
 *
 * So: if wrangler exits non-zero, we VERIFY by fetching the live site's /api/health and comparing its build id to this
 * commit's BUILD_ID. If they match, the deploy succeeded and we exit 0. Any other mismatch/error is a real failure.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const code = spawnSync("bunx", ["wrangler", "deploy"], { stdio: "inherit", env: process.env }).status ?? 1;
if (code === 0) process.exit(0);

const buildId = (readFileSync("src/build-id.ts", "utf8").match(/BUILD_ID = "([^"]+)"/) || [])[1];
const domain = (readFileSync("wrangler.jsonc", "utf8").match(/"pattern":\s*"([^"]+)"/) || [])[1];
if (!buildId || !domain) {
  console.error(`✗ wrangler exited ${code} and we couldn't read BUILD_ID/domain to verify — treating as a failure.`);
  process.exit(code);
}

// POLL — Cloudflare's edge can take a few seconds to serve the new version, so a single immediate check can read the
// PREVIOUS build and false-fail. Retry for ~40s; succeed the moment the live build matches this commit.
console.log(`\n• wrangler exited ${code}; verifying the deploy landed via https://${domain}/api/health (expecting build ${buildId}) …`);
let live: string | undefined;
for (let attempt = 1; attempt <= 10; attempt++) {
  try {
    const r = await fetch(`https://${domain}/api/health`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    live = ((await r.json()) as { build?: string }).build;
    if (live === buildId) {
      console.log(`✓ Deploy verified LIVE (build ${live}, after ${attempt} check${attempt > 1 ? "s" : ""}). wrangler's`);
      console.log(`  non-zero exit was the workers.dev /subdomain step an account-scoped token can't touch — harmless`);
      console.log(`  for a custom-domain deploy.`);
      process.exit(0);
    }
  } catch {
    /* edge not ready / transient — keep polling */
  }
  if (attempt < 10) await new Promise((res) => setTimeout(res, 4000));
}
console.error(`✗ Live build is ${live ?? "?"}, expected ${buildId} after polling ~40s — the deploy did NOT land.`);
process.exit(code);
