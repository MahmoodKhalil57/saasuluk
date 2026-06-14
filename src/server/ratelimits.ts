/**
 * Per-operation rate budgets (fixed window) — the SINGLE source for BOTH the dev server (api.ts) and the Worker
 * (worker.ts), so the two enforcement paths never drift. Enforced via @suluk/hono's enforceRateLimit (429 +
 * Retry-After, RFC-9457). Money/write ops are tighter; everything else gets the generous blanket defaultFacet.
 */
export type RateBudget = { windowMs: number; maxRequests: number; key: "ip" };

export const RATE_LIMITS: Record<string, RateBudget> = {
  checkout: { windowMs: 60000, maxRequests: 60, key: "ip" },
  payCheckout: { windowMs: 60000, maxRequests: 30, key: "ip" },
  quoteCheckout: { windowMs: 60000, maxRequests: 180, key: "ip" }, // read-y, called live on the checkout page
  validateDiscount: { windowMs: 60000, maxRequests: 60, key: "ip" },
  submitReview: { windowMs: 60000, maxRequests: 20, key: "ip" },
  createReview: { windowMs: 60000, maxRequests: 20, key: "ip" },
  createContactSubmission: { windowMs: 60000, maxRequests: 20, key: "ip" },
  subscribeNewsletter: { windowMs: 60000, maxRequests: 20, key: "ip" },
  setOrderStatus: { windowMs: 60000, maxRequests: 60, key: "ip" }, // admin, but cheap to bound
  exportAccount: { windowMs: 60000, maxRequests: 10, key: "ip" },
  createToken: { windowMs: 60000, maxRequests: 20, key: "ip" },
};
