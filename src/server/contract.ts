/**
 * The contract — ONE source projected into the whole stack (the Suluk cycle). The Drizzle `project` table
 * becomes the v4 document: CRUD routes + frontend; cost is declared per operation (x-suluk-cost, bubbles to
 * Scalar + /superadmin); Better Auth contributes its securitySchemes and its own OpenAPI surface (ingested →
 * v4 → merged). The result is the single document every other surface renders.
 */
import { tableToV4 } from "@suluk/drizzle";
import { buildApp, type BuiltApp } from "@suluk/builder";
import { annotateCosts, type CostModel } from "@suluk/cost";
import { authSecuritySchemes, ingestAuthOpenAPI, mergeAuth } from "@suluk/better-auth";
import type { OpenAPIv4Document } from "@suluk/core";
import { project } from "./db";
import { auth } from "./auth";

const read = (m: number): CostModel => ({ components: [{ source: "db-read", basis: "per-call", microUsd: m }], estimateMicroUsd: m });
const write = (m: number): CostModel => ({ components: [{ source: "compute", basis: "per-call", microUsd: 100 }, { source: "db-write", basis: "per-call", microUsd: m }], estimateMicroUsd: 100 + m });

export const costs: Record<string, CostModel> = {
  listProject: read(12), getProject: read(8), createProject: write(40), updateProject: write(40), deleteProject: write(25),
};

export interface Contract { built: BuiltApp; document: OpenAPIv4Document }

/** Assemble the full v4 contract (domain + cost + auth). Async because Better Auth's schema is generated. */
export async function buildContract(): Promise<Contract> {
  const built = buildApp({ entities: [{ name: "Project", schema: tableToV4(project).insert }], info: { title: "Saasuluk API", version: "0.1.0" } });
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
