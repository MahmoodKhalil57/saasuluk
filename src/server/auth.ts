/**
 * Auth — Better Auth (email/password + bearer + apiKey + admin + an OpenAPI schema), the same library
 * saastarter uses, wired to the same bun:sqlite database. @suluk/better-auth turns this into the v4 contract:
 * its securitySchemes, its principal extractor (session → scopes), and its own OpenAPI surface (ingested via
 * @suluk/openapi-compat). Live email/password flows need BETTER_AUTH_SECRET + the migrated tables (best-effort
 * below); the Suluk-derived surface works regardless.
 */
import { betterAuth } from "better-auth";
import { bearer, admin, openAPI, magicLink } from "better-auth/plugins";
import { sqlite } from "./db";
import { sendEmailAsync, brandedEmail } from "./email";

export const auth = betterAuth({
  database: sqlite,
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-in-prod",
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  // Google OAuth — enabled when the keys are present (Sign in with Google). Add the callback
  // <baseURL>/api/auth/callback/google to the Google OAuth app's authorized redirect URIs.
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
    : undefined,
  plugins: [
    bearer(),
    admin(),
    openAPI(),
    // passwordless sign-in — the email link IS the credential. (Passkey/WebAuthn is a drop-in add: install
    // @better-auth/passkey and add passkey() here; magic-link ships now because it needs no extra package.)
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        sendEmailAsync({ to: email, subject: "Your saasuluk sign-in link", html: brandedEmail("Sign in to saasuluk", `<p>Click to sign in — this link expires shortly.</p><p><a href="${url}" style="color:#f5a97f">${url}</a></p>`) });
      },
    }),
  ],
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
