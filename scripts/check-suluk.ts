#!/usr/bin/env bun
/**
 * Suluk contract-drift check — the framework's core invariant. Every layer (docs, client, admin, cost, UI) is a
 * projection of the v4 contract, so the committed openapi.json MUST match what the live registry generates. We
 * regenerate it and fail if it changed. (gen:schemes/build-id embed the git SHA and are deliberately NOT checked.)
 */
import { spawnSync } from "node:child_process";

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "inherit", env: process.env }).status ?? 1;

console.log("• regenerating openapi.json from src/server/domain.ts …");
if (sh("bun", ["run", "gen:openapi"]) !== 0) {
  console.error("✗ gen:openapi failed");
  process.exit(1);
}

const drift = spawnSync("git", ["diff", "--exit-code", "--", "openapi.json"], { stdio: "inherit" }).status ?? 1;
if (drift !== 0) {
  console.error("\n✗ Suluk contract DRIFT — openapi.json is stale. Run `bun run gen:openapi` and commit it.\n");
  process.exit(1);
}
console.log("✓ Suluk contract in sync (openapi.json matches the registry).");
