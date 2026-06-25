import * as React from "react";

import { cn } from "@/lib/utils";
import { SearchButton } from "./SearchButton";
import { SchemeMenu } from "./SchemeMenu";
import { LangMenu } from "./LangMenu";
import { ThemeToggle } from "./ThemeToggle";
import { CartButton } from "./CartButton";
import { AuthMenu } from "./AuthMenu";

/**
 * ChromeBar (tier: BLOCK) — the header-actions cluster, composing all the reusable premium chrome components (search,
 * scheme, language, theme, cart, account). Drop it into any section/header as a `client:*` island; each control drives
 * the whole page. `compact` drops the search + account controls for tight spaces (e.g. inside the mobile drawer).
 */
export interface ChromeBarProps {
  className?: string;
  compact?: boolean;
}

export function ChromeBar({ className, compact = false }: ChromeBarProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {!compact && <SearchButton />}
      <SchemeMenu />
      <LangMenu />
      <ThemeToggle />
      <CartButton />
      {!compact && <AuthMenu />}
    </div>
  );
}
