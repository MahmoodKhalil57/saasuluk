/// <reference types="astro/client" />

/**
 * Client globals the bundled modules expose for the inline page scripts to use. Documenting the contract here
 * keeps the hand-rolled inline scripts honest and the editor quiet.
 */
interface Window {
  /** notification layer — see src/client/toast.ts */
  toast?: (message: string, opts?: { type?: "success" | "error" | "info"; duration?: number }) => void;
  /** the shared cart store — see src/client/cart.ts (@suluk/nano-stores createCartStore) */
  cart?: unknown;
  /** the persisted applied-discount store — see src/client/cart.ts (@suluk/nano-stores createDiscountStore) */
  discount?: { get(): { code: string; type: "percent" | "fixed"; value: number } | null; apply(d: { code: string; type: "percent" | "fixed"; value: number }): void; clear(): void };
  /** Layout's locale text-swapper + the resolved initial locale */
  __applyLang?: (locale: string) => void;
  __lang0?: string;
  /** locale-aware formatters (Eastern-Arabic numerals + locale currency/dates) — see src/client/format.ts */
  fmtMoney?: (cents: number, currency?: string) => string;
  fmtNum?: (n: number) => string;
  fmtDate?: (value: number | string | Date) => string;
}
