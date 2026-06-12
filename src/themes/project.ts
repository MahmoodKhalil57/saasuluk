/**
 * Project a tweakcn / shadcn theme CSS into saasuluk's `[data-scheme]` CSS. @suluk/theme's parseShadcnCss reads the
 * CSS into ColorTokens (shadcn roles); aliasVars maps those roles onto saasuluk's 12-name `--bg/--accent`
 * vocabulary, so any community theme drops in without renaming a single `var(--…)` across the pages. Pure (no file
 * IO) — shared by the Astro build (inline, via import.meta.glob in theme.ts) and scripts/gen-schemes.ts (/schemes.css).
 */
import { parseShadcnCss, formatOklch, withLightness, type ColorTokens } from "@suluk/theme";

/** Map @suluk/theme's shadcn color ROLES onto saasuluk's consumed 12-name CSS-var vocabulary. */
function aliasVars(c: ColorTokens): string {
  const k = formatOklch;
  // saasuluk's gradient wants a vivid SECOND brand color; shadcn has no such role, so derive a lighter tint of the
  // brand (hue-preserving → always coherent). --link is the brand too (high-contrast links).
  const accent2 = withLightness(c.primary, Math.min(0.9, c.primary.l + 0.07));
  return [
    `--bg:${k(c.background)}`, `--bg-soft:${k(c.muted)}`, `--panel:${k(c.card)}`, `--line:${k(c.border)}`,
    `--fg:${k(c.foreground)}`, `--muted:${k(c.mutedForeground)}`, `--accent:${k(c.primary)}`, `--accent-2:${k(accent2)}`,
    `--link:${k(c.primary)}`, `--on-accent:${k(c.primaryForeground)}`,
    `--shadow:0 1px 2px rgba(16,16,40,.06),0 12px 34px rgba(16,16,40,.10)`,
    `--glow:radial-gradient(60% 50% at 50% 0%,color-mix(in oklab,${k(c.primary)} 16%,transparent),transparent 70%)`,
  ].join(";");
}

/** Filename → display label: "elegant-luxury" → "Elegant Luxury". */
export function prettyLabel(name: string): string {
  return name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** The `[data-scheme]` light + dark blocks for one tweakcn scheme CSS. Returns "" if the CSS isn't a theme. */
export function projectScheme(name: string, css: string): string {
  const t = parseShadcnCss(css, name);
  if (!t) return "";
  return [
    `:root[data-scheme="${name}"],html[data-scheme="${name}"][data-theme="light"]{color-scheme:light;${aliasVars(t.light)}}`,
    `html[data-scheme="${name}"][data-theme="dark"]{color-scheme:dark;${aliasVars(t.dark)}}`,
  ].join("\n");
}
