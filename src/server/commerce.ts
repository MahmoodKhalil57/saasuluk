/**
 * The store's SHIPPING + TAX adapters (@suluk/stripe). This is the ONE swap point: replace flatRateShipping with a
 * Shippo / EasyPost / carrier binding, or flatRateTax with a TaxJar / Stripe-Tax / jurisdiction provider — same
 * interface, no checkout changes. Defaults: $5 flat shipping, FREE over $50; an 8% flat sales tax (a clearly-labeled
 * starter placeholder — real tax is jurisdiction-specific). Tunable per deploy via env so rates change without code.
 */
import { flatRateShipping, flatRateTax, type ShippingProvider, type TaxProvider } from "@suluk/stripe";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** Swap this binding to change shipping providers (e.g. `combineShipping(flatRateShipping(...), shippoProvider(...))`). */
export const shippingProvider: ShippingProvider = flatRateShipping({
  flatCents: num(process.env.SHIPPING_FLAT_CENTS, 500),
  freeOverCents: num(process.env.SHIPPING_FREE_OVER_CENTS, 5000),
  label: "Standard shipping",
});

/** Swap this binding to change tax rules (e.g. a jurisdiction table, or `noTax()` to let Stripe Tax handle it). */
export const taxProvider: TaxProvider = flatRateTax({
  rate: num(process.env.TAX_RATE, 0.08),
  label: "Sales tax",
});
