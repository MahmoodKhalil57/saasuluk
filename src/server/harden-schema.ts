/**
 * A baseline HARDENING pass over generated (Drizzle-derived) v4 schemas — the answer to @suluk/harden's findings.
 * It adds sensible default BOUNDS so untrusted input can't be unboundedly large or carry control/weird characters
 * that break the system: every string gets a maxLength + a control-char-rejecting pattern, every number a
 * maximum/minimum, every array a maxItems, every object is closed (additionalProperties:false). Authors should
 * TIGHTEN these per field (a slug isn't 1024 chars) — this is the floor that turns an F/D contract into a B.
 */
type S = Record<string, unknown>;
// Reject NUL + control chars that break parsers (tab/newline/CR are allowed by the range below).
const SAFE_TEXT = "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]*$";

export function hardenSchema(schema: unknown): unknown {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(hardenSchema);
  const s: S = { ...(schema as S) };
  const t = Array.isArray(s.type) ? (s.type as string[])[0] : s.type;
  if (s.properties) { const p: S = {}; for (const [k, v] of Object.entries(s.properties as S)) p[k] = hardenSchema(v); s.properties = p; if (s.additionalProperties === undefined) s.additionalProperties = false; }
  if (s.items) s.items = hardenSchema(s.items);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) if (Array.isArray(s[key])) s[key] = (s[key] as unknown[]).map(hardenSchema);
  const bounded = s.enum !== undefined || s.const !== undefined || s.format !== undefined;
  if (t === "string" && !bounded) {
    if (s.maxLength === undefined) s.maxLength = 1024;
    if (s.pattern === undefined) s.pattern = SAFE_TEXT;
  }
  if (t === "integer" || t === "number") {
    if (s.maximum === undefined && s.exclusiveMaximum === undefined) s.maximum = 1_000_000_000_000;
    if (s.minimum === undefined && s.exclusiveMinimum === undefined) s.minimum = -1_000_000_000_000;
  }
  if (t === "array" && s.maxItems === undefined) s.maxItems = 1000;
  return s;
}

/** Harden EVERY input schema in a built v4 document in place — request bodies + all parameter slots (incl. the
 *  route generator's path params, which are otherwise unbounded strings). Idempotent. */
export function hardenDocument<T>(doc: T): T {
  const d = doc as { paths?: Record<string, { requests?: Record<string, Record<string, unknown>> }> };
  for (const pi of Object.values(d.paths ?? {})) {
    for (const req of Object.values(pi.requests ?? {})) {
      if (req.contentSchema) req.contentSchema = hardenSchema(req.contentSchema);
      const ps = req.parameterSchema as Record<string, unknown> | undefined;
      if (ps) for (const loc of ["query", "path", "header", "cookie", "body"]) if (ps[loc]) ps[loc] = hardenSchema(ps[loc]);
    }
  }
  return doc;
}
