/**
 * Auth — Better Auth (email/password + bearer + apiKey + admin + an OpenAPI schema), the same library
 * saastarter uses, wired to the same bun:sqlite database. @suluk/better-auth turns this into the v4 contract:
 * its securitySchemes, its principal extractor (session → scopes), and its own OpenAPI surface (ingested via
 * @suluk/openapi-compat). Live email/password flows need BETTER_AUTH_SECRET + the migrated tables (best-effort
 * below); the Suluk-derived surface works regardless.
 */
import { betterAuth } from "better-auth";
import { bearer, admin, openAPI } from "better-auth/plugins";
import { sqlite } from "./db";

export const auth = betterAuth({
  database: sqlite,
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-in-prod",
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  plugins: [bearer(), admin(), openAPI()],
});

/** Best-effort: create Better Auth's tables (so sign-up works locally). Real deploys run `better-auth migrate`. */
export async function ensureAuthTables(): Promise<boolean> {
  try {
    const { getMigrations } = await import("better-auth/db");
    const { runMigrations } = await getMigrations(auth.options as Parameters<typeof getMigrations>[0]);
    await runMigrations();
    return true;
  } catch {
    return false; // auth routes still mount; live flows need the migration
  }
}
