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
export const fmtDate = (value: number | string | Date): string =>
  formatDate(LOCALE_CONFIG, lang(), value, { dateStyle: "medium" });

// bridge for the inline page scripts (no module imports there)
const w = window as unknown as { fmtMoney?: typeof fmtMoney; fmtNum?: typeof fmtNum; fmtDate?: typeof fmtDate };
w.fmtMoney = fmtMoney;
w.fmtNum = fmtNum;
w.fmtDate = fmtDate;
