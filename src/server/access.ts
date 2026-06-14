/**
 * Per-entity access control for the generic CRUD. Each entity declares an access MODE; the CRUD factories
 * (src/server/crud.ts + the worker's d1Crud) enforce it per operation. Closes the world-writable holes: nobody
 * can mint a discount code, delete a catalog product, or PATCH their own order to "paid".
 *
 * Admin identity is config-driven: a caller is an admin iff their VERIFIED Better Auth session email is in
 * SUPERADMIN_EMAILS (resolved in the auth middleware → c.set("isAdmin", …)). Never a spoofable header.
 */
import type { Context } from "hono";

export type AccessMode = "public" | "admin" | "submit" | "owned" | "ownedAppend" | "ownedReadonly" | "review";
type Rule = "any" | "owner" | "admin" | "none";
interface Policy { list: Rule; get: Rule; create: Rule; update: Rule; delete: Rule }

const POLICIES: Record<AccessMode, Policy> = {
  // catalog + content: world-readable, admin-writable
  public: { list: "any", get: "any", create: "admin", update: "admin", delete: "admin" },
  // sensitive (discount codes): admin-only — even reads (listing all codes is a discount leak)
  admin: { list: "admin", get: "admin", create: "admin", update: "admin", delete: "admin" },
  // public submissions (contact, newsletter): anyone may create; only admins read/modify
  submit: { list: "admin", get: "admin", create: "any", update: "admin", delete: "admin" },
  // user-owned: each caller only ever sees/mutates their own rows (admin sees all)
  owned: { list: "owner", get: "owner", create: "owner", update: "owner", delete: "owner" },
  // owned + append-only to the user — you can place an order + read your own, but only the system/admin
  // mutates it (a user can't PATCH their own order to status:"paid").
  ownedAppend: { list: "owner", get: "owner", create: "owner", update: "admin", delete: "admin" },
  // owned but READ-ONLY to the user — the system/admin even creates it (billing: the connect op inserts it).
  ownedReadonly: { list: "owner", get: "owner", create: "admin", update: "admin", delete: "admin" },
  // public-read, owner-write (product reviews): everyone reads; you only edit your own
  review: { list: "any", get: "any", create: "owner", update: "owner", delete: "owner" },
};

export function policyFor(access: AccessMode | undefined, ownerCol?: string): Policy {
  return POLICIES[access ?? (ownerCol ? "owned" : "public")];
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

/**
 * Decide whether a caller may run an op (per the rule), whether to scope the query to their own rows, and — when
 * denied — the honest status. The `owner` rule REQUIRES a verified caller: an anonymous caller (no principal) is
 * denied 401, because the op declares `x-suluk-access: authenticated` and the WIRE must enforce what the contract
 * claims (C022 inv.3) — a null-scoped empty 200 would let the facet lie. A signed-in caller is scoped to their own
 * rows (admin sees all). `admin`/`none` rules hard-deny 403. Verified by @suluk/testgen's wire-conformance suite.
 */
export function gate(c: Context, rule: Rule, principal: string | null): { ok: boolean; scopeOwner: boolean; status?: 401 | 403 } {
  switch (rule) {
    case "any": return { ok: true, scopeOwner: false };
    case "owner":
      if (isAdmin(c)) return { ok: true, scopeOwner: false };                  // admin sees all
      if (!principal) return { ok: false, scopeOwner: false, status: 401 };    // owner op needs a verified caller (anon → 401)
      return { ok: true, scopeOwner: true };                                   // signed-in: scoped to their own rows
    case "admin":
      if (!principal) return { ok: false, scopeOwner: false, status: 401 };    // authenticate first (RFC 7235: 401 no-auth)
      return { ok: isAdmin(c), scopeOwner: false, status: 403 };                // signed-in but not admin → forbidden
    default: return { ok: false, scopeOwner: false, status: 403 };
  }
}

/** Parse SUPERADMIN_EMAILS (a JSON array string, or a comma list) → lowercased emails. */
export function superadminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.map((s) => String(s).trim().toLowerCase()).filter(Boolean); } catch { /* fall through to CSV */ }
  return raw.split(",").map((s) => s.trim().toLowerCase().replace(/^["[\]]+|["[\]]+$/g, "")).filter(Boolean);
}
