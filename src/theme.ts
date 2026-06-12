/**
 * Color-scheme catalog — projects the 43 tweakcn schemes (ported from saastarter into src/themes/schemes/*.css)
 * into saasuluk's `[data-scheme]` CSS at BUILD time (Astro frontmatter — no client cost). @suluk/theme parses each
 * tweakcn CSS into ColorTokens; `projectScheme` maps the shadcn roles onto saasuluk's `--bg/--accent` vocabulary.
 * The hand-tuned indigo scheme stays the DEFAULT (authored directly in Layout.astro); these are the alternates the
 * picker switches between. The very same projection feeds the worker pages via scripts/gen-schemes.ts → /schemes.css.
 */
import { projectScheme, prettyLabel } from "./themes/project";

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
