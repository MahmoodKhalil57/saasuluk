/**
 * Access as a CONTRACT FACET. The same access model that the CRUD factories ENFORCE at runtime (access.ts +
 * domain.ts) is projected onto the v4 document as `x-suluk-access` per operation — so @suluk/reference's "View-as"
 * lens can recompute the reachable operation SET per viewer from the contract alone. One access declaration →
 * both enforcement and the docs (the Suluk thesis, applied to access — exactly like cost).
 *
 * `requires` is the minimum viewer for whom the operation is MEANINGFUL: `anyone` (public read / submission),
 * `authenticated` (owner-scoped — your own rows), `admin` (catalog/discount writes, etc.).
 */
import type { OpenAPIv4Document } from "@suluk/core";
import { policyFor } from "./access";
import { tableByEntity } from "./domain";

export interface AccessFacet { requires: "anyone" | "authenticated" | "admin"; scope?: "owner" }

const RULE_TO_REQUIRES = { any: "anyone", owner: "authenticated", admin: "admin", none: "admin" } as const;

/** Custom (non-CRUD) operations — mirrors the actual gating in operations.ts / api.ts / worker.ts. */
const OP_ACCESS: Record<string, AccessFacet> = {
  checkout: { requires: "anyone" }, payCheckout: { requires: "anyone" }, confirmCheckout: { requires: "anyone" },
  validateDiscount: { requires: "anyone" }, search: { requires: "anyone" }, recommendRelated: { requires: "anyone" },
  analyticsSummary: { requires: "anyone" }, analyticsRevenue: { requires: "anyone" }, analyticsTopProducts: { requires: "anyone" },
  subscribeNewsletter: { requires: "anyone" }, generateAvatar: { requires: "anyone" },
  markReviewHelpful: { requires: "authenticated" },
  createToken: { requires: "authenticated" }, revokeToken: { requires: "authenticated", scope: "owner" },
  connectBilling: { requires: "authenticated" }, reportUsage: { requires: "authenticated", scope: "owner" },
};

/** Annotate every operation with x-suluk-access, derived from the same registry that drives enforcement. In place. */
export function annotateAccess(doc: OpenAPIv4Document): OpenAPIv4Document {
  for (const pi of Object.values(doc.paths ?? {})) {
    const requests = (pi as { requests?: Record<string, Record<string, unknown>> }).requests ?? {};
    for (const [name, req] of Object.entries(requests)) {
      const m = /^(list|get|create|update|delete)([A-Z]\w*)$/.exec(name);
      let facet: AccessFacet | undefined;
      if (m) {
        const def = tableByEntity[m[2]];
        if (def) {
          const rule = policyFor(def.access, def.ownerCol)[m[1] as "list" | "get" | "create" | "update" | "delete"];
          facet = { requires: RULE_TO_REQUIRES[rule], ...(rule === "owner" ? { scope: "owner" as const } : {}) };
        }
      } else if (OP_ACCESS[name]) {
        facet = OP_ACCESS[name];
      }
      if (facet) req["x-suluk-access"] = facet;
    }
  }
  return doc;
}
