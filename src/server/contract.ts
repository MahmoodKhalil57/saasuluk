/**
 * The contract — ONE source projected into the whole stack (the Suluk cycle). The domain registry (`domain.ts`,
 * itself derived from the Drizzle schema) becomes the v4 document: CRUD routes + frontend for every entity; cost
 * declared per operation (x-suluk-cost, bubbles to Scalar + /superadmin); Better Auth contributes its
 * securitySchemes and its own OpenAPI surface (ingested → v4 → merged). The result is the single document every
 * other surface renders. Add an entity in `domain.ts` and it appears here — and everywhere downstream — for free.
 */
import { buildApp, type BuiltApp } from "@suluk/builder";
import { annotateCosts } from "@suluk/cost";
import { authSecuritySchemes, ingestAuthOpenAPI, mergeAuth } from "@suluk/better-auth";
import type { OpenAPIv4Document } from "@suluk/core";
import { entitySchemas, costs } from "./domain";
import { auth } from "./auth";

export { costs } from "./domain"; // re-exported so the cost meter (api.ts) uses the same per-op model as the docs

export interface Contract { built: BuiltApp; document: OpenAPIv4Document }

/** Assemble the full v4 contract (domain + cost + auth). Async because Better Auth's schema is generated. */
export async function buildContract(): Promise<Contract> {
  const built = buildApp({ entities: entitySchemas, info: { title: "Saasuluk API", version: "0.1.0" } });
  let document = annotateCosts(built.backend.document, costs);

  const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
  try {
    const authSchema = (await auth.api.generateOpenAPISchema()) as Record<string, unknown>;
    const authV4 = ingestAuthOpenAPI(authSchema, { basePath: "/api/auth" });
    document = mergeAuth(document, authV4, { securitySchemes });
  } catch {
    document = mergeAuth(document, {}, { securitySchemes }); // at least the schemes, if ingest fails
  }
  return { built, document };
}
