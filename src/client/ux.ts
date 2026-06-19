/**
 * Felt-UX wiring — @suluk/nano-stores interaction primitives on saasuluk's static-MPA shell:
 *   - a navigation progress bar (the asymptotic .navprogress from @suluk/theme's base CSS) that shows during the
 *     latency between an internal-link click / form navigation and the next page painting;
 *   - scroll-reveal for any [data-reveal] element (staggered, reduced-motion-gated by the base CSS).
 * Both degrade gracefully and are no-ops under reduced-motion (the CSS neutralizes the transitions).
 */
import { createProgressBar, revealOnScroll, createDrawer, type PanelEl } from "@suluk/nano-stores";

function mobileNav() {
  const drawer = document.getElementById("mobilenav");
  const back = document.getElementById("navback");
  const toggle = document.getElementById("navtoggle");
  const closeBtn = document.getElementById("navclose");
  if (!drawer || !back || !toggle) return;
  const chrome = () =>
    [document.querySelector("header.site"), document.querySelector("main"), document.querySelector("footer.site")].filter(
      Boolean,
    ) as HTMLElement[];
  // PanelEl is the structural subset of HTMLElement createDrawer mutates; getElementById returns HTMLElement (library-type gap).
  const d = createDrawer({
    drawer: drawer as unknown as PanelEl,
    backdrop: back as unknown as PanelEl,
    inertTargets: chrome,
    initialFocus: () => closeBtn,
  });
  const sync = () => toggle.setAttribute("aria-expanded", String(d.isOpen()));
  toggle.addEventListener("click", () => {
    d.toggle();
    sync();
  });
  closeBtn?.addEventListener("click", () => {
    d.close();
    sync();
  });
  back.addEventListener("click", () => {
    d.close();
    sync();
  });
  drawer.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) {
      d.close();
      sync();
    }
  }); // close after picking a link
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && d.isOpen()) {
      d.close();
      sync();
    }
  });
}

function navProgress() {
  // The bar is rendered + transition:persist'd in Layout.astro so it survives DOM-swap navigation; fall back to a
  // runtime-appended one only if a page somehow omits it.
  let bar = document.querySelector(".navprogress") as HTMLElement | null;
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "navprogress";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);
  }
  const p = createProgressBar({ el: bar });
  let iv: number | null = null;
  const begin = () => {
    if (iv != null) return;
    p.start();
    iv = window.setInterval(() => p.tick(), 140);
  };
  const end = () => {
    if (iv != null) {
      window.clearInterval(iv);
      iv = null;
    }
    p.done();
    window.setTimeout(() => p.reset(), 300);
  };

  // ClientRouter owns the cadence: a soft nav begins at astro:before-preparation and completes at astro:page-load.
  // (There is no full unload anymore, so the old click/beforeunload wiring would start a bar that never finishes.)
  document.addEventListener("astro:before-preparation", begin);
  document.addEventListener("astro:page-load", end);
}

let revealCleanup: (() => void) | null = null;
function reveal() {
  revealCleanup?.();
  revealCleanup = revealOnScroll();
} // re-observe the freshly-swapped [data-reveal] nodes

function init() {
  navProgress();
  mobileNav();
  reveal(); // reveals [data-reveal] elements present at load (server-rendered sections)
  // Each swapped-in page brings new [data-reveal] nodes the first IntersectionObserver never saw; re-observe them.
  document.addEventListener("astro:page-load", reveal);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
