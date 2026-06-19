#!/usr/bin/env bun
/**
 * Local CI + deploy after a push (git has no native post-push hook). Runs the same stages the GitHub Actions
 * workflows define — but DIRECTLY in the repo, not through `wrkflw run`.
 *
 * Why not `wrkflw run`: wrkflw's emulation runtime copies the workspace into a temp dir that EXCLUDES dotfiles, so
 * `.prettierrc.json` (→ prettier silently falls back to width-80) and, fatally, `.env` (→ no CLOUDFLARE_* creds for
 * `wrangler deploy`) go missing. Running in place keeps the dotfile config + `.env` creds intact. wrkflw still earns
 * its keep by VALIDATING the workflow files (`bun run wrkflw:validate`) so they stay cloud-portable.
 *
 * CI runs on the current branch; Deploy runs only on master, and only if CI passed. Each stage tags passed/<stage>/<sha>.
 * Wire it via the push wrapper: `bun run push origin master`.
 */
import { spawnSync } from "node:child_process";

const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "HEAD";
const runStage = (name: string) => spawnSync("bun", ["run", "stage", name], { stdio: "inherit", env: process.env }).status ?? 1;

const CI_STAGES = ["format", "lint", "typecheck", "suluk", "test", "build"];

console.log(`\n──── local CI on '${branch}' ────`);
for (const s of CI_STAGES) {
  if (runStage(s) !== 0) {
    console.error(`\n✗ CI failed at stage:${s} — skipping deploy.`);
    process.exit(1);
  }
}

if (branch === "master") {
  console.log(`\n──── Deploy (master) ────`);
  process.exit(runStage("deploy"));
}
console.log(`\n✓ CI passed for '${branch}'. (Deploy runs only on master.)`);
