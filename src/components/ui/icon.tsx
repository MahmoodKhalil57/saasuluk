import * as React from "react";

import { ICON_DATA } from "@/lib/icon-data";

/**
 * Icon (tier: BASE) — the React counterpart of astro-icon's <Icon>. Renders an Iconify icon (material-symbols,
 * line-md, or devicon) by name from the generated, only-used data map (src/lib/icon-data.ts → `bun run gen:icons`),
 * so islands ship zero icon libraries and make no CDN call. Names funnel through src/icons.ts `ICON`, exactly like the
 * .astro side — one registry drives both. The emitted <svg> matches lucide's DOM shape (currentColor body, CSS-sizable
 * via the surrounding `[&_svg]:size-*` rules), so it's a drop-in replacement.
 */
export interface IconProps {
  /** A value from `ICON` in src/icons.ts, e.g. `ICON.search` (`"material-symbols:search-rounded"`). */
  name: string;
  className?: string;
}

export function Icon({ name, className }: IconProps) {
  // useId is hydration-stable across SSR/client, so the per-instance id suffix below never causes a mismatch.
  const uid = React.useId().replace(/:/g, "");
  const data = ICON_DATA[name];
  if (!data) {
    // The data map is generated from src/icons.ts; a name that isn't in it (typo, or a devicon name — those are
    // .astro-only) renders nothing. Surface it loudly in dev so the gap is caught before it ships.
    if (import.meta.env.DEV) {
      console.warn(`[Icon] "${name}" is not in icon-data.ts — add it to src/icons.ts ICON and run \`bun run gen:icons\`.`);
    }
    return null;
  }

  let body = data.body;
  // Multicolor devicon (and some line-md) bodies carry internal ids referenced via url(#id) / href="#id". When the
  // same icon renders twice those ids collide, so suffix each id per-instance. Longest-first avoids substring clobber.
  if (body.includes('id="')) {
    const ids = [...body.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
    for (const id of ids) {
      body = body.replaceAll(id, `${id}-${uid}`);
    }
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={data.viewBox}
      width="1em"
      height="1em"
      className={className}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
