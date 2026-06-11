/**
 * Toasts — a tiny, dependency-free notification layer on the same bundled-module surface as the cart. Exposes
 * `window.toast(message, { type, duration })`; the inline page handlers (add-to-cart, checkout, forms) call it
 * from POST-load user actions, so the global is always set by the time it's used (the module is a deferred ES
 * module — it runs before any click). Accessible: the live region announces, errors use role=alert.
 */
type ToastType = "success" | "error" | "info";
interface ToastOpts { type?: ToastType; duration?: number }

const ICON: Record<ToastType, string> = { success: "✓", error: "✕", info: "ℹ" };

function container(): HTMLElement {
  let c = document.getElementById("toasts");
  if (!c) {
    c = document.createElement("div");
    c.id = "toasts";
    c.className = "toasts";
    c.setAttribute("aria-live", "polite");
    c.setAttribute("aria-atomic", "false");
    document.body.appendChild(c);
  }
  return c;
}

function toast(message: string, opts: ToastOpts = {}): void {
  const type = opts.type ?? "info";
  const c = container();
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.innerHTML = `<span class="toast-ic" aria-hidden="true">${ICON[type]}</span><span class="toast-msg"></span><button class="toast-x" aria-label="Dismiss">&times;</button>`;
  (t.querySelector(".toast-msg") as HTMLElement).textContent = message; // textContent → no HTML injection
  c.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  const dismiss = () => { t.classList.remove("in"); t.classList.add("out"); window.clearTimeout(timer); window.setTimeout(() => t.remove(), 240); };
  const timer = window.setTimeout(dismiss, opts.duration ?? 3200);
  (t.querySelector(".toast-x") as HTMLElement).addEventListener("click", dismiss);
}

(window as unknown as { toast?: typeof toast }).toast = toast;
