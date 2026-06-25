# UI architecture — page → section → block → component

saasuluk uses **shadcn/ui + Tailwind v4** behind a strict four-tier split (mirrors `~/apps/sandook-tasali`). Each
tier may only consume the tier below it. The reference example is the `/showcase` route.

```
page    (src/pages/*.astro)              composes  sections        (+ the Layout frame)
section (src/sections/<area>/*.astro)    composes  blocks
block   (src/blocks/<area>/*.astro|tsx)  composes  base ui
base ui (src/components/ui/*.tsx)        shadcn primitives (cva + radix + cn)
```

| Tier        | Folder                 | Files                                            | Owns                                                 | May import                |
| ----------- | ---------------------- | ------------------------------------------------ | ---------------------------------------------------- | ------------------------- |
| **base**    | `src/components/ui/`   | `.tsx`                                           | accessibility, variants, atomic styling              | radix, cva, `@/lib/utils` |
| **block**   | `src/blocks/<area>/`   | `.astro` (static) or `.tsx` (interactive island) | one reusable shape; **generic** placeholder defaults | base ui only              |
| **section** | `src/sections/<area>/` | `.astro`                                         | the **business copy**; layout via `SectionBand`      | blocks only               |
| **page**    | `src/pages/`           | `.astro`                                         | which sections, in what order, at which route        | sections + `Layout`       |

**The one rule:** business copy (saasuluk's plans, feature text, brand voice) lives in **sections**. Blocks stay
generic so a different business could reuse them. A page is just an ordered list of sections.

## Conventions

- **`class` vs `className`** — native Astro elements use `class`; React components (`<Card>`, `<Button>`) use
  `className`. In `.astro` blocks, prefer the cva variant functions (`buttonVariants(...)`, `badgeVariants(...)`) on
  native elements for static markup; render the React components directly when you want the real primitive.
- **`SectionBand`** (`src/blocks/shared/SectionBand.astro`) is the shell every section wraps content in. It is the
  **`.sk-tw` boundary** — see the theme note below.
- **Interactive blocks** are React `.tsx` islands (e.g. `SignupBlock.tsx`) dropped into a section with `client:visible`
  / `client:load`. Data-fetching + handlers live in the block (developer tier); the section only places it.
- **Full-bleed pages** pass `bare` to `<Layout>` so sections span the viewport instead of the centered `.wrap`.

## shadcn + Tailwind setup (saasuluk-specific)

saasuluk is **not** a Tailwind-from-scratch app — it has 43 hand-styled pages + a 43-scheme system. So:

- **`src/styles/app.css`** imports Tailwind's `theme` + `utilities` layers but **omits Preflight** (Preflight's global
  reset would break the legacy pages). The reset shadcn needs is applied **scoped to `.sk-tw`** instead.
- The **`@theme inline` bridge** maps shadcn tokens onto saasuluk's existing vars (`--color-primary: var(--accent)`,
  …). Those vars are projected per-scheme by `@suluk/theme` (`src/themes/project.ts`), so **every shadcn component
  follows the active color scheme + light/dark automatically** — one source of truth.
- `dark:` utilities key off `[data-theme="dark"]` (the existing toggle), via `@custom-variant dark`.
- `components.json` + `@/*` path alias (`tsconfig.json`) are set, so `bunx shadcn@latest add <component>` works — drop
  new primitives in `src/components/ui/`.

## Premium chrome components (`src/blocks/chrome/`)

saasuluk's premium chrome — extracted from the legacy Layout into **reusable React shadcn blocks** (interactive,
data-aware tier). Each is a `client:*` island that **interoperates with the existing system** (same `localStorage`
keys, `data-theme`/`data-scheme` on `<html>`, the `locale-changed` event, and the shared cart store) — so they're true
drop-in extractions, not reimplementations. `ChromeBar` composes all four.

| Component     | Built on                              | Drives                                      | Interops via                                                           |
| ------------- | ------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `ThemeToggle` | `Button` + `circle-reveal`            | light/dark/system + expanding-circle reveal | `localStorage["theme"]`, `data-theme`/`data-themePref`                 |
| `SchemeMenu`  | `Popover` + `Input` + `circle-reveal` | 43 color schemes (searchable swatches)      | `localStorage["scheme"]`, `data-scheme`, `window.__schemes`            |
| `LangMenu`    | `DropdownMenu`                        | locale switch + live re-localize            | `localStorage["lang"]`, cookie, `window.__applyLang`, `locale-changed` |
| `CartButton`  | `Sheet` + `@nanostores/react`         | cart drawer (qty/remove/subtotal/checkout)  | the shared `cartStore` (`storageKey:"cart"`)                           |

- **`src/lib/circle-reveal.ts`** — the View-Transitions expanding-circle reveal, shared by ThemeToggle + SchemeMenu.
- **`src/lib/cart-store.ts`** — the shared cart store + locale-aware `money()`; same `storageKey` as the rest of the site.
- Live demo: the **ChromeSection** on `/showcase`. (These are reusable components — the legacy Layout chrome is left
  in place; swap it onto these blocks when ready.)

## Site frame — Header + Footer as tiers

The header and footer are themselves built from the full ladder (sub-blocks → blocks → sections), not one inline blob:

```
HeaderSection (section)         FooterSection (section)
  └ SiteHeader (block)            └ SiteFooter (block)
      ├ BrandBlock (sub-block)        ├ FooterBrand (sub-block) → BrandBlock
      ├ NavBlock (block)              ├ FooterColumn (sub-block) → FooterLink (sub-block)
      │   └ NavItem (sub-block)       └ FooterBottom (sub-block)
      ├ ChromeBar (chrome block)
      └ MobileNav (chrome block) → Sheet + ChromeBar(compact)
```

- `src/blocks/header/` + `src/blocks/footer/` hold the sub-blocks/blocks; `src/sections/frame/{HeaderSection,FooterSection}.astro` are the bands.
- The nav + footer link maps live once in **`src/lib/site-nav.ts`** (`SITE_NAV`, `FOOTER_COLUMNS`).
- **This is now the LIVE chrome:** `Layout.astro` renders `<HeaderSection>` … `<FooterSection>` for **every page**
  (both `transition:persist`ed so they survive soft navs). The legacy inline banner/header/footer + overlays are kept
  in the DOM but hidden (`body.sk-no-chrome` in `app.css`) so their no-flash scripts still bind harmlessly; the legacy
  `palette.ts` import is dropped (the React `SearchButton` owns ⌘K). An inline `astro:page-load` script re-syncs the
  persisted nav's active highlight per navigation.
- Nav links carry `data-i18n` so a language switch still re-translates them.

## Suluk note

`@suluk/theme` is the design-token bridge (already used for the scheme projection). `@suluk/shadcn`
(`renderFormTsx` / `renderTableTsx`) can **codegen** CRUD forms/tables from the contract if you later want generated
admin UI — it's installed but not used by these hand-authored marketing tiers.

## Add a new …

- **base ui:** `bunx shadcn@latest add dialog` (or hand-write a `.tsx` in `ui/`).
- **block:** drop `src/blocks/<area>/MyThing.astro` (or `.tsx`), import only base ui, generic defaults.
- **section:** drop `src/sections/<area>/MySection.astro`, wrap blocks in `SectionBand`, put the real copy here.
- **page:** drop `src/pages/my-route.astro`, compose sections inside `<Layout>`.
