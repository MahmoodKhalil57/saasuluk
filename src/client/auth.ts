/**
 * Robust account-menu auth state across SPA navigation.
 *
 * Auth is the ONLY piece of chrome that depends on an async fetch (/api/auth/get-session), so it's the one thing that
 * can flicker if the header is ever re-rendered, prerender-activated, or the `transition:persist` is bypassed. So we
 * deliberately DON'T rely on persist holding: the auth UI is re-derived on EVERY astro:page-load from a single source
 * of truth, querying the header elements fresh each time. Source of truth, in order:
 *   1. the su_user localStorage hint — synchronous, paints instantly with no flash (like theme/cart do);
 *   2. the cached $session SWR store — authoritative, confirms/updates in the background.
 * A flaky get-session never signs you out (stores.ts throws on transient errors; we only sign out on a DEFINITIVE
 * signed-out response). This makes the login state correct whether the header persisted, was rebuilt, or the browser
 * activated a speculation-rules prerender (a fresh document) on navigation.
 */
import { $session } from "./stores";

type User = { name?: string; email?: string; image?: string };

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

function readHint(): User | null {
  try {
    return JSON.parse(localStorage.getItem("su_user") || "null");
  } catch {
    return null;
  }
}

function paintIn(u: User) {
  const signin = el("authsignin");
  const btn = el("authbtn");
  if (!btn || !signin) return; // header not in the DOM yet
  const name = u.name || (u.email || "").split("@")[0] || "Account";
  const img = u.image || "/avatar?seed=" + encodeURIComponent(u.email || name);
  const av = el<HTMLImageElement>("authavatar"); if (av) av.src = img;
  const nm = el("authname"); if (nm) nm.textContent = name;
  const pav = el<HTMLImageElement>("authpopavatar"); if (pav) pav.src = img;
  const pnm = el("authpopname"); if (pnm) pnm.textContent = name;
  const pem = el("authpopemail"); if (pem) pem.textContent = u.email || "";
  btn.hidden = false;
  signin.hidden = true;
  try { localStorage.setItem("su_user", JSON.stringify({ name, email: u.email, image: u.image })); } catch { /* private mode */ }
}

function paintOut() {
  const signin = el("authsignin");
  const btn = el("authbtn");
  const pop = el("authpop");
  if (btn) btn.hidden = true;
  if (pop) pop.hidden = true;
  if (signin) signin.hidden = false;
  try { localStorage.removeItem("su_user"); } catch { /* private mode */ }
}

/** Re-derive the header auth UI from the source of truth. Optimistic from the hint, authoritative from $session;
 *  NEVER flips to signed-out on an unknown/errored session — only on a definitive signed-out response. */
function render() {
  const s = $session.get() as { data?: { user?: User } | null; error?: unknown };
  if (s && "data" in s && s.data !== undefined) {
    const u = s.data && s.data.user;
    if (u) paintIn(u);
    else paintOut(); // data === null / no user ⇒ a real, confirmed signed-out response
    return;
  }
  // No authoritative answer yet (loading or errored). Paint optimistically; do NOT sign out.
  const hint = readHint();
  if (hint && (hint.name || hint.email)) paintIn(hint);
  else { const signin = el("authsignin"); if (signin) signin.hidden = false; }
}

/** Bind the dropdown toggle + sign-out. Guarded per element so a re-rendered header re-binds without double-binding a
 *  persisted one. */
function bindMenu() {
  const btn = el("authbtn");
  const pop = el("authpop");
  if (btn && pop && btn.dataset.authBound !== "1") {
    btn.dataset.authBound = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = pop.hidden;
      pop.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
    });
  }
  const so = el("authsignout");
  if (so && so.dataset.authBound !== "1") {
    so.dataset.authBound = "1";
    so.addEventListener("click", () => {
      so.textContent = "Signing out…";
      fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" })
        .then(() => { paintOut(); location.reload(); })
        .catch(() => { location.href = "/login"; });
    });
  }
}

let docBound = false;
function bindDocument() {
  if (docBound) return; // document is never replaced — bind the outside-click/Esc handlers exactly once
  docBound = true;
  document.addEventListener("click", (e) => {
    const pop = el("authpop");
    const btn = el("authbtn");
    if (pop && !pop.hidden && btn && !pop.contains(e.target as Node) && !btn.contains(e.target as Node)) {
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const pop = el("authpop");
    const btn = el("authbtn");
    if (pop && !pop.hidden) {
      pop.hidden = true;
      if (btn) { btn.setAttribute("aria-expanded", "false"); btn.focus(); }
    }
  });
}

function init() {
  bindDocument();
  bindMenu();
  render();
  $session.subscribe(render); // keeps the store warm + repaints on confirm/revalidation
  // The crux: re-derive on EVERY navigation, regardless of whether the header persisted, was rebuilt, or the browser
  // activated a prerendered document. Auth state is therefore correct on every route, not just the first.
  document.addEventListener("astro:page-load", () => { bindMenu(); render(); });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
