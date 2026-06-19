/**
 * The contract — ONE source projected into the whole stack (the Suluk cycle). The domain registry (`domain.ts`,
 * itself derived from the Drizzle schema) becomes the v4 document: CRUD routes + frontend for every entity; cost
 * declared per operation (x-suluk-cost, bubbles to Scalar + /superadmin); Better Auth contributes its
 * securitySchemes and its own OpenAPI surface (ingested → v4 → merged). The result is the single document every
 * other surface renders. Add an entity in `domain.ts` and it appears here — and everywhere downstream — for free.
 */
import { buildApp, type BuiltApp, type Entity } from "@suluk/builder";
import { tableComponents } from "@suluk/drizzle";
import { annotateCosts } from "@suluk/cost";
import { authSecuritySchemes, ingestAuthOpenAPI, mergeAuth } from "@suluk/better-auth";
import type { OpenAPIv4Document } from "@suluk/core";
import { entitySchemas, costs as domainCosts, allTables } from "./domain";
import { OPERATION_PATHS, OPERATION_COSTS } from "./operations";
import { annotateAccess } from "./access-facet";
import { annotateSource } from "./source-facet";
import { hardenDocument } from "@suluk/harden";
import { auth } from "./auth";

// the cost meter (api.ts) and the docs share ONE model: CRUD costs (domain) + the custom-operation costs.
export const costs = { ...domainCosts, ...OPERATION_COSTS };

export interface Contract {
  built: BuiltApp;
  document: OpenAPIv4Document;
}

/** Assemble the full v4 contract (domain CRUD + custom operations + cost + auth). Async because Better Auth's schema is generated. */
export async function buildContract(): Promise<Contract> {
  // entitySchemas' `schema` infers as `unknown` (hardenSchema returns unknown); it's structurally a v4 SchemaOrRef
  // at runtime, so cast to Entity[] to bridge the library-type gap.
  const built = buildApp({ entities: entitySchemas as unknown as Entity[], info: { title: "Saasuluk API", version: "0.1.0" } });
  built.backend.document.paths = { ...built.backend.document.paths, ...(OPERATION_PATHS as typeof built.backend.document.paths) };
  // Stamp every entity's schema into components.schemas (as gen-openapi.ts does) so the WHOLE domain is in the
  // RUNTIME document — the data-admin, SDK, and conformance all project from this; without it the admin can't see
  // (or manage) any domain entity. (buildApp leaves entity schemas inline in the routes; this names them.)
  built.backend.document.components = {
    ...(built.backend.document.components ?? {}),
    schemas: { ...(built.backend.document.components?.schemas ?? {}), ...tableComponents(allTables) },
  };
  let document = annotateAccess(annotateCosts(built.backend.document, costs)); // cost + access as contract facets

  const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
  try {
    // openAPI() plugin adds api.generateOpenAPISchema() at runtime, but the plugin endpoint isn't surfaced on the
    // inferred auth.api type — cast api to reach it (library-type gap).
    const generateOpenAPISchema = (auth.api as { generateOpenAPISchema: () => Promise<unknown> }).generateOpenAPISchema;
    const authSchema = (await generateOpenAPISchema()) as Record<string, unknown>;
    const authV4 = ingestAuthOpenAPI(authSchema, { basePath: "/api/auth" });
    document = mergeAuth(document, authV4, { securitySchemes });
  } catch {
    document = mergeAuth(document, {}, { securitySchemes }); // at least the schemes, if ingest fails
  }
  document = annotateSource(document); // stamp x-suluk-source on every op (incl. the merged auth surface) — after merge
  return { built, document: hardenDocument(document) }; // baseline-harden every input schema doc-wide (incl. path params)
}
