/**
 * Promote every SUPERADMIN_EMAILS address to role:"admin" in the D1 `user` table. This handles EXISTING users;
 * new sign-ups with an allowlisted email are promoted automatically by the Better Auth databaseHook (auth.ts /
 * auth-d1.ts). Idempotent. Reads the allowlist from the env (never hardcodes an email).
 *
 *   bun run scripts/promote-admins.ts            # against remote D1 (live)
 *   bun run scripts/promote-admins.ts --local    # against the local wrangler D1
 *
 * 0 rows changed just means none of those emails have signed up yet — the hook will promote them when they do.
 */
import { $ } from "bun";
import { superadminEmails } from "../src/server/access";

const emails = superadminEmails(process.env.SUPERADMIN_EMAILS);
if (!emails.length) {
  console.error('set SUPERADMIN_EMAILS in .env, e.g. SUPERADMIN_EMAILS=["you@example.com"]');
  process.exit(1);
}

const inList = emails.map((e) => `'${e.replace(/'/g, "''")}'`).join(", ");
const sql = `UPDATE "user" SET role='admin' WHERE lower(email) IN (${inList});`;
const remote = !process.argv.includes("--local");

console.log(`Promoting ${emails.length} email(s) to admin (${remote ? "remote D1" : "local D1"}): ${emails.join(", ")}`);
await $`npx wrangler d1 execute saasuluk-db ${remote ? "--remote" : "--local"} --command ${sql}`;
console.log("✓ done — existing matching users are now admins; future sign-ups are promoted by the auth hook.");
