/**
 * Felt-UX wiring — @suluk/nano-stores interaction primitives on saasuluk's static-MPA shell:
 *   - a navigation progress bar (the asymptotic .navprogress from @suluk/theme's base CSS) that shows during the
 *     latency between an internal-link click / form navigation and the next page painting;
 *   - scroll-reveal for any [data-reveal] element (staggered, reduced-motion-gated by the base CSS).
 * Both degrade gracefully and are no-ops under reduced-motion (the CSS neutralizes the transitions).
 */
import { createProgressBar, revealOnScroll } from "@suluk/nano-stores";

function navProgress() {
  let bar = document.querySelector(".navprogress") as HTMLElement | null;
  if (!bar) { bar = document.createElement("div"); bar.className = "navprogress"; bar.setAttribute("aria-hidden", "true"); document.body.appendChild(bar); }
  const p = createProgressBar({ el: bar });
  let iv: number | null = null;
  const begin = () => { if (iv != null) return; p.start(); iv = window.setInterval(() => p.tick(), 140); };
  const end = () => { if (iv != null) { window.clearInterval(iv); iv = null; } p.done(); window.setTimeout(() => p.reset(), 300); };

  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    let sameOrigin = true;
    try { sameOrigin = new URL(a.href, location.href).origin === location.origin; } catch { /* keep true */ }
    if (sameOrigin) begin();
  }, true);
  window.addEventListener("beforeunload", begin);
  window.addEventListener("pageshow", end); // bfcache restore → clear a stale bar
}

function init() {
  navProgress();
  revealOnScroll(); // reveals [data-reveal] elements present at load (server-rendered sections)
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
