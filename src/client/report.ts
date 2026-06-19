/**
 * In-app feedback/report tool (issue #11). Type "report" anywhere (outside a text field) → pick any element on the
 * page (hover-highlight + dim, click to select) → a dialog to add a note and opt into what to include (the element,
 * its CSS, the page, your details, the build/time, a full-page screenshot) → POST to the Report entity for the site
 * owners. Escape, clicking the backdrop, or the × exits at any step. Self-contained; html2canvas is lazy-loaded only
 * when a screenshot is requested.
 */
import { BUILD_ID } from "../build-id";

type Mode = "idle" | "picking" | "dialog";
let mode: Mode = "idle";
let typed = "";
let hoverBox: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;
let backdrop: HTMLDivElement | null = null;

const TRIGGER = "report";
const PFX = "sk-report"; // every node this tool injects is id/class-prefixed so the screenshot + picker can skip it
const mine = (el: Element | null): boolean => !!el && !!el.closest(`[id^="${PFX}"]`);

const toast = (msg: string, type: "success" | "error" = "success") => {
  const w = window as unknown as { toast?: (m: string, o?: { type?: string }) => void };
  if (w.toast) w.toast(msg, { type });
};

/** A short, reasonably-stable CSS selector path for the picked element. */
function selectorOf(el: HTMLElement): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const cls = (typeof node.className === "string" ? node.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += "." + cls.join(".");
    const parent = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/** The computed styles most useful for debugging a visual report. */
function cssOf(el: HTMLElement): Record<string, string> {
  const s = getComputedStyle(el);
  const keys = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "color",
    "backgroundColor",
    "font",
    "border",
    "zIndex",
    "overflow",
    "flex",
    "gridTemplateColumns",
    "transform",
    "opacity",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = s.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
    if (v && v !== "none" && v !== "normal" && v !== "auto") out[k] = v;
  }
  return out;
}

// ── element picking ──────────────────────────────────────────────────────────────────────────────────────────
function ensureChrome() {
  if (!hoverBox) {
    hoverBox = document.createElement("div");
    hoverBox.id = `${PFX}-hover`;
    document.body.appendChild(hoverBox);
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = `${PFX}-banner`;
    banner.innerHTML = `<span><b>Report mode</b> — click any element to report it</span><kbd>Esc</kbd> to cancel`;
    document.body.appendChild(banner);
  }
}

function onMove(e: MouseEvent) {
  if (mode !== "picking" || !hoverBox) return;
  const el = e.target as HTMLElement;
  if (mine(el)) {
    hoverBox.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  hoverBox.style.display = "block";
  hoverBox.style.transform = `translate(${r.left}px, ${r.top}px)`;
  hoverBox.style.width = `${r.width}px`;
  hoverBox.style.height = `${r.height}px`;
}

function onPick(e: MouseEvent) {
  if (mode !== "picking") return;
  const el = e.target as HTMLElement;
  if (mine(el)) return;
  e.preventDefault();
  e.stopPropagation();
  stopPicking();
  openDialog(el);
}

function startPicking() {
  if (mode !== "idle") return;
  mode = "picking";
  document.documentElement.classList.add(`${PFX}-active`);
  ensureChrome();
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onPick, true);
}

function stopPicking() {
  document.removeEventListener("mousemove", onMove, true);
  document.removeEventListener("click", onPick, true);
  document.documentElement.classList.remove(`${PFX}-active`);
  if (hoverBox) hoverBox.style.display = "none";
  if (banner) (banner.remove(), (banner = null));
  if (mode === "picking") mode = "idle";
}

// ── dialog ───────────────────────────────────────────────────────────────────────────────────────────────────
function openDialog(el: HTMLElement) {
  mode = "dialog";
  const sel = selectorOf(el);
  backdrop = document.createElement("div");
  backdrop.id = `${PFX}-backdrop`;
  backdrop.innerHTML = `
    <div id="${PFX}-dialog" role="dialog" aria-modal="true" aria-label="Report an issue">
      <div class="${PFX}-head"><strong>Report an issue</strong><button class="${PFX}-x" aria-label="Close">&times;</button></div>
      <div class="${PFX}-body">
        <p class="${PFX}-target">Selected: <code>${sel.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</code></p>
        <textarea id="${PFX}-note" rows="3" placeholder="What's wrong? (optional)"></textarea>
        <div class="${PFX}-opts">
          <label><input type="checkbox" data-opt="screenshot" checked /> Full-page screenshot</label>
          <label><input type="checkbox" data-opt="element" checked /> Element details</label>
          <label><input type="checkbox" data-opt="css" checked /> CSS details</label>
          <label><input type="checkbox" data-opt="page" checked /> Page details</label>
          <label><input type="checkbox" data-opt="user" checked /> Your details</label>
          <label><input type="checkbox" data-opt="build" checked /> Build + time</label>
        </div>
        <p id="${PFX}-msg" class="${PFX}-msg" aria-live="polite"></p>
      </div>
      <div class="${PFX}-foot">
        <button class="${PFX}-cancel">Cancel</button>
        <button class="${PFX}-send">Send report</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => closeAll();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector(`.${PFX}-x`)!.addEventListener("click", close);
  backdrop.querySelector(`.${PFX}-cancel`)!.addEventListener("click", close);
  const send = backdrop.querySelector(`.${PFX}-send`) as HTMLButtonElement;
  send.addEventListener("click", () => submit(el, sel, send));
  (backdrop.querySelector(`#${PFX}-note`) as HTMLTextAreaElement)?.focus();
}

function closeAll() {
  stopPicking();
  if (backdrop) (backdrop.remove(), (backdrop = null));
  mode = "idle";
}

// ── submit ───────────────────────────────────────────────────────────────────────────────────────────────────
async function captureScreenshot(): Promise<string | null> {
  try {
    const html2canvas = (await import("html2canvas")).default;
    const scale = Math.min(1, 1200 / Math.max(1, window.innerWidth));
    const canvas = await html2canvas(document.body, {
      useCORS: true,
      allowTaint: false,
      logging: false,
      scale,
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--bg") || "#fff",
      ignoreElements: (el) => typeof el.id === "string" && el.id.startsWith(PFX),
    });
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch {
    return null; // a tainted canvas (cross-origin image) or any failure → submit without the screenshot
  }
}

async function userEmail(): Promise<string | null> {
  try {
    const r = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    const s = (await r.json()) as { user?: { email?: string } } | null;
    return s?.user?.email ?? null;
  } catch {
    return null;
  }
}

async function submit(el: HTMLElement, sel: string, btn: HTMLButtonElement) {
  if (!backdrop) return;
  const opt = (name: string) => (backdrop!.querySelector(`[data-opt="${name}"]`) as HTMLInputElement)?.checked;
  const msg = backdrop.querySelector(`#${PFX}-msg`) as HTMLElement;
  btn.disabled = true;
  msg.textContent = opt("screenshot") ? "Capturing…" : "Sending…";

  const root = document.documentElement;
  const payload: Record<string, unknown> = {
    note: ((backdrop.querySelector(`#${PFX}-note`) as HTMLTextAreaElement)?.value || "").slice(0, 5000),
    url: location.href.slice(0, 2000),
    status: "new",
    createdAt: Date.now(),
  };
  if (opt("element")) {
    payload.selector = sel.slice(0, 800);
    payload.elementHtml = el.outerHTML.slice(0, 20_000);
  }
  if (opt("css")) payload.elementCss = JSON.stringify(cssOf(el)).slice(0, 20_000);
  if (opt("page"))
    payload.pageInfo = JSON.stringify({
      title: document.title,
      referrer: document.referrer,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      scrollY: Math.round(window.scrollY),
      dpr: window.devicePixelRatio,
    });
  if (opt("user"))
    payload.userInfo = JSON.stringify({
      email: opt("user") ? await userEmail() : null,
      userAgent: navigator.userAgent,
      locale: root.lang || navigator.language,
      dir: root.dir,
      theme: root.dataset.themePref || root.dataset.theme,
      scheme: root.dataset.scheme || "default",
    });
  if (opt("build")) payload.buildId = BUILD_ID;
  if (opt("screenshot")) {
    const shot = await captureScreenshot();
    if (shot && shot.length < 1_400_000) payload.screenshot = shot;
  }

  try {
    const r = await fetch("/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-suluk-action": "report" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(String(r.status));
    closeAll();
    toast("Thanks — your report was sent ✓", "success");
  } catch {
    msg.innerHTML = `<span style="color:#e5484d">Could not send the report. Please try again.</span>`;
    btn.disabled = false;
  }
}

// ── trigger ──────────────────────────────────────────────────────────────────────────────────────────────────
function wire() {
  if ((window as unknown as { __reportWired?: boolean }).__reportWired) return;
  (window as unknown as { __reportWired?: boolean }).__reportWired = true;
  // inject styles once
  const style = document.createElement("style");
  style.id = `${PFX}-style`;
  style.textContent = `
    html.${PFX}-active, html.${PFX}-active * { cursor: crosshair !important; }
    #${PFX}-hover { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none; display: none;
      background: color-mix(in srgb, var(--accent, #6366f1) 18%, transparent);
      outline: 2px solid var(--accent, #6366f1); outline-offset: -1px; border-radius: 3px;
      box-shadow: 0 0 0 9999px rgba(0,0,0,.18); transition: transform .04s linear, width .04s linear, height .04s linear; }
    #${PFX}-banner { position: fixed; z-index: 2147483647; left: 50%; top: 16px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px; background: var(--panel, #fff); color: var(--fg, #111);
      border: 1px solid var(--line, #ddd); border-radius: 999px; padding: 8px 16px; font: 500 13px/1 system-ui, sans-serif;
      box-shadow: 0 12px 40px rgba(0,0,0,.25); }
    #${PFX}-banner kbd { border: 1px solid var(--line, #ccc); border-radius: 5px; padding: 2px 6px; font: inherit; }
    #${PFX}-backdrop { position: fixed; inset: 0; z-index: 2147483647; background: rgba(8,8,24,.5);
      display: grid; place-items: center; padding: 18px; }
    #${PFX}-dialog { width: min(460px, 100%); max-height: 90vh; overflow: auto; background: var(--panel, #fff);
      color: var(--fg, #111); border: 1px solid var(--line, #ddd); border-radius: 16px; box-shadow: 0 30px 80px rgba(8,8,24,.45);
      font: 14px/1.5 system-ui, sans-serif; }
    #${PFX}-dialog .${PFX}-head { display: flex; justify-content: space-between; align-items: center; padding: 15px 18px; border-bottom: 1px solid var(--line, #eee); }
    #${PFX}-dialog .${PFX}-head strong { font-size: 16px; }
    #${PFX}-dialog .${PFX}-x { background: none; border: 0; font-size: 22px; line-height: 1; color: var(--muted, #888); cursor: pointer; }
    #${PFX}-dialog .${PFX}-body { padding: 16px 18px; display: grid; gap: 12px; }
    #${PFX}-dialog .${PFX}-target { margin: 0; font-size: 12.5px; color: var(--muted, #777); word-break: break-all; }
    #${PFX}-dialog .${PFX}-target code { background: var(--bg-soft, #f4f4f5); padding: 2px 6px; border-radius: 5px; }
    #${PFX}-dialog textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 9px 11px; border: 1px solid var(--line, #ddd);
      border-radius: 9px; background: var(--bg, #fff); color: var(--fg, #111); font: inherit; }
    #${PFX}-dialog .${PFX}-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 14px; font-size: 13px; }
    #${PFX}-dialog .${PFX}-opts label { display: flex; align-items: center; gap: 7px; cursor: pointer; }
    #${PFX}-dialog .${PFX}-msg { margin: 0; font-size: 12.5px; min-height: 1px; }
    #${PFX}-dialog .${PFX}-msg:empty { display: none; }
    #${PFX}-dialog .${PFX}-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--line, #eee); }
    #${PFX}-dialog .${PFX}-foot button { font: inherit; padding: 8px 16px; border-radius: 9px; cursor: pointer; border: 1px solid var(--line, #ddd); background: var(--bg-soft, #f4f4f5); color: var(--fg, #111); }
    #${PFX}-dialog .${PFX}-send { background: var(--accent, #6366f1) !important; color: var(--on-accent, #fff) !important; border-color: transparent !important; font-weight: 600; }
    @media (max-width: 420px) { #${PFX}-dialog .${PFX}-opts { grid-template-columns: 1fr; } }`;
  document.head.appendChild(style);

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && mode !== "idle") {
        closeAll();
        return;
      }
      if (mode !== "idle") return;
      const t = e.target as HTMLElement;
      if (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 && /[a-z]/i.test(e.key)) {
        typed = (typed + e.key.toLowerCase()).slice(-TRIGGER.length);
        if (typed === TRIGGER) {
          typed = "";
          startPicking();
        }
      } else {
        typed = "";
      }
    },
    true,
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();
