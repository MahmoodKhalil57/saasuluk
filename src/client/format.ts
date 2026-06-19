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

/**
 * Live re-localization (issue #1B). Pages tag any rendered money/number/date with the RAW value in a data-attribute —
 * `data-money="1999"` (cents), `data-num="42"`, `data-date="1780000000000"` (epoch-ms or an ISO string) — and this
 * re-formats every such node in place. Wired to `locale-changed` (a language switch) + `astro:page-load` (a soft nav,
 * and a hard load whose server text was in the request-locale), so on-page prices/dates follow the locale instantly
 * under the SPA, no reload. The data-attribute is the source of truth; the textContent is just the display.
 */
export function relocalize(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-money]").forEach((el) => {
    const c = Number(el.getAttribute("data-money"));
    if (Number.isFinite(c)) el.textContent = fmtMoney(c);
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
}
