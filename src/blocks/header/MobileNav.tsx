import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChromeBar } from "@/blocks/chrome/ChromeBar";
import { ICON } from "@/icons";
import { SITE_NAV, type NavLink } from "@/lib/site-nav";
import { isWorkerHref } from "@/lib/worker-routes";

/**
 * MobileNav (tier: BLOCK, interactive) — the hamburger menu for narrow viewports: a left Sheet with the primary nav
 * links plus the compact chrome (scheme · language · theme · cart) so the controls stay reachable on mobile, mirroring
 * the real site's mobile drawer. Composes the nav data + the ChromeBar block.
 */
export interface MobileNavProps {
  items?: NavLink[];
  className?: string;
}

export function MobileNav({ items = SITE_NAV, className }: MobileNavProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className={className} aria-label="Open menu">
          <Icon name={ICON.menu} />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3" aria-label="Mobile">
          {items.map((it) => (
            <a
              key={it.href}
              href={it.href}
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
              data-astro-reload={isWorkerHref(it.href) ? "" : undefined}
              data-astro-prefetch={isWorkerHref(it.href) ? "false" : undefined}
            >
              {it.label}
            </a>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <ChromeBar compact className="flex-wrap justify-start" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
