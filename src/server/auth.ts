/**
 * Auth — Better Auth (email/password + bearer + apiKey + admin + an OpenAPI schema), the same library
 * saastarter uses, wired to the same bun:sqlite database. @suluk/better-auth turns this into the v4 contract:
 * its securitySchemes, its principal extractor (session → scopes), and its own OpenAPI surface (ingested via
 * @suluk/openapi-compat). Live email/password flows need BETTER_AUTH_SECRET + the migrated tables (best-effort
 * below); the Suluk-derived surface works regardless.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { bearer, admin, openAPI, magicLink } from "better-auth/plugins";
import { emailVerificationConfig, beforeDeleteCascade } from "@suluk/better-auth";
import { sqlite, db } from "./db";
import { buildErasureSteps } from "./erasure-steps";
import { sendEmailAsync, brandedEmail } from "./email";
import { verifyEmail, resetPasswordEmail } from "@suluk/email";
import { superadminEmails } from "./access";

/** Brand context for the rich @suluk/email lifecycle templates (peach gradient, wordmark, CTA). */
const EMAIL_CTX = () => ({
  brand: {
    brandName: "saasuluk",
    baseUrl: process.env.BASE_URL ?? "https://saasuluk.saastemly.com",
    accentFrom: "#ef8e5f",
    accentTo: "#f5a97f",
  },
});

export const auth = betterAuth({
  database: sqlite,
  emailAndPassword: {
    enabled: true,
    // password reset (the /login "Forgot password?" flow): email a branded link to /reset-password?token=…
    sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
      const m = resetPasswordEmail({ resetUrl: url }, EMAIL_CTX());
      sendEmailAsync({ to: user.email, subject: m.subject, html: m.html });
    },
  },
  // frictionless activation (@suluk/better-auth): verify-on-sign-up + auto-sign-in after the user clicks the link.
  // Not REQUIRED (sign-up still works immediately), so this adds a verified email without blocking the flow.
  // @suluk/better-auth's EmailVerificationOptions.sendVerificationEmail is typed to return Promise<void>|void
  // and narrows the user param, both wider than Better Auth's emailVerification block — cast to bridge the gap.
  // (runtime body only reads user.email + url, exactly what Better Auth passes.)
  emailVerification: emailVerificationConfig({
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
      const m = verifyEmail({ verifyUrl: url }, EMAIL_CTX());
      sendEmailAsync({ to: user.email, subject: m.subject, html: m.html });
    },
  }) as BetterAuthOptions["emailVerification"],
  // GDPR account deletion (@suluk/better-auth beforeDeleteCascade): erase every row the user owns before the user
  // row goes — no orphaned orders/tokens/billing. Fail-closed (a failed cleanup aborts the delete).
  user: { deleteUser: { enabled: true, beforeDelete: beforeDeleteCascade(buildErasureSteps(db)) } },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-in-prod",
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  // a SUPERADMIN_EMAILS address is promoted to role:"admin" at sign-up — so the verified session that the access
  // layer checks is backed by a real admin row (the admin plugin's APIs work for them too). Idempotent + merge.
  databaseHooks: {
    user: {
      create: {
        before: async (user: { email?: string }) => {
          const admins = superadminEmails(process.env.SUPERADMIN_EMAILS);
          return { data: user.email && admins.includes(user.email.toLowerCase()) ? { ...user, role: "admin" } : user };
        },
      },
    },
  },
  // Google OAuth — enabled when the keys are present (Sign in with Google). Add the callback
  // <baseURL>/api/auth/callback/google to the Google OAuth app's authorized redirect URIs.
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
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
        sendEmailAsync({
          to: email,
          subject: "Your saasuluk sign-in link",
          html: brandedEmail(
            "Sign in to saasuluk",
            `<p>Click to sign in — this link expires shortly.</p><p><a href="${url}" style="color:#f5a97f">${url}</a></p>`,
          ),
        });
      },
    }),
  ],
});

/** Create Better Auth's tables (user/session/account/verification) in the in-memory dev DB so sign-up + sessions
 *  work locally. (The Worker uses D1, migrated separately.) The migration helper moved to `better-auth/db/migration`
 *  in v1.6 — importing the old `better-auth/db` path silently no-op'd, which left dev auth non-functional. */
export async function ensureAuthTables(): Promise<boolean> {
  try {
    const { getMigrations } = await import("better-auth/db/migration");
    const { runMigrations } = await getMigrations(auth.options as Parameters<typeof getMigrations>[0]);
    await runMigrations();
    return true;
  } catch (e) {
    console.warn("[auth] table migration failed — live auth flows won't work locally:", (e as Error).message);
    return false; // auth routes still mount; live flows need the migration
  }
}
