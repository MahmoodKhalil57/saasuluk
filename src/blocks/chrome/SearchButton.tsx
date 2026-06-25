import * as React from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { ICON } from "@/icons";
import { cn } from "@/lib/utils";

/**
 * SearchButton (tier: BLOCK, interactive + data-aware) — saasuluk's ⌘K command palette. Open with the button or
 * ⌘K/Ctrl+K, then jump to a page OR search the catalog: it debounces into the contract's `/search` op (products +
 * posts) — the same source the legacy palette used — and merges those hits with the static nav destinations. Navigate
 * with ↑/↓ + Enter (or click). A line-md spinner shows while the query is in flight. Pass `destinations` to retarget
 * the quick links or `searchEndpoint` to point at a different search op.
 */
type Kind = "page" | "product" | "post";
type Hit = { kind: Kind; label: string; href: string; hint?: string };

const KIND_ICON: Record<Kind, string> = { page: ICON.page, product: ICON.product, post: ICON.post };

const DEFAULT_DESTINATIONS: Hit[] = [
  { kind: "page", label: "Products", href: "/products", hint: "Browse the store" },
  { kind: "page", label: "Pricing", href: "/pricing" },
  { kind: "page", label: "Blog", href: "/blogs" },
  { kind: "page", label: "About", href: "/about" },
  { kind: "page", label: "Contact", href: "/contact" },
  { kind: "page", label: "API docs", href: "/reference" },
  { kind: "page", label: "Dashboard", href: "/panel" },
  { kind: "page", label: "Checkout", href: "/checkout" },
];

type SearchResponse = {
  products?: { name: string; slug: string }[];
  posts?: { title: string; slug: string }[];
};

export interface SearchButtonProps {
  className?: string;
  destinations?: Hit[];
  /** The contract's catalog search op — returns `{ products: [{name,slug}], posts: [{title,slug}] }`. */
  searchEndpoint?: string;
}

export function SearchButton({ className, destinations = DEFAULT_DESTINATIONS, searchEndpoint = "/search" }: SearchButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [remote, setRemote] = React.useState<Hit[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced catalog search (products + posts). The cleanup flag drops any stale in-flight response so the list never
  // flickers to an older query's results.
  React.useEffect(() => {
    const query = q.trim();
    if (!query) {
      setRemote([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(searchEndpoint + "?q=" + encodeURIComponent(query), { credentials: "same-origin" });
        const r: SearchResponse = await res.json();
        if (cancelled) return;
        setRemote([
          ...(r.products ?? []).map((p) => ({ kind: "product" as const, label: p.name, href: "/products/" + p.slug })),
          ...(r.posts ?? []).map((p) => ({ kind: "post" as const, label: p.title, href: "/blogs/" + p.slug })),
        ]);
      } catch {
        if (!cancelled) setRemote([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 170);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, searchEndpoint]);

  const navMatches = q ? destinations.filter((d) => d.label.toLowerCase().includes(q.toLowerCase())) : destinations;
  const list = q ? [...navMatches, ...remote] : destinations;
  React.useEffect(() => setActive(0), [q, open]);

  function go(href?: string) {
    const target = href ?? list[active]?.href;
    if (target) location.href = target;
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((x) => Math.min(x + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((x) => Math.max(x - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="icon"
        className={className}
        aria-label="Search (⌘K)"
        title="Search (⌘K)"
        onClick={() => setOpen(true)}
      >
        <Icon name={ICON.search} />
      </Button>
      <DialogContent showClose={false} className="top-[14%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Jump to a page or search products and posts</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Icon name={loading ? ICON.loading : ICON.search} className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, products, posts…"
            aria-label="Search"
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-2">
          {list.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">{loading ? "Searching…" : "No matches."}</li>
          )}
          {list.map((d, idx) => (
            <li key={`${d.kind}:${d.href}`}>
              <a
                href={d.href}
                onMouseEnter={() => setActive(idx)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  idx === active ? "bg-secondary text-foreground" : "text-foreground/90",
                )}
              >
                <Icon name={KIND_ICON[d.kind]} className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {d.label}
                  {d.hint && <span className="ml-2 text-xs text-muted-foreground">{d.hint}</span>}
                </span>
                {d.kind !== "page" && (
                  <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{d.kind}</span>
                )}
                <Icon name={ICON.arrowRight} className="size-4 shrink-0 opacity-40" />
              </a>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
