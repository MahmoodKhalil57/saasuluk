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
 * Decide whether a caller may run an op (per the rule) and whether to scope the query to their own rows.
 * The `owner` rule NEVER blocks — it scopes: an unauthenticated caller is scoped to a null principal, so a list
 * returns [] and a get/update/delete matches nothing (404), exactly the tenant-isolation the demo expects. Only
 * `admin`/`none` rules hard-deny (403), so the catalog/discount/billing write surfaces are genuinely closed.
 */
export function gate(c: Context, rule: Rule, _principal: string | null): { ok: boolean; scopeOwner: boolean } {
  switch (rule) {
    case "any": return { ok: true, scopeOwner: false };
    case "owner": return { ok: true, scopeOwner: !isAdmin(c) }; // admin sees all; everyone else only their own
    case "admin": return { ok: isAdmin(c), scopeOwner: false };
    default: return { ok: false, scopeOwner: false };
  }
}

/** Parse SUPERADMIN_EMAILS (a JSON array string, or a comma list) → lowercased emails. */
export function superadminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.map((s) => String(s).trim().toLowerCase()).filter(Boolean); } catch { /* fall through to CSV */ }
  return raw.split(",").map((s) => s.trim().toLowerCase().replace(/^["[\]]+|["[\]]+$/g, "")).filter(Boolean);
}
