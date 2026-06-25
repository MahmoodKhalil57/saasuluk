import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * SignupBlock (tier: BLOCK, interactive) — a newsletter form built from the real React shadcn primitives (Input +
 * Label + Button). A data-aware block per the tiered model: the fetch logic is encapsulated here at the developer
 * tier; the section just drops it in (as a `client:*` island) and may override the labels. Hits saasuluk's existing
 * /newsletter/subscribe operation.
 */
export interface SignupBlockProps {
  placeholder?: string;
  ctaLabel?: string;
}

type Status = "idle" | "loading" | "done" | "error";

export function SignupBlock({ placeholder = "you@example.com", ctaLabel = "Subscribe" }: SignupBlockProps) {
  const [email, setEmail] = React.useState("");
  const [status, setStatus] = React.useState<Status>("idle");
  const [message, setMessage] = React.useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("loading");
    try {
      const r = await fetch("/newsletter/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-suluk-action": "newsletter" },
        credentials: "same-origin",
        body: JSON.stringify({ email }),
      });
      const d = (await r.json().catch(() => ({}))) as { subscribed?: boolean; already?: boolean };
      if (d.subscribed) {
        setStatus("done");
        setMessage(d.already ? "You're already subscribed ✓" : "Subscribed ✓");
        setEmail("");
      } else {
        setStatus("error");
        setMessage("Please enter a valid email.");
      }
    } catch {
      setStatus("error");
      setMessage("Could not subscribe — please try again.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-md flex-col gap-3">
      <Label htmlFor="signup-email" className="sr-only">
        Email address
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="signup-email"
          type="email"
          required
          placeholder={placeholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === "loading"}
        />
        <Button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "…" : ctaLabel}
        </Button>
      </div>
      {message && <p className={status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message}</p>}
    </form>
  );
}
