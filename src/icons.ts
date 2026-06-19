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
  search: "material-symbols:search-rounded",
  scheme: "material-symbols:palette-outline",
  themeLight: "material-symbols:light-mode-outline",
  themeDark: "material-symbols:dark-mode-outline",
  themeSystem: "material-symbols:desktop-windows-outline",
  cart: "material-symbols:shopping-bag-outline",
  caret: "material-symbols:keyboard-arrow-down-rounded",
  menu: "material-symbols:menu-rounded",
} as const;

/** Build-time → inline SVG string for the JS contexts. material-symbols bodies are `currentColor`, so the result
 *  inherits the button's text color like the hand-rolled icons did. Returns "" if the name can't be resolved. */
export function iconSvg(name: string, size = 20): string {
  const data = getIconData(materialSymbols, name.replace("material-symbols:", ""));
  if (!data) return "";
  const built = iconToSVG(data, { width: String(size), height: String(size) });
  return iconToHTML(replaceIDs(built.body), built.attributes);
}
