import { createCartStore } from "@suluk/nano-stores";
import { formatCurrency } from "@suluk/i18n";

import { LOCALE_CONFIG } from "@/i18n";

/**
 * The shared client cart for the React chrome. Uses the SAME `storageKey` ("cart") as the rest of saasuluk, so this
 * instance stays in sync (via the native `storage` + `cart-changed` events the store wires) with the inline
 * add-to-cart handlers on the product pages and the legacy drawer — no second source of truth.
 */
export const cartStore = createCartStore({ storageKey: "cart" });

/** Locale-aware money (reads the active `<html lang>`) — mirrors src/client/format.ts without re-running its side effects. */
export const money = (cents: number): string =>
  formatCurrency(
    LOCALE_CONFIG,
    (typeof document !== "undefined" && document.documentElement.lang) || "en",
    (Number(cents) || 0) / 100,
    "USD",
  );
