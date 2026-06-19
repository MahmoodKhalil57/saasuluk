/**
 * Per-entity access control for the generic CRUD. Each entity declares an access MODE; the CRUD factories
 * (src/server/crud.ts + the worker's d1Crud) enforce it per operation. Closes the world-writable holes: nobody
 * can mint a discount code, delete a catalog product, or PATCH their own order to "paid".
 *
 * Admin identity is config-driven: a caller is an admin iff their VERIFIED Better Auth session email is in
 * SUPERADMIN_EMAILS (resolved in the auth middleware → c.set("isAdmin", …)). Never a spoofable header.
 */
import type { Context } from "hono";
import { gate as gateEngine, policyFor as policyForEngine, type AccessMode, type Rule, type Policy } from "@suluk/hono";

// the access ENGINE (gate/policyFor/Rule/Policy/AccessMode + the 7-mode DEFAULT preset) now lives in @suluk/hono;
// saasuluk adopts the default preset by reference. Re-exported so the CRUD twins' imports stay unchanged.
export type { AccessMode, Rule, Policy } from "@suluk/hono";

/** The policy for an access mode — saasuluk uses @suluk/hono's DEFAULT_POLICIES preset (public catalog, owned
 *  orders, admin discounts, …); pass a custom matrix to policyForEngine to diverge. */
export function policyFor(access: AccessMode | undefined, ownerCol?: string): Policy {
  return policyForEngine(access, ownerCol);
}

export const isAdmin = (c: Context): boolean => c.get("isAdmin") === true;

/**
 * Columns that must NEVER be serialized to a non-admin reader. A digital good's `downloadUrl` is the delivered
 * asset — a purchaser receives it via their own order snapshot (repriceLines copies it onto the order line), never
 * from the world-readable catalog. Without this, an anonymous `GET /product` enumerates every product's delivery
 * URL. The data-admin editor (isAdmin) still reads the full row so it can edit the field.
 */
export const PRIVATE_READ_COLS: Record<string, string[]> = {
  product: ["downloadUrl", "download_url"],
  // The owned ApiToken CRUD (domain.ts) would otherwise serialize the stored SHA-256 credential hash to the token's
  // owner — the bespoke token-list + GDPR export deliberately project metadata-only; the generic CRUD must match.
  api_token: ["hashedKey", "hashed_key"],
};

/** Strip a table's private columns from a row unless the caller is an admin. Used by BOTH CRUD twins (dev + worker). */
export function redactRow<T extends Record<string, unknown> | undefined>(tableName: string, row: T, admin: boolean): T {
  if (!row || admin) return row;
  const priv = PRIVATE_READ_COLS[tableName];
  if (!priv?.length) return row;
  const out = { ...(row as Record<string, unknown>) };
  for (const k of priv) delete out[k];
  return out as T;
}

/** Thin Context wrapper over @suluk/hono's gate engine — resolves isAdmin from the request, then the pure engine
 *  decides {ok, scopeOwner, status}. (Same signature the CRUD twins already call; the logic moved to the package.) */
export function gate(c: Context, rule: Rule, principal: string | null): { ok: boolean; scopeOwner: boolean; status?: 401 | 403 } {
  return gateEngine(rule, { isAdmin: isAdmin(c), principal });
}

/** Parse SUPERADMIN_EMAILS (a JSON array string, or a comma list) → lowercased emails. */
export function superadminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  } catch {
    /* fall through to CSV */
  }
  return raw
    .split(",")
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^["[\]]+|["[\]]+$/g, ""),
    )
    .filter(Boolean);
}
