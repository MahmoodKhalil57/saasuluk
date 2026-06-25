import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ICON } from "@/icons";
import { circleReveal } from "@/lib/circle-reveal";
import { cn } from "@/lib/utils";

/**
 * SchemeMenu (tier: BLOCK, interactive) — the color-scheme picker. A reusable extraction of saasuluk's premium scheme
 * popover: a searchable grid of swatches (bg · primary · accent per scheme) that, on pick, plays the expanding-circle
 * reveal and sets `data-scheme` + `localStorage["scheme"]` on <html> — interoperable with the rest of the site. The
 * 43-scheme catalog is read from `window.__schemes` (Layout embeds it at build, already parsed) so the island stays
 * tiny; pass `schemes` to use it standalone.
 */
type Swatch = { name: string; label: string; light: string[]; dark: string[] };
declare global {
  interface Window {
    __schemes?: Swatch[];
  }
}

function currentScheme(): string {
  return (typeof document !== "undefined" && document.documentElement.dataset.scheme) || "";
}
function activeIsDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}
function applyScheme(name: string): void {
  const root = document.documentElement;
  if (name) {
    root.dataset.scheme = name;
    try {
      localStorage.setItem("scheme", name);
    } catch {
      /* storage disabled */
    }
  } else {
    delete root.dataset.scheme;
    try {
      localStorage.removeItem("scheme");
    } catch {
      /* storage disabled */
    }
  }
}

export interface SchemeMenuProps {
  className?: string;
  schemes?: Swatch[];
}

export function SchemeMenu({ className, schemes }: SchemeMenuProps) {
  const all = schemes ?? (typeof window !== "undefined" ? window.__schemes : undefined) ?? [];
  const [active, setActive] = React.useState("");
  const [dark, setDark] = React.useState(false);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    setActive(currentScheme());
    setDark(activeIsDark());
  }, []);

  const list = q ? all.filter((s) => s.label.toLowerCase().includes(q.toLowerCase())) : all;

  function pick(e: React.MouseEvent<HTMLButtonElement>, name: string) {
    circleReveal(e.currentTarget, () => applyScheme(name));
    setActive(name);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className={className} aria-label="Color scheme">
          <Icon name={ICON.scheme} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border p-3">
          <div className="relative">
            <Icon
              name={ICON.search}
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search schemes…"
              className="pl-8"
              aria-label="Search color schemes"
            />
          </div>
        </div>
        <div className="grid max-h-72 grid-cols-2 gap-1.5 overflow-y-auto p-3">
          {list.length === 0 && <p className="col-span-2 py-6 text-center text-sm text-muted-foreground">No schemes match.</p>}
          {list.map((s) => {
            const cols = (dark ? s.dark : s.light).slice(0, 3);
            const on = s.name === active;
            return (
              <button
                key={s.name || "default"}
                type="button"
                onClick={(e) => pick(e, s.name)}
                aria-pressed={on}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-left text-sm transition-colors",
                  on ? "border-primary bg-secondary/60" : "border-border hover:bg-secondary/50",
                )}
              >
                <span className="flex shrink-0 items-center">
                  {cols.map((c, i) => (
                    <span
                      key={i}
                      className="size-4 rounded-full ring-1 ring-border"
                      style={{ background: c, marginLeft: i ? "-6px" : 0 }}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {on && <Icon name={ICON.check} className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
