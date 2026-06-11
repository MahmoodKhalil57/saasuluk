/**
 * saasuluk's CONFIGURATION — declared ONCE with @suluk/env's defineEnv, the single source of truth for config,
 * the same "declare once, project everywhere" idea as the entity registry (domain.ts) but for env vars. It projects:
 *   • typed, validated access   → env.parse(process.env)
 *   • a per-surface manifest     → env.forSurface("cloudflare") tells the deploy which secrets to push
 *   • a config-HEALTH view       → rendered at GET /config (admin-only), on BOTH the dev server and the Worker
 *
 * Secret VALUES can be committed encrypted with the `suluk-env` CLI (post-quantum ML-KEM-768) — so the .env is
 * safe in git and shareable; the private key stays in .env.keys / a Cloudflare secret. See .env.example.
 */
import { defineEnv, type ManifestEntry, type HealthStatus } from "@suluk/env";

export const env = defineEnv({
  BETTER_AUTH_SECRET:      { secret: true, required: true, surfaces: ["local", "cloudflare"], description: "Better Auth signing secret (openssl rand -base64 32)" },
  BASE_URL:                { default: "http://localhost:3000", surfaces: ["local", "preview"], description: "Public base URL (dev)" },
  STRIPE_SECRET_KEY:       { secret: true, surfaces: ["local", "cloudflare"], description: "Stripe API key — enables checkout + usage billing" },
  STRIPE_PUBLISHABLE_KEY:  { surfaces: ["local", "cloudflare"], description: "Stripe publishable key (client)" },
  STRIPE_WEBHOOK_SECRET:   { secret: true, surfaces: ["cloudflare", "local"], description: "Stripe webhook signing secret (whsec_…)" },
  STRIPE_METER_EVENT_NAME: { default: "saasuluk_cost", surfaces: ["cloudflare"], description: "Stripe Billing Meter event name" },
  STRIPE_METERED_PRICE_ID: { surfaces: ["cloudflare"], description: "Stripe metered Price id for usage billing" },
  RESEND_API_KEY:          { secret: true, surfaces: ["local", "cloudflare"], description: "Resend API key — outbound email (magic links, newsletter)" },
  EMAIL_FROM:              { default: "saasuluk <onboarding@resend.dev>", surfaces: ["local", "cloudflare"], description: "From address for outbound email" },
  GOOGLE_CLIENT_ID:        { surfaces: ["local", "cloudflare"], description: "Google OAuth client id" },
  GOOGLE_CLIENT_SECRET:    { secret: true, surfaces: ["local", "cloudflare"], description: "Google OAuth client secret" },
  SUPERADMIN_EMAILS:       { surfaces: ["local", "cloudflare"], description: 'JSON array of admin emails, e.g. ["you@example.com"]' },
});

export interface ConfigHealth { surfaces: { cloudflare: string[]; local: string[] }; vars: ManifestEntry[] }

/** A SAFE config-health snapshot (never returns any values) from a runtime env bag — process.env (dev) or the
 *  Worker's c.env bindings. Each var: which surfaces need it, is it a secret, and is it present on this surface. */
export function configHealth(runtime: Record<string, string | undefined>): ConfigHealth {
  return { surfaces: { cloudflare: env.forSurface("cloudflare"), local: env.forSurface("local") }, vars: env.manifest({}, runtime) };
}

const BADGE: Record<HealthStatus, { label: string; bg: string; fg: string }> = {
  ok: { label: "set", bg: "#dcfce7", fg: "#166534" },
  missing: { label: "MISSING", bg: "#fee2e2", fg: "#991b1b" },
  "plaintext-secret": { label: "plaintext!", bg: "#fef9c3", fg: "#854d0e" },
  empty: { label: "not set", bg: "#f1f5f9", fg: "#475569" },
};

/** Render the config health as a self-contained premium HTML page (the "admin panel" surface). */
export function renderConfigHealth(h: ConfigHealth): string {
  const rows = h.vars.map((v) => {
    const b = BADGE[v.status];
    return `<tr>
      <td><code>${v.name}</code>${v.secret ? ' <span class="lock" title="secret">🔒</span>' : ""}${v.required ? ' <span class="req" title="required">*</span>' : ""}</td>
      <td class="muted">${v.surfaces.join(", ")}</td>
      <td><span class="badge" style="background:${b.bg};color:${b.fg}">${b.label}</span></td>
      <td class="muted">${v.description ?? ""}</td>
    </tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Config health · saasuluk</title>
  <style>
    :root{--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#6366f1}
    *{box-sizing:border-box}body{font:15px/1.5 Inter,system-ui,sans-serif;color:var(--fg);margin:0;background:#f8fafc}
    .wrap{max-width:860px;margin:0 auto;padding:40px 20px}
    h1{font-size:24px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
    th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
    th{background:#f1f5f9;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    tr:last-child td{border-bottom:0}code{font:13px ui-monospace,monospace;background:#f1f5f9;padding:1px 6px;border-radius:5px}
    .muted{color:var(--muted)}.badge{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}
    .req{color:var(--accent);font-weight:700}.lock{font-size:12px}
    .note{margin-top:18px;color:var(--muted);font-size:13px}.note code{font-size:12px}
  </style></head><body><div class="wrap">
    <h1>Configuration health</h1>
    <p class="sub">One declaration in <code>src/server/env.ts</code> (@suluk/env) — projected here, into the deploy planner, and into typed access. Values are never shown. <span class="req">*</span> required · 🔒 secret.</p>
    <table><thead><tr><th>Variable</th><th>Surfaces</th><th>This surface</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">Secrets can be committed encrypted (post-quantum) with <code>suluk-env encrypt</code>; the deploy pushes <code>env.forSurface("cloudflare")</code> as Worker secrets.</p>
  </div></body></html>`;
}
