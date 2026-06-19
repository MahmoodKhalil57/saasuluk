/**
 * L2 dynamic document — the council-ratified shape (deliberation wcavrm7zk, ceiling 0.70).
 *
 * The canonical /openapi.json is authoritative, full, and auth-free (the single codegen/diff/audit input). This
 * module emits a PER-PRINCIPAL PROJECTION that is a *provable, non-additive SUBSET* of it: it ONLY hides operations
 * unreachable under the declared `x-suluk-access` facet (a closed anyone|authenticated|admin+scope lattice — NEVER a
 * DB-state predicate). It never adds, renames, reshapes, or weakens authz. The projection is stamped
 * `x-suluk-projection` (derived; a pointer + hash back to canonical) so no tool mistakes it for the contract.
 *
 * INVARIANT (council #3): concealment ≠ access control. An operation absent from a view is STILL reachable on the
 * wire — server-side authz (the CRUD gate) is the real boundary, enforced identically regardless of any projection.
 */
import type { OpenAPIv4Document } from "@suluk/core";
import type { Context } from "hono";
import { DEFAULT_VIEWERS, reachState, type AccessFacet } from "@suluk/reference";
import { isAdmin } from "./access";

export type ViewerId = "anon" | "user" | "admin";
const VIEWER = Object.fromEntries(DEFAULT_VIEWERS.map((v) => [v.id, v]));

/** The current request's principal-CLASS (from the VERIFIED session — never a spoofable header). */
export function viewerOf(c: Context): ViewerId {
  if (isAdmin(c)) return "admin";
  if (c.get("sessionUser") || c.get("tokenUser")) return "user";
  return "anon";
}

/** A stable FNV-1a hash of the canonical document — the projection's integrity pointer. */
export function docHash(doc: OpenAPIv4Document): string {
  const s = JSON.stringify(doc);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/** Deterministic, side-effect-free projection: a non-additive subset of `canonical` for a principal-class. */
export function projectDocument(canonical: OpenAPIv4Document, viewer: ViewerId, canonicalHash?: string): OpenAPIv4Document {
  const v = VIEWER[viewer] ?? VIEWER.anon;
  const paths: Record<string, unknown> = {};
  for (const [uri, piRaw] of Object.entries(canonical.paths ?? {})) {
    const pi = piRaw as unknown as { requests?: Record<string, Record<string, unknown>> };
    const kept: Record<string, unknown> = {};
    for (const [name, req] of Object.entries(pi.requests ?? {})) {
      if (reachState(req["x-suluk-access"] as AccessFacet | undefined, v) !== "none") kept[name] = req; // keep iff reachable
    }
    if (Object.keys(kept).length) paths[uri] = { ...pi, requests: kept };
  }
  return {
    ...canonical,
    paths: paths as typeof canonical.paths,
    "x-suluk-projection": { canonical: "/openapi.json", canonicalHash: canonicalHash ?? docHash(canonical), scope: viewer, derived: true },
  } as OpenAPIv4Document;
}

/** Resolve the `?as=` query to a viewer: `me` = the caller's class; an explicit anon|user|admin; else the caller's. */
export function requestedViewer(c: Context, as: string | undefined): ViewerId | null {
  if (!as) return null; // canonical
  if (as === "me") return viewerOf(c);
  return (["anon", "user", "admin"] as const).includes(as as ViewerId) ? (as as ViewerId) : viewerOf(c);
}
