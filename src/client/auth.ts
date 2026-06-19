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
  const av = el<HTMLImageElement>("authavatar");
  if (av) av.src = img;
  const nm = el("authname");
  if (nm) nm.textContent = name;
  const pav = el<HTMLImageElement>("authpopavatar");
  if (pav) pav.src = img;
  const pnm = el("authpopname");
  if (pnm) pnm.textContent = name;
  const pem = el("authpopemail");
  if (pem) pem.textContent = u.email || "";
  btn.hidden = false;
  signin.hidden = true;
  try {
    localStorage.setItem("su_user", JSON.stringify({ name, email: u.email, image: u.image }));
  } catch {
    /* private mode */
  }
}

function paintOut() {
  const signin = el("authsignin");
  const btn = el("authbtn");
  const pop = el("authpop");
  if (btn) btn.hidden = true;
  if (pop) pop.hidden = true;
  if (signin) signin.hidden = false;
  try {
    localStorage.removeItem("su_user");
  } catch {
    /* private mode */
  }
}

// Once we've seen a DEFINITIVE signed-out response we remember it, so a later transient/undefined store state (e.g. a
// failed refetch) can't be misread as "signed in" via a stale hint. Reset the moment we see a real user again.
let confirmedOut = false;

/** Re-derive the header auth UI from the source of truth (issue #5). Three states, and the ONLY thing that signs the
 *  user out is a CONFIRMED signed-out response (200 + null / 401 / 403 → data === null with no error). A transient
 *  failure, loading, or an undefined store value NEVER signs out — it paints optimistically from the su_user hint. */
function render() {
  const s = $session.get() as { data?: { user?: User } | null; error?: unknown; loading?: boolean };
  const user = s && s.data && s.data.user;
  if (user) {
    confirmedOut = false;
    paintIn(user); // confirmed signed-IN
    return;
  }
  if (s && s.data === null && !s.error) {
    confirmedOut = true;
    paintOut(); // confirmed signed-OUT — a real null response, not an error
    return;
  }
  // transient / errored / loading / undefined → do NOT sign out. Paint optimistically from the hint.
  const hint = readHint();
  if (hint && (hint.name || hint.email)) paintIn(hint);
  else if (confirmedOut)
    paintOut(); // we previously confirmed signed-out and have no hint — keep it signed-out
  else {
    const signin = el("authsignin");
    if (signin) signin.hidden = false; // unknown + no hint → show "Sign in" (without removing su_user)
  }
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
        .then(() => {
          paintOut();
          location.reload();
        })
        .catch(() => {
          location.href = "/login";
        });
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
      if (btn) {
        btn.setAttribute("aria-expanded", "false");
        btn.focus();
      }
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
  document.addEventListener("astro:page-load", () => {
    bindMenu();
    render();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
