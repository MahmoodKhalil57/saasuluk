#!/usr/bin/env bun
/**
 * Run the GitHub Actions workflows LOCALLY with wrkflw after a push (git has no native post-push hook). CI runs on the
 * current branch; on master, Deploy runs too — but only if CI passed. Emulation runtime executes on the host, so the
 * per-stage `passed/<stage>/<sha>` receipt tags land on this repo. Use the `push` wrapper: `bun run push origin master`.
 */
import { spawnSync } from "node:child_process";

const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "HEAD";
const run = (file: string) =>
  spawnSync("wrkflw", ["run", "--runtime", "emulation", file], { stdio: "inherit", env: process.env }).status ?? 1;

console.log(`\n──── wrkflw · CI on '${branch}' ────`);
if (run(".github/workflows/ci.yml") !== 0) {
  console.error("\n✗ CI failed locally — skipping deploy.");
  process.exit(1);
}
if (branch === "master") {
  console.log("\n──── wrkflw · Deploy (master) ────");
  process.exit(run(".github/workflows/deploy.yml"));
}
console.log(`\n✓ CI passed for '${branch}'. (Deploy only runs on master.)`);
