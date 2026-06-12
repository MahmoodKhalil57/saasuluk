/**
 * The Cockpit — the same brain as the Suluk VS Code extension, rendered as an admin web page straight from the
 * LIVE contract. A maximal best-practices showcase that composes three otherwise-unused @suluk packages:
 *   • @suluk/cockpit — ship-readiness gates, the convergence audit, and contract→D2 diagrams
 *   • @suluk/docs    — kroki D2 rendering (the diagram images)
 *   • @suluk/visual  — the UI-primitive gallery (the widgets the shadcn projection can render)
 * Admin-only; nothing here is hand-authored — it is one more projection of the single document.
 */
import type { OpenAPIv4Document } from "@suluk/core";
import { convergeContract, contractGates, shipSummary, contractToD2, diagramViews } from "@suluk/cockpit";
import { knownWidgets, renderPrimitiveHtml } from "@suluk/visual";

const esc = (s: string): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const DOT: Record<string, string> = { ok: "#16a34a", warn: "#d97706", error: "#dc2626", todo: "#d97706", info: "#64748b" };

export function renderCockpitPage(document: OpenAPIv4Document): string {
  const gates = contractGates(document, {});
  const ship = shipSummary(gates);
  const conv = convergeContract(document);
  // @suluk/cockpit emits the D2 source; the browser renders it to SVG via kroki (a POST — no server-side deflate),
  // and falls back to showing the D2 source verbatim if kroki is unreachable. The diagram never breaks the page.
  const diagrams = diagramViews().map((v) => ({ ...v, d2: contractToD2(document, v.id) }));
  const widgets = knownWidgets();

  const gateRows = gates.map((g) => `<li><span class="dot" style="background:${DOT[g.status] ?? "#64748b"}"></span><b>${esc(g.title)}</b><span class="muted"> — ${esc(g.detail)}</span></li>`).join("");
  const findings = conv.findings.length
    ? conv.findings.map((f) => `<li><span class="tag tag-${f.severity}">${esc(f.severity)}</span> ${esc(f.message)}${f.where ? ` <code>${esc(f.where)}</code>` : ""}</li>`).join("")
    : `<li class="ok">✓ The contract is self-consistent — no dangling refs, undeclared schemes, orphan scopes or empty paths.</li>`;
  const diagramCards = diagrams.map((d) => `<figure><figcaption><b>${esc(d.title)}</b><span class="muted"> — ${esc(d.description)}</span></figcaption><pre class="d2" data-kroki>${esc(d.d2)}</pre></figure>`).join("");
  // renderPrimitiveHtml returns a FULL html doc (its own white-theme <style>) — isolate each in an iframe so its
  // body{color} reset can't leak into this dark page; the iframe provides the intended white preview surface.
  const primitiveCards = widgets.map((w) => `<div class="prim"><span class="muted">${esc(w)}</span><iframe loading="lazy" sandbox="" title="${esc(w)} primitive" srcdoc="${esc(renderPrimitiveHtml({ widget: w }))}"></iframe></div>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cockpit — saasuluk</title>
<style>
  :root { --bg:#0b0f1a; --panel:#121826; --line:#232c40; --fg:#e7ecf5; --muted:#8b97ad; --accent:#34d399; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:1040px; margin:0 auto; padding:32px 22px 80px; }
  a { color:var(--accent); } h1 { font-size:30px; letter-spacing:-.02em; margin:0 0 4px; } h2 { font-size:18px; margin:34px 0 12px; letter-spacing:-.01em; }
  .sub { color:var(--muted); margin:0 0 22px; } .nav { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:8px; font-size:13.5px; }
  .ship { display:flex; align-items:center; gap:12px; padding:14px 18px; border-radius:14px; border:1px solid var(--line); background:var(--panel); font-weight:600; }
  .ship.ready { border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); } .ship .big { font-size:22px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px; }
  ul.gates, ul.find { list-style:none; margin:0; padding:0; display:grid; gap:9px; } ul.gates li, ul.find li { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; }
  .dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; align-self:center; } .muted { color:var(--muted); }
  code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.86em; background:#0a0e17; border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
  .tag { font-size:11px; font-weight:700; text-transform:uppercase; border-radius:5px; padding:1px 6px; } .tag-error{background:#dc2626;color:#fff}.tag-warn{background:#d97706;color:#fff}.tag-info{background:#334155;color:#cbd5e1}
  li.ok { color:var(--accent); }
  .diagrams { display:grid; gap:18px; } figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px 16px; }
  figure img { width:100%; margin-top:10px; background:#fff; border-radius:10px; }
  pre.d2 { margin:10px 0 0; padding:12px 14px; background:#0a0e17; border:1px solid var(--line); border-radius:10px; overflow-x:auto; font-family:ui-monospace,SFMono-Regular,monospace; font-size:12.5px; color:#cbd5e1; }
  .svgwrap { margin-top:10px; background:#fff; border-radius:10px; padding:10px; } .svgwrap svg { max-width:100%; height:auto; display:block; }
  .prims { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; } .prim { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; } .prim .muted { font-size:12px; display:block; margin-bottom:8px; }
  .prim iframe { width:100%; height:72px; border:1px solid var(--line); border-radius:8px; background:#fff; display:block; }
</style></head>
<body><div class="wrap">
  <div class="nav"><a href="/superadmin">← Admin</a><a href="/reference">Reference</a><a href="/scalar">Scalar</a><a href="/swagger">Swagger</a><a href="/openapi.json">openapi.json</a></div>
  <h1>Cockpit</h1>
  <p class="sub">The Suluk VS Code extension's brain, in the browser — ship-readiness, convergence and contract diagrams, all projected from the one live document. Powered by <code>@suluk/cockpit</code>, <code>@suluk/docs</code> and <code>@suluk/visual</code>.</p>
  <div class="ship ${ship.ready ? "ready" : ""}"><span class="big">${ship.ready ? "✓" : "⚠"}</span><span>${esc(ship.line)}</span></div>

  <h2>Ship-readiness gates</h2>
  <div class="card"><ul class="gates">${gateRows}</ul></div>

  <h2>Convergence audit</h2>
  <div class="card"><ul class="find">${findings}</ul></div>

  <h2>Contract diagrams</h2>
  <div class="diagrams">${diagramCards}</div>

  <h2>UI primitives <span class="muted" style="font-weight:400;font-size:14px">— the shadcn widgets the contract projects</span></h2>
  <div class="prims">${primitiveCards}</div>
</div>
<script>
  // Render each D2 block to SVG via kroki (POST the source — no client deflate). On any failure the D2 source stays.
  for (const pre of document.querySelectorAll("pre[data-kroki]")) {
    fetch("https://kroki.io/d2/svg", { method: "POST", headers: { "content-type": "text/plain" }, body: pre.textContent })
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((svg) => { const wrap = document.createElement("div"); wrap.className = "svgwrap"; wrap.innerHTML = svg; pre.replaceWith(wrap); })
      .catch(() => {});
  }
</script>
</body></html>`;
}
