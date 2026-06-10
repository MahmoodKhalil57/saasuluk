/**
 * Regenerate the committed openapi.json from the SAME registry the app uses (src/server/domain.ts) — no
 * re-declared schema, no drift. (Standalone: it stamps the component schemas + auth securitySchemes without
 * booting Better Auth, so it runs offline.) Run: `bun run gen:openapi`.
 */
import { writeFileSync } from "node:fs";
import { tableComponents } from "@suluk/drizzle";
import { buildApp } from "@suluk/builder";
import { annotateCosts } from "@suluk/cost";
import { authSecuritySchemes, mergeAuth } from "@suluk/better-auth";
import { entitySchemas, costs, allTables } from "../src/server/domain";

const built = buildApp({ entities: entitySchemas, info: { title: "Saasuluk API", version: "0.1.0" } });
let doc = annotateCosts(built.backend.document, costs);
doc.components = { ...(doc.components ?? {}), schemas: { ...(doc.components?.schemas ?? {}), ...tableComponents(allTables) } };
const { securitySchemes } = authSecuritySchemes({ session: true, bearer: true });
doc = mergeAuth(doc, {}, { securitySchemes });
writeFileSync("openapi.json", JSON.stringify(doc, null, 2));
console.log("wrote openapi.json — schemas:", Object.keys(doc.components?.schemas ?? {}).join(", "));
