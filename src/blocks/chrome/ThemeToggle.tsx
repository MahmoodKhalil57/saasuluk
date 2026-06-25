import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ICON } from "@/icons";
import { circleReveal } from "@/lib/circle-reveal";

/**
 * ThemeToggle (tier: BLOCK, interactive) — cycles light → dark → system with the expanding-circle reveal. A reusable
 * extraction of saasuluk's premium theme toggle: it reads/writes the SAME `localStorage["theme"]` and `data-theme` /
 * `data-themePref` on <html> the rest of the site uses, so it stays in lock-step with the no-flash THEME_STAMPER and
 * any other instance. Drop it anywhere as a `client:*` island.
 */
type ThemePref = "light" | "dark" | "system";
const ORDER: ThemePref[] = ["light", "dark", "system"];
const THEME_GLYPH: Record<ThemePref, React.ReactNode> = {
  light: <Icon name={ICON.themeLight} />,
  dark: <Icon name={ICON.themeDark} />,
  system: <Icon name={ICON.themeSystem} />,
};

function readPref(): ThemePref {
  try {
    const t = localStorage.getItem("theme");
    if (t === "light" || t === "dark" || t === "system") return t;
  } catch {
    /* storage disabled */
  }
  return "system";
}

function applyPref(pref: ThemePref): void {
  const root = document.documentElement;
  const dark = pref === "dark" || (pref === "system" && !!window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePref = pref;
  try {
    localStorage.setItem("theme", pref);
  } catch {
    /* storage disabled */
  }
}

export interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const [pref, setPref] = React.useState<ThemePref>("system");

  React.useEffect(() => {
    setPref(readPref());
    if (!window.matchMedia) return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readPref() === "system") applyPref("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function cycle(e: React.MouseEvent<HTMLButtonElement>) {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    circleReveal(e.currentTarget, () => applyPref(next));
    setPref(next);
  }

  return (
    <Button
      variant="outline"
      size="icon"
      className={className}
      onClick={cycle}
      aria-label={`Theme: ${pref} — click to change`}
      title={`Theme: ${pref}`}
    >
      {THEME_GLYPH[pref]}
    </Button>
  );
}
