/** Write the canonical seed (src/server/seed.ts) to scripts/seed.sql for `wrangler d1 execute --remote`. */
import { writeFileSync } from "node:fs";
import { SEED_SQL } from "../src/server/seed";
writeFileSync(
  "scripts/seed.sql",
  "-- generated from src/server/seed.ts — do not edit by hand. Apply to D1:\n--   wrangler d1 execute saasuluk-db --file=./scripts/seed.sql --remote\n\n" +
    SEED_SQL +
    "\n",
);
console.log("wrote scripts/seed.sql");
