/**
 * Lightweight i18n — the chrome (nav, footer, common actions) translated across en / es / ar, with RTL for
 * Arabic. saastarter ships a namespace-per-locale system in src/messages; here it is one typed dictionary +
 * a `t()` lookup, read by the Layout from a `lang` cookie. Extend by adding keys (and page-body strings) to
 * DICT — the pattern is the same. RTL is handled by `dir` on <html> so logical CSS just works.
 */
import { defineLocales } from "@suluk/i18n";

export const LOCALES = ["en", "es", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const RTL: Locale[] = ["ar"];
export const LOCALE_LABEL: Record<Locale, string> = { en: "English", es: "Español", ar: "العربية" };

/** The @suluk/i18n locale model — the MECHANISM (dir + numberingSystem) feeding the Intl formatters; the DICT
 *  below stays the app's chrome CONTENT. `ar` declares numberingSystem "arab" → money/dates render ٠١٢٣. */
export const LOCALE_CONFIG = defineLocales({
  default: "en",
  locales: [
    { code: "en", label: "English" },
    { code: "es", label: "Español" },
    { code: "ar", label: "العربية", dir: "rtl", numberingSystem: "arab" },
  ],
});

type Key =
  | "home"
  | "products"
  | "blog"
  | "pricing"
  | "dashboard"
  | "account"
  | "faq"
  | "contact"
  | "about"
  | "metrics"
  | "docs"
  | "admin"
  | "privacy"
  | "terms"
  | "license"
  | "tagline"
  | "search"
  | "addToCart"
  | "checkout"
  | "cart"
  | "subtotal"
  | "emptyCart"
  | "skipToContent";

export const DICT: Record<Locale, Record<Key, string>> = {
  en: {
    home: "Home",
    products: "Products",
    blog: "Blog",
    pricing: "Pricing",
    dashboard: "Dashboard",
    account: "Account",
    faq: "FAQ",
    contact: "Contact",
    about: "About",
    metrics: "Metrics",
    docs: "API Docs",
    admin: "Admin",
    privacy: "Privacy",
    terms: "Terms",
    license: "License",
    tagline: "every layer from one contract.",
    search: "Search",
    addToCart: "Add to cart",
    checkout: "Checkout",
    cart: "Cart",
    subtotal: "Subtotal",
    emptyCart: "Your cart is empty.",
    skipToContent: "Skip to content",
  },
  es: {
    home: "Inicio",
    products: "Productos",
    blog: "Blog",
    pricing: "Precios",
    dashboard: "Panel",
    account: "Cuenta",
    faq: "Preguntas",
    contact: "Contacto",
    about: "Acerca de",
    metrics: "Métricas",
    docs: "API Docs",
    admin: "Admin",
    privacy: "Privacidad",
    terms: "Términos",
    license: "Licencia",
    tagline: "cada capa desde un solo contrato.",
    search: "Buscar",
    addToCart: "Añadir al carrito",
    checkout: "Pagar",
    cart: "Carrito",
    subtotal: "Subtotal",
    emptyCart: "Tu carrito está vacío.",
    skipToContent: "Saltar al contenido",
  },
  ar: {
    home: "الرئيسية",
    products: "المنتجات",
    blog: "المدونة",
    pricing: "الأسعار",
    dashboard: "لوحة التحكم",
    account: "الحساب",
    faq: "الأسئلة",
    contact: "اتصل بنا",
    about: "حول",
    metrics: "الإحصاءات",
    docs: "وثائق API",
    admin: "الإدارة",
    privacy: "الخصوصية",
    terms: "الشروط",
    license: "الرخصة",
    tagline: "كل طبقة من عقد واحد.",
    search: "بحث",
    addToCart: "أضف إلى السلة",
    checkout: "الدفع",
    cart: "السلة",
    subtotal: "المجموع الفرعي",
    emptyCart: "سلتك فارغة.",
    skipToContent: "تخطَّ إلى المحتوى",
  },
};

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);
export const dirOf = (l: Locale): "rtl" | "ltr" => (RTL.includes(l) ? "rtl" : "ltr");
export function t(locale: Locale, key: Key): string {
  return DICT[locale]?.[key] ?? DICT.en[key] ?? key;
}
