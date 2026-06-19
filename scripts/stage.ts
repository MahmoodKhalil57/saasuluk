#!/usr/bin/env bun
/**
 * CI stage runner with commit receipts.
 *
 * Runs one named stage's command and, ON SUCCESS, stamps the current commit with a lightweight git tag
 * `passed/<stage>/<shortSha>` (and pushes it, best-effort) so every commit carries a receipt of which stages passed.
 * The GitHub Actions workflows AND the local `wrkflw` runs both call `bun run stage <name>`, so cloud and local agree.
 *
 *   bun run stage lint          # runs `bun run lint`, then tags passed/lint/<sha> if it exited 0
 *   bun run stage deploy        # runs the deploy, then tags passed/deploy/<sha>
 *
 * Env:
 *   CI_PUSH_TAGS=0   # create the tag locally but DON'T push it to origin (default: push)
 *   CI_TAG_PREFIX=…  # override the "passed" namespace
 */
import { spawnSync } from "node:child_process";

// Each stage maps to a package.json script (kept here as the single source of truth for the CI pipeline order).
const STAGES: Record<string, string> = {
  format: "format:check",
  lint: "lint",
  typecheck: "typecheck",
  suluk: "check:suluk",
  test: "test",
  build: "build:all",
  deploy: "deploy:ci", // build stage already produced the artifacts; this just ships them
};

const stage = process.argv[2];
if (!stage || !(stage in STAGES)) {
  console.error(`✗ usage: bun run stage <${Object.keys(STAGES).join("|")}>`);
  process.exit(2);
}

function git(args: string[]): string {
  return spawnSync("git", args, { encoding: "utf8" }).stdout?.trim() ?? "";
}

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "inherit", env: process.env }).status ?? 1;

console.log(`\n▶ stage:${stage}  (bun run ${STAGES[stage]})`);
const code = run("bun", ["run", STAGES[stage]]);

if (code !== 0) {
  console.error(`\n✗ stage:${stage} FAILED (exit ${code}) — no tag written.`);
  process.exit(code);
}

// Success → write the receipt tag on the current commit.
const sha = git(["rev-parse", "--short", "HEAD"]);
if (!sha) {
  console.warn(`\n⚠ stage:${stage} passed, but no git commit to tag (detached/empty repo).`);
  process.exit(0);
}
const prefix = process.env.CI_TAG_PREFIX || "passed";
const tag = `${prefix}/${stage}/${sha}`;
const tagCode = spawnSync("git", ["tag", "-f", tag], { stdio: "inherit" }).status ?? 1;
if (tagCode !== 0) {
  console.warn(`\n⚠ stage:${stage} passed, but tagging ${tag} failed (continuing).`);
  process.exit(0);
}
console.log(`✓ stage:${stage} PASSED — tagged ${tag}`);

if (process.env.CI_PUSH_TAGS !== "0") {
  const push = spawnSync("git", ["push", "-f", "origin", `refs/tags/${tag}`], { stdio: "inherit" }).status ?? 1;
  if (push !== 0) console.warn(`⚠ could not push ${tag} to origin (tag exists locally). Set CI_PUSH_TAGS=0 to silence.`);
}
process.exit(0);
