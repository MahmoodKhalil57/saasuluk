import * as React from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { ICON } from "@/icons";
import { cn } from "@/lib/utils";

/**
 * AuthMenu (tier: BLOCK, interactive + data-aware) — a reusable extraction of saasuluk's premium account menu. It
 * paints instantly from the cached `su_user` localStorage hint (no "Sign in" flash for a returning user), then
 * confirms against `/api/auth/get-session` in the background — the same two-source strategy as src/client/auth.ts.
 * Signed out → a "Sign in" button; signed in → an avatar + dropdown (Dashboard / Orders / Wishlist / Sign out).
 */
type User = { name?: string; email?: string; image?: string };

function readHint(): User | null {
  try {
    return JSON.parse(localStorage.getItem("su_user") || "null");
  } catch {
    return null;
  }
}
function avatarSrc(u: User): string {
  return u.image || "/avatar?seed=" + encodeURIComponent(u.email || u.name || "user");
}
function initial(u: User): string {
  return (u.name || u.email || "?").trim().charAt(0).toUpperCase();
}

export interface AuthMenuProps {
  className?: string;
  loginHref?: string;
}

export function AuthMenu({ className, loginHref = "/login" }: AuthMenuProps) {
  const [user, setUser] = React.useState<User | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setUser(readHint());
    setReady(true);
    fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((s: { user?: (User & { id?: string }) | null } | null) => {
        const u = s?.user;
        if (u && u.id) {
          const next = { name: u.name, email: u.email, image: u.image };
          setUser(next);
          try {
            localStorage.setItem("su_user", JSON.stringify(next));
          } catch {
            /* storage disabled */
          }
        } else if (s && s.user === null) {
          setUser(null);
          try {
            localStorage.removeItem("su_user");
          } catch {
            /* storage disabled */
          }
        }
      })
      .catch(() => {
        /* offline / API error — keep the optimistic hint */
      });
  }, []);

  async function signOut() {
    try {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" });
    } catch {
      /* best-effort */
    }
    try {
      localStorage.removeItem("su_user");
    } catch {
      /* storage disabled */
    }
    location.href = "/";
  }

  // Until we've read the client-only hint, render a neutral placeholder (NOT "Sign in") so a returning signed-in user
  // never flashes "Sign in" before the avatar resolves — the SSR + first client render agree on this skeleton.
  if (!ready) {
    return <div className={cn("h-8 w-20 animate-pulse rounded-md bg-secondary", className)} aria-hidden />;
  }
  if (!user || !(user.name || user.email)) {
    return (
      <a href={loginHref} className={cn(buttonVariants({ size: "sm" }), className)}>
        Sign in
      </a>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-2 pr-2.5 pl-1.5", className)}>
          <Avatar className="size-6">
            <AvatarImage src={avatarSrc(user)} alt="" />
            <AvatarFallback>{initial(user)}</AvatarFallback>
          </Avatar>
          <span className="max-w-28 truncate">{user.name || user.email}</span>
          <Icon name={ICON.caret} className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-foreground">{user.name || "Account"}</span>
          {user.email && <span className="truncate text-xs">{user.email}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/panel">
            <Icon name={ICON.dashboard} /> Dashboard
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/panel/s/orders">
            <Icon name={ICON.orders} /> Orders
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/panel/s/wishlist">
            <Icon name={ICON.wishlist} /> Wishlist
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={signOut}>
          <Icon name={ICON.logout} /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
