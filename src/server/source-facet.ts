/**
 * PROVENANCE as a CONTRACT FACET (council whuovh6gs, L2). Every operation is STAMPED with `x-suluk-source` — a
 * stable, symbolic pointer to the authored thing it was projected FROM:
 *   • CRUD ops (list/get/create/update/delete<Entity>) → the Drizzle table in `schema.ts` (reverse-mapped by
 *     object identity in domain.ts, so it can't silently drift).
 *   • custom ops → their definition in `operations.ts` (keyed by the request name).
 *   • Better-Auth ops → `auth.ts` (ingested from Better Auth's generated schema, not hand-authored here).
 *
 * Stamped by the PROJECTION pass — never hand-typed, never resolved at generate-time (so generation stays a pure
 * function of the document). Advisory ONLY: a source pointer is the audit trail of WHERE a contract element came
 * from — never an authz/routing/identity input (C022 inv.5). The server SCRUBS it from externally-published views
 * (it discloses internal layout); only the maintainer (admin) lens sees it.
 */
import type { OpenAPIv4Document, SulukSource } from "@suluk/core";
import { entitySource } from "./domain";
import { OPERATION_PATHS } from "./operations";

/** custom (non-CRUD, non-auth) operation names → operations.ts. Derived from the same map api.ts/worker.ts mount. */
const CUSTOM_OPS = new Set<string>(
  Object.values(OPERATION_PATHS).flatMap((pi) => Object.keys((pi as { requests?: Record<string, unknown> }).requests ?? {})),
);

/** Resolve the source pointer for an operation by its name (CRUD → table, custom → operations.ts, else → auth.ts). */
export function sourceFor(name: string): SulukSource {
  const m = /^(list|get|create|update|delete)([A-Z]\w*)$/.exec(name);
  if (m && entitySource[m[2]]) return entitySource[m[2]];
  if (CUSTOM_OPS.has(name)) return { file: "src/server/operations.ts", symbol: name, kind: "operation" };
  return { file: "src/server/auth.ts", symbol: "auth", kind: "better-auth" }; // Better Auth-ingested surface
}

/** Stamp x-suluk-source on every operation, derived from the same registries that drive the projection. In place. */
export function annotateSource(doc: OpenAPIv4Document): OpenAPIv4Document {
  for (const pi of Object.values(doc.paths ?? {})) {
    const requests = (pi as unknown as { requests?: Record<string, Record<string, unknown>> }).requests ?? {};
    for (const [name, req] of Object.entries(requests)) req["x-suluk-source"] = sourceFor(name);
  }
  return doc;
}
