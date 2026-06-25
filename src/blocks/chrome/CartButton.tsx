import * as React from "react";
import { useStore } from "@nanostores/react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { ICON } from "@/icons";
import { cartStore, money } from "@/lib/cart-store";
import { cn } from "@/lib/utils";

/**
 * CartButton (tier: BLOCK, interactive + data-aware) — a reusable extraction of saasuluk's premium cart: a badge-count
 * button that opens a Sheet drawer with line items (qty steppers + remove), live subtotal and a Checkout CTA. It reads
 * the shared cart store (so it reflects items added anywhere on the site), and re-formats money on `locale-changed`. A
 * `mounted` guard keeps SSR (empty) and the first client render in step, then reveals the real cart — no hydration
 * mismatch.
 */
export interface CartButtonProps {
  className?: string;
  checkoutHref?: string;
}

export function CartButton({ className, checkoutHref = "/checkout" }: CartButtonProps) {
  const itemsMap = useStore(cartStore.$items);
  const count = useStore(cartStore.$count);
  const subtotal = useStore(cartStore.$subtotalCents);
  const [mounted, setMounted] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [, force] = React.useReducer((x: number) => x + 1, 0);

  React.useEffect(() => {
    setMounted(true);
    cartStore.reload(); // surface any write that bypassed the store (e.g. an inline add-to-cart)
    const onLocale = () => force();
    // Programmatic open hook — the AI chat's "openCart" tool (and any non-React caller) dispatches `su:cart:open`,
    // since the legacy #cartbtn it used to click is now hidden chrome.
    const onOpen = () => setOpen(true);
    window.addEventListener("locale-changed", onLocale);
    window.addEventListener("su:cart:open", onOpen);
    return () => {
      window.removeEventListener("locale-changed", onLocale);
      window.removeEventListener("su:cart:open", onOpen);
    };
  }, []);

  const lines = React.useMemo(() => cartStore.lines(), [itemsMap]);
  const n = mounted ? count : 0;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={cn("relative", className)}
          aria-label={n ? `Open cart — ${n} item${n === 1 ? "" : "s"}` : "Open cart"}
        >
          <Icon name={ICON.cart} />
          {n > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex min-w-[1.1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-bold text-primary-foreground">
              {n}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Cart</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-3">
          {!mounted || lines.length === 0 ? (
            <p className="py-20 text-center text-sm text-muted-foreground">Your cart is empty.</p>
          ) : (
            <ul className="flex flex-col">
              {lines.map((l) => (
                <li key={`${l.productId}:${l.variantId ?? ""}`} className="flex gap-3 border-b border-border py-3">
                  {l.image ? (
                    <img src={l.image} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg border border-border object-cover" />
                  ) : (
                    <span className="size-14 shrink-0 rounded-lg border border-border bg-secondary" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-semibold">{l.name}</span>
                      <span className="shrink-0 font-mono text-sm">{money(l.priceCents * l.qty)}</span>
                    </div>
                    {l.variantLabel ? <div className="text-xs text-muted-foreground">{l.variantLabel}</div> : null}
                    <div className="mt-2 flex items-center gap-1.5">
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-7"
                        aria-label="Decrease quantity"
                        onClick={() => cartStore.setQty(l.productId, l.qty - 1, l.variantId)}
                      >
                        <Icon name={ICON.minus} />
                      </Button>
                      <span className="min-w-6 text-center text-sm tabular-nums">{l.qty}</span>
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-7"
                        aria-label="Increase quantity"
                        onClick={() => cartStore.setQty(l.productId, l.qty + 1, l.variantId)}
                      >
                        <Icon name={ICON.plus} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto size-7 text-muted-foreground"
                        aria-label="Remove item"
                        onClick={() => cartStore.remove(l.productId, l.variantId)}
                      >
                        <Icon name={ICON.close} />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <SheetFooter>
          <div className="flex items-center justify-between text-sm">
            <span>Subtotal</span>
            <span className="font-mono font-bold">{money(mounted ? subtotal : 0)}</span>
          </div>
          <a
            href={checkoutHref}
            className={cn(buttonVariants(), "w-full", n === 0 && "pointer-events-none opacity-45")}
            aria-disabled={n === 0}
            tabIndex={n === 0 ? -1 : 0}
          >
            Checkout
          </a>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
