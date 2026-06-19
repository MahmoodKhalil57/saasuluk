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

console.log(`\n• wrangler exited ${code}; verifying the deploy landed via https://${domain}/api/health (expecting build ${buildId}) …`);
try {
  const r = await fetch(`https://${domain}/api/health`, { signal: AbortSignal.timeout(15_000) });
  const live = (await r.json()) as { build?: string };
  if (live.build === buildId) {
    console.log(`✓ Deploy verified LIVE (build ${live.build}). wrangler's non-zero exit was the workers.dev /subdomain`);
    console.log(`  step an account-scoped token can't touch — harmless for a custom-domain deploy.`);
    process.exit(0);
  }
  console.error(`✗ Live build is ${live.build ?? "?"}, expected ${buildId} — the deploy did NOT land.`);
} catch (e) {
  console.error(`✗ Could not verify the deploy:`, e instanceof Error ? e.message : e);
}
process.exit(code);
