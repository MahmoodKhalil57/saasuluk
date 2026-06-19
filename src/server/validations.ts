/**
 * REASONABLE per-field validations for the domain — not the generous hardening floor, but constraints a real store
 * would enforce. These project into the v4 contract AND are enforced at runtime (the API rejects invalid input),
 * so they are genuine security, not just a grade. Declared once here, beside the schema; merged onto each entity's
 * generated insert schema in domain.ts. Authors extend this map as the schema grows.
 *
 * Conventions: display fields (name/title/subject/alt) forbid `<>` + control chars (stored-XSS guard); long text
 * (description/body/message) allows newlines/tabs but no other control chars; slugs are lowercase-dash; codes are
 * upper/digit/-/_ ; emails/urls use format; ids/counts/cents/timestamps get sane numeric caps. enum + boolean
 * columns are already bounded by the Drizzle→v4 projection, so they are intentionally omitted.
 */
const TS_MAX = 4_102_444_800_000; // ~year 2100, ms — a sane timestamp ceiling
const ID_MAX = 1_000_000_000_000;

const line = (maxLength: number, pattern = "^[^<>\\u0000-\\u001f\\u007f]*$") => ({ type: "string", maxLength, pattern }); // single-line, no <> / control
const rich = (maxLength: number) => ({ type: "string", maxLength, pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$" }); // allows \t \n \r
const slug = (maxLength = 80) => ({ type: "string", maxLength, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });
const code = (maxLength = 40) => ({ type: "string", maxLength, pattern: "^[A-Z0-9][A-Z0-9_-]*$" });
const email = () => ({ type: "string", format: "email", maxLength: 254 });
const url = (maxLength = 2048) => ({ type: "string", format: "uri", maxLength });
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const ts = () => int(0, TS_MAX);
const uid = () => line(128); // a Better Auth user id (opaque)
const cents = (maximum = 1_000_000_000) => int(0, maximum); // ≤ $10M by default
const jsonBlob = (maxLength: number) => rich(maxLength); // a JSON string column (line-items etc.) — bound length

/** Per-entity field → constraint overlay. Merged onto the generated property schema (constraints win, type stays). */
export const VALIDATIONS: Record<string, Record<string, unknown>> = {
  Category: { name: line(100), slug: slug() },
  Product: {
    name: line(160),
    slug: slug(100),
    description: rich(5000),
    priceCents: cents(),
    categoryId: int(1, ID_MAX),
    inventory: int(0, 1_000_000),
    imageUrl: url(),
    stripePriceId: line(120, "^price_[A-Za-z0-9]+$"),
  },
  Variant: { productId: int(1, ID_MAX), title: line(160), priceCents: cents(), inventory: int(0, 1_000_000) },
  DiscountCode: {
    code: code(40),
    discountValue: int(0, 1_000_000_000),
    currentUses: int(0, 1_000_000_000),
    maxUses: int(1, 1_000_000),
    expiresAt: ts(),
  },
  Cart: { customerId: uid(), items: jsonBlob(100_000), discountCode: code(40) },
  Order: {
    customerId: uid(),
    items: jsonBlob(100_000),
    totalCents: cents(100_000_000_000),
    discountCode: code(40),
    stripePaymentIntentId: line(255),
    createdAt: ts(),
  },
  Review: {
    productId: int(1, ID_MAX),
    customerId: uid(),
    rating: int(1, 5),
    title: line(160),
    body: rich(5000),
    helpfulCount: int(0, 1_000_000_000),
    createdAt: ts(),
  },
  WishlistItem: { customerId: uid(), productId: int(1, ID_MAX), variantId: int(1, ID_MAX), addedAt: ts() },
  Address: {
    customerId: uid(),
    name: line(120),
    line1: line(200),
    line2: line(200),
    city: line(120),
    state: line(120),
    postalCode: line(20),
    country: line(2, "^[A-Za-z]{2}$"),
    isDefault: { type: "boolean" },
  },
  Post: {
    title: line(200),
    slug: slug(120),
    excerpt: rich(500),
    body: rich(50_000),
    publishedAt: ts(),
    authorId: uid(),
    coverImageUrl: url(),
  },
  Faq: { question: line(300), answer: rich(2000), sortOrder: int(0, 100_000) },
  NewsletterSubscriber: { email: email(), subscribedAt: ts() },
  ContactSubmission: { name: line(120), email: email(), subject: line(200), message: rich(5000), createdAt: ts() },
  Media: { url: url(), alt: line(300), width: int(0, 100_000), height: int(0, 100_000) },
  ApiToken: {
    userId: uid(),
    name: line(120),
    prefix: line(20),
    hashedKey: line(128, "^[a-f0-9]+$"),
    createdAt: ts(),
    lastUsedAt: ts(),
    revokedAt: ts(),
  },
  BillingAccount: {
    principal: uid(),
    stripeCustomerId: line(255),
    subscriptionId: line(255),
    lastReportedMicroUsd: int(0, ID_MAX),
    lastReportedAt: ts(),
    createdAt: ts(),
  },
  Project: { name: line(160), ownerId: uid() },
};

/** Merge an entity's declared validations onto its generated insert schema (and close the object). */
export function applyValidations(name: string, schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = { ...(schema as Record<string, unknown>) };
  const v = VALIDATIONS[name];
  if (s.properties && typeof s.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, ps] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = v?.[k] && ps && typeof ps === "object" ? { ...(ps as Record<string, unknown>), ...(v[k] as Record<string, unknown>) } : ps;
    }
    s.properties = props;
  }
  if (s.additionalProperties === undefined) s.additionalProperties = false; // closed: reject unexpected keys
  return s;
}

// re-export the field builders so the custom-op bodies (operations.ts) can declare matching real bounds.
export const v = { line, rich, slug, code, email, url, int, ts, uid, cents, jsonBlob };
