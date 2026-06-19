/**
 * The ⌘K / Ctrl+K command palette — global search-and-jump over the contract's /search op (products + posts), a
 * hallmark-modern feature saastarter ships. Built on @suluk/nano-stores createDrawer (open/close + inert focus-trap),
 * with debounced search, full keyboard nav (↑/↓/Enter/Esc), and graceful empty/error states.
 */
import { createDrawer, type PanelEl } from "@suluk/nano-stores";

const esc = (s: string) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface Hit {
  type: string;
  title: string;
  url: string;
}

function init() {
  const modal = document.getElementById("palette");
  const back = document.getElementById("paletteback");
  const input = document.getElementById("palette-input") as HTMLInputElement | null;
  const results = document.getElementById("palette-results");
  const trigger = document.getElementById("palette-open");
  if (!modal || !back || !input || !results) return;

  const chrome = () =>
    [document.querySelector("header.site"), document.querySelector("main"), document.querySelector("footer.site")].filter(
      Boolean,
    ) as HTMLElement[];
  // PanelEl is the structural subset of HTMLElement createDrawer mutates; getElementById returns HTMLElement (library-type gap).
  const d = createDrawer({
    drawer: modal as unknown as PanelEl,
    backdrop: back as unknown as PanelEl,
    inertTargets: chrome,
    initialFocus: () => input,
  });
  let items: Hit[] = [],
    active = -1,
    timer: number | undefined;

  const open = () => {
    d.open();
    input.value = "";
    results.innerHTML = '<li class="palette-empty">Type to search products & posts…</li>';
    items = [];
    active = -1;
  };
  const close = () => d.close();

  const render = () => {
    active = items.length ? 0 : -1;
    results.innerHTML = items.length
      ? items
          .map(
            (it, i) =>
              `<li class="palette-item${i === active ? " on" : ""}" role="option" data-url="${esc(it.url)}"><span class="palette-type">${esc(it.type)}</span><span>${esc(it.title)}</span></li>`,
          )
          .join("")
      : '<li class="palette-empty">No results.</li>';
  };
  const move = (delta: number) => {
    if (!items.length) return;
    active = (active + delta + items.length) % items.length;
    Array.from(results.children).forEach((el, i) => (el as HTMLElement).classList.toggle("on", i === active));
    (results.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  };
  const go = (i: number) => {
    const it = items[i];
    if (it) location.href = it.url;
  };

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      results.innerHTML = '<li class="palette-empty">Type to search products & posts…</li>';
      items = [];
      return;
    }
    timer = window.setTimeout(async () => {
      try {
        const r = await (await fetch("/search?q=" + encodeURIComponent(q), { credentials: "same-origin" })).json();
        items = [
          ...((r.products || []) as { name: string; slug: string }[]).map((p) => ({
            type: "Product",
            title: p.name,
            url: "/products/" + p.slug,
          })),
          ...((r.posts || []) as { title: string; slug: string }[]).map((p) => ({ type: "Post", title: p.title, url: "/blogs/" + p.slug })),
        ];
        render();
      } catch {
        results.innerHTML = '<li class="palette-empty">Search failed — try again.</li>';
        items = [];
      }
    }, 170);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(active);
    }
  });
  results.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("[data-url]");
    if (li) location.href = li.getAttribute("data-url")!;
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      d.isOpen() ? close() : open();
    } else if (e.key === "Escape" && d.isOpen()) close();
  });
  trigger?.addEventListener("click", open);
  back.addEventListener("click", close);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
