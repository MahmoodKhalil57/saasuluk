/**
 * Locale-aware client formatting — the single money/number/date path, projected from @suluk/i18n so it honors the
 * active locale's numbering system (Arabic → ٠١٢٣) + currency conventions. Two consumers:
 *   - bundled modules (cart, etc.) `import { fmtMoney } from "./format"`;
 *   - the hand-rolled inline page scripts (which can't import) read `window.fmtMoney` / `fmtNum` / `fmtDate`.
 * The active locale is read live from `document.documentElement.lang` (set by Layout's __applyLang), so a price
 * re-rendered after a language switch picks up the new numbering system + format automatically.
 */
import { formatCurrency, formatNumber, formatDate } from "@suluk/i18n";
import { LOCALE_CONFIG } from "../i18n";

const CURRENCY = "USD";
const lang = () => document.documentElement.lang || "en";

/** cents (integer) → a localized currency string, e.g. "$19.99" / "١٩٫٩٩ US$". */
export const fmtMoney = (cents: number, currency = CURRENCY): string =>
  formatCurrency(LOCALE_CONFIG, lang(), (Number(cents) || 0) / 100, currency);

/** a number → localized digits (Eastern-Arabic for `ar`). */
export const fmtNum = (n: number): string => formatNumber(LOCALE_CONFIG, lang(), Number(n) || 0);

/** a timestamp/date → a localized medium date. */
export const fmtDate = (value: number | string | Date): string => formatDate(LOCALE_CONFIG, lang(), value, { dateStyle: "medium" });

/** The active PERCENT discount (0–100), read straight from the persisted `discount` store so it's available even
 *  before cart.ts has wired `window.discount`. Only percent codes adjust per-item shop prices (a fixed code is an
 *  order-level amount that can't be meaningfully spread across individual items). Returns 0 when none applies. */
function activePercentDiscount(): number {
  try {
    const raw = localStorage.getItem("discount");
    if (!raw) return 0;
    const d = JSON.parse(raw) as { type?: string; value?: number };
    if (d && d.type === "percent") {
      const v = Number(d.value);
      if (v > 0) return Math.min(100, v);
    }
  } catch {
    /* storage disabled / malformed — no discount */
  }
  return 0;
}

/**
 * Live re-localization (issue #1B) + live discount preview (issues #9/#10). Pages tag any rendered money/number/date
 * with the RAW value in a data-attribute — `data-money="1999"` (cents), `data-num="42"`, `data-date="…"` — and this
 * re-formats every such node in place. Wired to `locale-changed` (language switch), `astro:page-load` (soft nav), AND
 * `discount-changed` (a code applied/removed in the cart), so a switch or discount updates on-page prices instantly,
 * no reload. When a PERCENT code is active, each `[data-money]` shows the discounted price with the original struck
 * through (opt out per node with `data-money-nodiscount`, e.g. an already-struck compare-at price). The data-attribute
 * is always the source of truth, so removing the code re-renders straight back to the full price.
 */
export function relocalize(root: ParentNode = document): void {
  const pct = activePercentDiscount();
  root.querySelectorAll<HTMLElement>("[data-money]").forEach((el) => {
    const c = Number(el.getAttribute("data-money"));
    if (!Number.isFinite(c)) return;
    if (pct > 0 && c > 0 && !el.hasAttribute("data-money-nodiscount")) {
      const discounted = Math.round(c * (1 - pct / 100));
      el.innerHTML = `${fmtMoney(discounted)} <s class="money-was">${fmtMoney(c)}</s>`;
    } else {
      el.textContent = fmtMoney(c);
    }
  });
  root.querySelectorAll<HTMLElement>("[data-num]").forEach((el) => {
    const n = Number(el.getAttribute("data-num"));
    if (Number.isFinite(n)) el.textContent = fmtNum(n);
  });
  root.querySelectorAll<HTMLElement>("[data-date]").forEach((el) => {
    const t = el.getAttribute("data-date");
    if (t) el.textContent = fmtDate(/^\d+$/.test(t) ? Number(t) : t);
  });
}

// bridge for the inline page scripts (no module imports there)
const w = window as unknown as {
  fmtMoney?: typeof fmtMoney;
  fmtNum?: typeof fmtNum;
  fmtDate?: typeof fmtDate;
  relocalize?: typeof relocalize;
};
w.fmtMoney = fmtMoney;
w.fmtNum = fmtNum;
w.fmtDate = fmtDate;
w.relocalize = relocalize;

if (typeof window !== "undefined") {
  window.addEventListener("locale-changed", () => relocalize());
  window.addEventListener("astro:page-load", () => relocalize());
  window.addEventListener("discount-changed", () => relocalize()); // a code applied/removed in the cart → live shop prices
}
