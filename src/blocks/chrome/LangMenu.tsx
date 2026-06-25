import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ICON } from "@/icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { LOCALES, LOCALE_LABEL, type Locale } from "@/i18n";

/**
 * LangMenu (tier: BLOCK, interactive) — a dropdown of the site locales. A reusable extraction of saasuluk's premium
 * language menu: picking a locale persists it (localStorage + cookie), keeps `window.__lang0` in sync, re-translates
 * the chrome via `window.__applyLang`, and fires `locale-changed` so on-page money/dates re-localize live — exactly
 * what the inline menu does. Locales come from the shared i18n contract.
 */
declare global {
  interface Window {
    __applyLang?: (l: string) => void;
    __lang0?: string;
  }
}

function currentLang(): string {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  try {
    return localStorage.getItem("lang") || "en";
  } catch {
    return "en";
  }
}

function setLang(l: Locale): void {
  try {
    localStorage.setItem("lang", l);
  } catch {
    /* storage disabled */
  }
  document.cookie = "lang=" + l + ";path=/;max-age=31536000;samesite=lax";
  window.__lang0 = l;
  if (window.__applyLang) window.__applyLang(l); // re-translate [data-i18n] chrome
  window.dispatchEvent(new Event("locale-changed")); // re-localize on-page money/dates
}

export interface LangMenuProps {
  className?: string;
}

export function LangMenu({ className }: LangMenuProps) {
  const [lang, setLangState] = React.useState<string>("en");

  React.useEffect(() => {
    setLangState(currentLang());
    const onChange = () => setLangState(currentLang());
    window.addEventListener("locale-changed", onChange);
    return () => window.removeEventListener("locale-changed", onChange);
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className={className} aria-label="Language">
          <Icon name={ICON.lang} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Language</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={lang} onValueChange={(v) => setLang(v as Locale)}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              {LOCALE_LABEL[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
