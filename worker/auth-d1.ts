/** Better Auth on Cloudflare Workers + D1 — a per-request instance (the D1 binding is per-request), cached
 *  per isolate. Uses the kysely-d1 dialect over env.DB. The auth tables live in the same D1 as the domain. */
import { betterAuth } from "better-auth";
import { bearer, admin, openAPI } from "better-auth/plugins";
import { D1Dialect } from "kysely-d1";

export interface AuthEnv { DB: D1Database; BETTER_AUTH_SECRET?: string }
const cache = new WeakMap<object, ReturnType<typeof betterAuth>>();

export function getAuth(env: AuthEnv): ReturnType<typeof betterAuth> {
  const existing = cache.get(env.DB as unknown as object);
  if (existing) return existing;
  const auth = betterAuth({
    database: { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
    emailAndPassword: { enabled: true },
    secret: env.BETTER_AUTH_SECRET ?? "saasuluk-dev-secret-change-me-32chars!",
    baseURL: "https://saasuluk.saastemly.com",
    trustedOrigins: ["https://saasuluk.saastemly.com"],
    plugins: [bearer(), admin(), openAPI()],
  });
  cache.set(env.DB as unknown as object, auth);
  return auth;
}
