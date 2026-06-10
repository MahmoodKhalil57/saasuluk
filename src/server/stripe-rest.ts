/**
 * A `StripeLike` over the Stripe REST API (fetch only — no SDK), so the @suluk/stripe helpers
 * (setupUsageBilling / stripeProvider / reportCostUsage) run on a Cloudflare Worker. Stripe's API is
 * form-encoded with bracket notation for nested params; `toForm` flattens the param objects the helpers build.
 */
import type { StripeLike } from "@suluk/stripe";

/** Flatten a params object into Stripe's bracket form-encoding (recurse objects + arrays). */
export function toForm(obj: Record<string, unknown>, prefix = "", form = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") toForm(item as Record<string, unknown>, `${key}[${i}]`, form);
        else form.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === "object") {
      toForm(v as Record<string, unknown>, key, form);
    } else {
      form.append(key, String(v));
    }
  }
  return form;
}

/** A duck-typed Stripe client backed by the REST API. `key` is the secret key. */
export function restStripe(key: string): StripeLike {
  const post = async (path: string, params: Record<string, unknown>): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
      body: toForm(params).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: { message?: string } })?.error?.message ?? `Stripe ${path} failed (${res.status})`);
    return json;
  };
  return {
    customers: { create: (p) => post("customers", p) },
    products: { create: (p) => post("products", p) },
    prices: { create: (p) => post("prices", p) },
    subscriptions: { create: (p) => post("subscriptions", p) },
    billing: {
      meters: { create: (p) => post("billing/meters", p) },
      meterEvents: { create: (p) => post("billing/meter_events", p) },
    },
    // verifyWebhook isn't used on the Worker (it has its own Web-Crypto HMAC check) — stub to satisfy the type.
    webhooks: { constructEvent: () => { throw new Error("constructEvent not supported by the REST adapter"); } },
  } as StripeLike;
}
