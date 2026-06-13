/**
 * The persistent cart drawer — saasuluk's first @suluk-on-the-FRONTEND wiring. A bundled (NOT inline) module
 * Astro/Vite ships to the browser; it imports @suluk/nano-stores' createCartStore (resolved through the same
 * tsconfig `@suluk/*` path the server uses — verified to bundle client-side) and drives the header badge + the
 * slide-out drawer declared in Layout.astro. The store is the single client cart truth: it persists to the
 * legacy `localStorage["cart"]` array, so the inline add-to-cart handlers on the product pages keep working —
 * they just dispatch a `cart-changed` event after writing, and the store reconciles. Cross-tab stays in sync
 * via the native `storage` event (handled inside the store).
 */
import { createCartStore, createDiscountStore } from "@suluk/nano-stores";
import { fmtMoney } from "./format";

const cart = createCartStore({ storageKey: "cart" });
// the cart's companion: a persisted, cross/same-tab-synced applied discount, so a code entered on checkout
// survives navigation + refresh. The checkout inline script reads/writes it through window.discount.
const discount = createDiscountStore({ storageKey: "discount" });
// expose for the inline handlers that prefer calling the stores directly over hand-writing localStorage.
(window as unknown as { cart?: typeof cart; discount?: typeof discount }).cart = cart;
(window as unknown as { cart?: typeof cart; discount?: typeof discount }).discount = discount;

const money = (c: number) => fmtMoney(c); // locale-aware (Eastern-Arabic numerals for ar, locale currency)
const el = (id: string) => document.getElementById(id);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// re-run Layout's translator over freshly-injected [data-i18n] nodes so the drawer follows the active locale.
const reapplyLang = () => {
  const w = window as unknown as { __applyLang?: (l: string) => void; __lang0?: string };
  if (w.__applyLang && w.__lang0) w.__applyLang(w.__lang0);
};

function wire() {
  const btn = el("cartbtn"), drawer = el("cartdrawer"), back = el("cartback");
  const linesBox = el("cartlines"), badge = el("cartcount"), subEl = el("cartsubtotal"), checkout = el("cartcheckout");
  if (!btn || !drawer || !back || !linesBox) return; // not on a Layout page

  // ---- badge (count) ----
  cart.$count.subscribe((n) => {
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    btn.setAttribute("aria-label", n ? `Open cart — ${n} item${n === 1 ? "" : "s"}` : "Open cart");
  });

  // ---- lines ----
  const renderLines = () => {
    const lines = cart.lines();
    if (!lines.length) {
      linesBox.innerHTML = `<p class="cartempty" data-i18n="emptyCart">Your cart is empty.</p>`;
      reapplyLang(); // the empty-state node carries a data-i18n key; line rows don't, so only re-translate here
    } else {
      linesBox.innerHTML = lines.map((l) => `
        <div class="cartline" data-id="${esc(String(l.productId))}" data-vid="${l.variantId != null ? esc(String(l.variantId)) : ""}">
          ${l.image ? `<img class="cartline-img" src="${esc(l.image)}" alt="" loading="lazy" />` : `<span class="cartline-img cartline-img-ph" aria-hidden="true"></span>`}
          <div class="cartline-body">
            <div class="cartline-top"><span class="cartline-name">${esc(l.name)}</span><span class="cartline-price">${money(l.priceCents * l.qty)}</span></div>
            ${l.variantLabel ? `<div class="cartline-variant">${esc(l.variantLabel)}</div>` : ""}
            <div class="cartline-ctrl">
              <button class="qbtn" data-act="dec" aria-label="Decrease quantity">&minus;</button>
              <span class="qty" aria-label="Quantity">${l.qty}</span>
              <button class="qbtn" data-act="inc" aria-label="Increase quantity">+</button>
              <button class="qbtn rm" data-act="rm" aria-label="Remove item">&times;</button>
            </div>
          </div>
        </div>`).join("");
    }
  };
  cart.$items.subscribe(renderLines);
  // re-render localized money when the language switches (the store values don't change, so subscriptions won't fire)
  window.addEventListener("locale-changed", () => { renderLines(); if (subEl) subEl.textContent = money(cart.$subtotalCents.get()); });
  cart.$subtotalCents.subscribe((s) => { if (subEl) subEl.textContent = money(s); });
  // Gate Checkout on item COUNT, not subtotal — a free ($0) cart (e.g. the free Starter, or a 100%-off code) must
  // still be checkout-able. (Empty cart → disabled; any item → enabled, even at $0.00.)
  cart.$count.subscribe((n) => {
    if (!checkout) return;
    const a = checkout as HTMLAnchorElement;
    const on = n > 0;
    a.style.opacity = on ? "1" : ".45";
    a.style.pointerEvents = on ? "auto" : "none";
    a.setAttribute("aria-disabled", on ? "false" : "true");
    a.tabIndex = on ? 0 : -1;
  });

  // qty steppers / remove (event delegation — survives re-render). The row carries the (productId, variantId) pair,
  // so the stepper targets the exact variant line (two variants of one product don't share a counter).
  linesBox.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-act]"); if (!b) return;
    const row = b.closest(".cartline") as HTMLElement | null; const id = row?.dataset.id; if (id == null) return;
    const vidRaw = row?.dataset.vid; const vid = vidRaw ? Number(vidRaw) : undefined;
    const act = b.getAttribute("data-act"); const cur = cart.get(id, vid)?.qty ?? 0;
    if (act === "inc") cart.setQty(id, cur + 1, vid);
    else if (act === "dec") cart.setQty(id, cur - 1, vid);
    else if (act === "rm") cart.remove(id, vid);
  });

  // ---- open / close ----
  // the page chrome behind the modal — made `inert` while open so focus is trapped + it's hidden from AT (a real
  // modal, honouring aria-modal). The drawer + backdrop are body-level siblings, so they stay interactive.
  const chrome = () => [document.querySelector("header.site"), document.querySelector("main"), document.querySelector("footer.site")].filter(Boolean) as HTMLElement[];
  let lastFocus: HTMLElement | null = null;
  const open = () => {
    cart.reload(); // defensive: surface any cart write that bypassed the store (e.g. a page that cleared storage)
    lastFocus = document.activeElement as HTMLElement;
    drawer.hidden = false; back.hidden = false;
    requestAnimationFrame(() => { drawer.classList.add("open"); back.classList.add("open"); });
    drawer.setAttribute("aria-hidden", "false");
    for (const n of chrome()) n.inert = true;
    (el("cartclose") as HTMLElement | null)?.focus();
  };
  const close = () => {
    drawer.classList.remove("open"); back.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    for (const n of chrome()) n.inert = false;
    window.setTimeout(() => { drawer.hidden = true; back.hidden = true; }, 220);
    lastFocus?.focus();
  };
  btn.addEventListener("click", open);
  el("cartclose")?.addEventListener("click", close);
  back.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) close(); });

  renderLines();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();
