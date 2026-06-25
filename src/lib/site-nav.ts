/**
 * The site's navigation map — a single source shared by the tiered header (NavBlock + MobileNav) and footer
 * (SiteFooter). App-level data (an N=1 registry), so it lives in `lib`, not in a generic block.
 */
export type NavLink = { href: string; label: string; i18nKey?: string };

export const SITE_NAV: NavLink[] = [
  { href: "/products", label: "Products", i18nKey: "products" },
  { href: "/pricing", label: "Pricing", i18nKey: "pricing" },
  { href: "/blogs", label: "Blog", i18nKey: "blog" },
  { href: "/about", label: "About", i18nKey: "about" },
  { href: "/contact", label: "Contact", i18nKey: "contact" },
  { href: "/reference", label: "API docs", i18nKey: "docs" },
];

export const FOOTER_COLUMNS: { head: string; links: NavLink[] }[] = [
  {
    head: "Product",
    links: [
      { href: "/products", label: "Products", i18nKey: "products" },
      { href: "/pricing", label: "Pricing", i18nKey: "pricing" },
      { href: "/metrics", label: "Metrics", i18nKey: "metrics" },
      { href: "/panel", label: "Dashboard", i18nKey: "dashboard" },
    ],
  },
  {
    head: "Resources",
    links: [
      { href: "/blogs", label: "Blog", i18nKey: "blog" },
      { href: "/faqs", label: "FAQ", i18nKey: "faq" },
      { href: "/about", label: "About", i18nKey: "about" },
      { href: "/contact", label: "Contact", i18nKey: "contact" },
    ],
  },
  {
    head: "Developers",
    links: [
      { href: "/reference", label: "API reference" },
      { href: "/scalar", label: "Scalar" },
      { href: "/openapi.json", label: "OpenAPI doc" },
      { href: "/superadmin", label: "Superadmin" },
      { href: "/cost", label: "Cost ledger" },
    ],
  },
  {
    head: "Robots & AI",
    links: [
      { href: "/sitemap.xml", label: "Sitemap" },
      { href: "/robots.txt", label: "robots.txt" },
      { href: "/llms.txt", label: "llms.txt" },
      { href: "/mcp", label: "MCP server" },
    ],
  },
  {
    head: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/license", label: "License" },
    ],
  },
];
