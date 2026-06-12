/**
 * Color-scheme catalog — projects the 43 tweakcn schemes (ported from saastarter into src/themes/schemes/*.css)
 * into saasuluk's `[data-scheme]` CSS at BUILD time (Astro frontmatter — no client cost). @suluk/theme parses each
 * tweakcn CSS into ColorTokens; `projectScheme` maps the shadcn roles onto saasuluk's `--bg/--accent` vocabulary.
 * The hand-tuned indigo scheme stays the DEFAULT (authored directly in Layout.astro); these are the alternates the
 * picker switches between. The very same projection feeds the worker pages via scripts/gen-schemes.ts → /schemes.css.
 */
import { projectScheme, prettyLabel, parseSwatch } from "./themes/project";

// Vite reads every scheme file as a raw string at build — no fs, no runtime cost.
const RAW = import.meta.glob("./themes/schemes/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SCHEMES = Object.entries(RAW)
  .map(([path, css]) => ({ name: path.split("/").pop()!.replace(/\.css$/, ""), css }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The alternate schemes the picker offers (the indigo default is the unset state, value=""). */
export const ALT_SCHEMES: { name: string; label: string }[] = SCHEMES.map((s) => ({ name: s.name, label: prettyLabel(s.name) }));

/** CSS for every alternate scheme: light under `[data-scheme]`, dark under `[data-scheme][data-theme=dark]`. */
export function altSchemesCss(): string {
  return SCHEMES.map((s) => projectScheme(s.name, s.css)).filter(Boolean).join("\n");
}

/** Swatch previews for the scheme picker — derived from @suluk/theme (never hand-maintained). The indigo default
 *  (value "") leads; each entry carries the bg·primary·accent triplet for light + dark so the picker previews the
 *  scheme in whichever mode is active. Embedded as JSON in the header. */
export type SchemeSwatch = { name: string; label: string; light: string[]; dark: string[] };
export const SCHEME_SWATCHES: SchemeSwatch[] = [
  { name: "", label: "Indigo", light: ["#ffffff", "#6366f1", "#eef2ff"], dark: ["#09090c", "#818cf8", "#312e81"] },
  ...SCHEMES.map((s) => { const sw = parseSwatch(s.name, s.css); return { name: s.name, label: prettyLabel(s.name), light: sw?.light ?? [], dark: sw?.dark ?? [] }; }),
];
