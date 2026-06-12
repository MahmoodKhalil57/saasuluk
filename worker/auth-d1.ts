/** Better Auth on Cloudflare Workers + D1 — a per-request instance (the D1 binding is per-request), cached
 *  per isolate. Uses the kysely-d1 dialect over env.DB. The auth tables live in the same D1 as the domain.
 *  Secrets (BETTER_AUTH_SECRET, GOOGLE_CLIENT_*, RESEND_API_KEY) come from the Worker env (wrangler secrets). */
import { betterAuth } from "better-auth";
import { bearer, admin, openAPI, magicLink } from "better-auth/plugins";
import { emailVerificationConfig, beforeDeleteCascade } from "@suluk/better-auth";
import { D1Dialect } from "kysely-d1";
import { drizzle } from "drizzle-orm/d1";
import { sendEmailAsync, brandedEmail } from "../src/server/email";
import { superadminEmails } from "../src/server/access";
import { buildErasureSteps } from "../src/server/erasure-steps";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  SUPERADMIN_EMAILS?: string;
}
const cache = new WeakMap<object, ReturnType<typeof betterAuth>>();

export function getAuth(env: AuthEnv): ReturnType<typeof betterAuth> {
  const existing = cache.get(env.DB as unknown as object);
  if (existing) return existing;
  const auth = betterAuth({
    database: { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        sendEmailAsync({ to: user.email, subject: "Reset your saasuluk password", html: brandedEmail("Reset your password", `<p>Click to choose a new password — this link expires shortly. If you didn't request it, ignore this email.</p><p><a href="${url}" style="color:#6366f1">Reset password</a></p>`) });
      },
    },
    // frictionless activation (@suluk/better-auth) — verify-on-sign-up + auto-sign-in after; not required.
    emailVerification: emailVerificationConfig({
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        sendEmailAsync({ to: user.email, subject: "Verify your saasuluk email", html: brandedEmail("Verify your email", `<p>Confirm your address to activate your account.</p><p><a href="${url}" style="color:#6366f1">Verify email</a></p>`) });
      },
    }),
    // GDPR account deletion — erase the user's owned rows (D1) before the user row (@suluk/better-auth cascade).
    user: { deleteUser: { enabled: true, beforeDelete: beforeDeleteCascade(buildErasureSteps(drizzle(env.DB))) } },
    secret: env.BETTER_AUTH_SECRET ?? "saasuluk-dev-secret-change-me-32chars!",
    baseURL: "https://saasuluk.saastemly.com",
    trustedOrigins: ["https://saasuluk.saastemly.com"],
    socialProviders: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : undefined,
    // promote a SUPERADMIN_EMAILS address to role:"admin" at sign-up (the verified admin the access layer checks).
    databaseHooks: {
      user: { create: { before: async (user: { email?: string }) => {
        const admins = superadminEmails(env.SUPERADMIN_EMAILS);
        return { data: user.email && admins.includes(user.email.toLowerCase()) ? { ...user, role: "admin" } : user };
      } } },
    },
    plugins: [
      bearer(),
      admin(),
      openAPI(),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          sendEmailAsync(
            { to: email, subject: "Your saasuluk sign-in link", html: brandedEmail("Sign in to saasuluk", `<p>Click to sign in — this link expires shortly.</p><p><a href="${url}" style="color:#6366f1">${url}</a></p>`) },
            { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }, // the Worker secret (process.env may be empty on Workers)
          );
        },
      }),
    ],
  });
  cache.set(env.DB as unknown as object, auth);
  return auth;
}
