/**
 * Icon registry (issue #6) — single source of truth for every icon name in the app, so swapping a set is a one-liner.
 *
 * Two consumers:
 *   • `.astro` templates → `<Icon name={ICON.x} />` (astro-icon, build-time inline currentColor SVG, no CDN).
 *   • JS/`is:inline` contexts that can't use `<Icon>` (the theme toggle swaps `innerHTML` per light/dark/system) →
 *     `iconSvg(ICON.x)` resolves the raw SVG STRING at build (in `.astro` frontmatter / Node), never the browser.
 */
import { getIconData, iconToSVG, iconToHTML, replaceIDs } from "@iconify/utils";
import { icons as materialSymbols } from "@iconify-json/material-symbols";

export const ICON = {
  // chrome controls (consumed by the legacy .astro chrome AND the React chrome blocks)
  search: "material-symbols:search-rounded",
  scheme: "material-symbols:palette-outline",
  themeLight: "material-symbols:light-mode-outline",
  themeDark: "material-symbols:dark-mode-outline",
  themeSystem: "material-symbols:desktop-windows-outline",
  cart: "material-symbols:shopping-bag-outline",
  caret: "material-symbols:keyboard-arrow-down-rounded",
  menu: "material-symbols:menu-rounded",
  lang: "material-symbols:language-korean-latin-rounded",

  // base-ui indicators (dropdown check/radio, dialog + sheet close)
  check: "material-symbols:check-rounded",
  dot: "material-symbols:circle",
  close: "material-symbols:close-rounded",

  // cart line steppers
  minus: "material-symbols:remove-rounded",
  plus: "material-symbols:add-rounded",

  // account menu
  dashboard: "material-symbols:space-dashboard-outline",
  orders: "material-symbols:package-2-outline",
  wishlist: "material-symbols:favorite-outline",
  logout: "material-symbols:logout-rounded",

  // search palette
  arrowRight: "material-symbols:arrow-right-alt-rounded",
  product: "material-symbols:inventory-2-outline",
  post: "material-symbols:article-outline",
  page: "material-symbols:description-outline",
  loading: "line-md:loading-loop", // animated spinner — the "material-lines" (line-md) set

  // devicon brand logos — the showcase "Built on" strip
  astro: "devicon:astro",
  cloudflare: "devicon:cloudflareworkers",
  react: "devicon:react",
  typescript: "devicon:typescript",
  tailwind: "devicon:tailwindcss",
} as const;

export type IconName = (typeof ICON)[keyof typeof ICON];

/** Build-time → inline SVG string for the JS contexts. material-symbols bodies are `currentColor`, so the result
 *  inherits the button's text color like the hand-rolled icons did. Returns "" if the name can't be resolved. */
export function iconSvg(name: string, size = 20): string {
  const data = getIconData(materialSymbols, name.replace("material-symbols:", ""));
  if (!data) return "";
  const built = iconToSVG(data, { width: String(size), height: String(size) });
  return iconToHTML(replaceIDs(built.body), built.attributes);
}
