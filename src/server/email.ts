/**
 * Email — a thin shim over @suluk/email's swappable EmailProvider (consoleProvider in dev, Workers-safe
 * resendProvider in prod). The package owns the SEND mechanism (the Resend-over-fetch binding, dev/prod selection);
 * saasuluk keeps only its branded HTML shell + the {sent,dev} contract its call sites use. Graceful: with no
 * RESEND_API_KEY, pickProvider returns the console provider (logs, never throws), so flows work with zero config.
 */
import { pickProvider } from "@suluk/email";

export interface SendEmail {
  to: string;
  subject: string;
  html: string;
}
/** On Cloudflare the secret comes from the Worker env, not process.env — callers pass it through explicitly. */
export interface EmailOpts {
  apiKey?: string;
  from?: string;
}

export async function sendEmail({ to, subject, html }: SendEmail, opts: EmailOpts = {}): Promise<{ sent: boolean; dev?: boolean }> {
  const apiKey = opts.apiKey || process.env.RESEND_API_KEY;
  const from = opts.from || process.env.EMAIL_FROM || "saasuluk <onboarding@resend.dev>";
  const dev = !apiKey;
  const r = await pickProvider({ dev, apiKey, from }).send({ to, subject, html });
  return { sent: r.ok, dev: dev || undefined };
}

/** A branded HTML shell (dark, matching the app) for transactional mail. App-owned branding/copy — stays in the app. */
export function brandedEmail(title: string, bodyHtml: string): string {
  return `<div style="background:#0b0e14;color:#cdd6f4;font-family:-apple-system,Segoe UI,sans-serif;padding:28px">
  <div style="max-width:520px;margin:0 auto;background:#11141c;border:1px solid #1e2433;border-radius:12px;padding:26px">
    <div style="color:#f5a97f;font-weight:700;letter-spacing:.04em;margin-bottom:14px">saasuluk</div>
    <h1 style="font-size:21px;margin:0 0 12px">${title}</h1>
    <div style="color:#cdd6f4;line-height:1.6;font-size:15px">${bodyHtml}</div>
    <p style="color:#9399b2;font-size:12px;margin-top:22px">Sent by saasuluk — a SaaS on Suluk. Every layer from one contract.</p>
  </div></div>`;
}

/** Fire-and-forget: send without blocking the response, swallowing errors (transactional mail is best-effort). */
export function sendEmailAsync(msg: SendEmail, opts: EmailOpts = {}): void {
  void sendEmail(msg, opts).catch(() => {
    /* best-effort */
  });
}
