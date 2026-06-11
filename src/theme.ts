/**
 * Color-scheme catalog — saasuluk's second @suluk-on-the-frontend wiring (build-time this time). The hand-tuned
 * indigo scheme stays the DEFAULT, authored directly in Layout.astro (untouched — zero regression risk). This
 * module projects ADDITIONAL schemes from @suluk/theme's reference TokenSpecs: one OKLCH spec per scheme, dark
 * auto-derived, emitted as `[data-scheme="…"]` blocks the picker switches between. Runs in Astro frontmatter
 * (server/build time, no client bundle), so it's free on the wire.
 *
 * @suluk/theme speaks the shadcn role vocabulary (--background/--primary/…); saasuluk's stylesheet speaks its own
 * 12-name vocabulary (--bg/--accent/…). `aliasVars` is the one bridge: map roles → names so a scheme authored
 * once drops in without renaming a single `var(--…)` across the pages.
 */
import { themeFromLight, formatOklch, withLightness, REFERENCE_SCHEMES, type ColorTokens } from "@suluk/theme";

/** Map @suluk/theme's shadcn color ROLES onto saasuluk's consumed 12-name CSS-var vocabulary. */
function aliasVars(c: ColorTokens): string {
  const k = formatOklch;
  // saasuluk's gradient wants a vivid SECOND brand color; shadcn has no such role, so derive a lighter tint of
  // the brand (hue-preserving → always coherent with --accent). --link is the brand too (high-contrast links).
  const accent2 = withLightness(c.primary, Math.min(0.9, c.primary.l + 0.07));
  return [
    `--bg:${k(c.background)}`,
    `--bg-soft:${k(c.muted)}`,
    `--panel:${k(c.card)}`,
    `--line:${k(c.border)}`,
    `--fg:${k(c.foreground)}`,
    `--muted:${k(c.mutedForeground)}`,
    `--accent:${k(c.primary)}`,
    `--accent-2:${k(accent2)}`,
    `--link:${k(c.primary)}`,
    `--on-accent:${k(c.primaryForeground)}`,
    `--shadow:0 1px 2px rgba(16,16,40,.06),0 12px 34px rgba(16,16,40,.10)`,
    `--glow:radial-gradient(60% 50% at 50% 0%,color-mix(in oklab,${k(c.primary)} 16%,transparent),transparent 70%)`,
  ].join(";");
}

/** The alternate schemes offered by the picker (the indigo default is the unset state, value=""). */
export const ALT_SCHEMES: { name: string; label: string }[] = [
  { name: "graphite", label: "Graphite" },
  { name: "terracotta", label: "Terracotta" },
  { name: "ocean", label: "Ocean" },
];

/** CSS for every alternate scheme: light under `[data-scheme]`, dark under `[data-scheme][data-theme=dark]`. */
export function altSchemesCss(): string {
  return ALT_SCHEMES.map(({ name }) => {
    const t = themeFromLight(REFERENCE_SCHEMES[name]);
    return [
      `:root[data-scheme="${name}"],html[data-scheme="${name}"][data-theme="light"]{color-scheme:light;${aliasVars(t.light.colors)}}`,
      `html[data-scheme="${name}"][data-theme="dark"]{color-scheme:dark;${aliasVars(t.dark.colors)}}`,
    ].join("\n");
  }).join("\n");
}
