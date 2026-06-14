/**
 * The signed-in user's /dashboard — the NON-CRUD half. The CRUD half (orders, wishlist, reviews, projects, cart) is
 * projected automatically by @suluk/panel from the per-role document; this module supplies the bits a contract can't
 * express: identity, password, sessions, Stripe billing portal, API-key minting, and the delete-account danger zone.
 * Each section is a self-contained HTML+script body rendered inside the panel shell (so it inherits the theme + the
 * .pf-* design system). `userStats` computes the home KPI tiles from the caller's own rows.
 */
import { eq, and, isNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { order, wishlistItem, apiToken, product } from "./schema";
import type { PanelSection, StatCard } from "@suluk/panel";

type Rows = Promise<Record<string, unknown>[]>;
type AnyDb = { select: (...a: unknown[]) => { from: (t: unknown) => Rows & { where: (w: unknown) => Rows } } };

/** Home KPI tiles, computed from the caller's OWN rows (drizzle → works on D1 + bun:sqlite). Resilient: any failure
 *  just drops the stats rather than breaking the dashboard. */
export async function userStats(db: AnyDb, userId: string | null): Promise<StatCard[]> {
  if (!userId) return [];
  try {
    const [orders, wl, toks] = await Promise.all([
      db.select().from(order).where(eq(order.customerId as unknown as SQLiteColumn, userId)) as Promise<{ totalCents?: number }[]>,
      db.select().from(wishlistItem).where(eq(wishlistItem.customerId as unknown as SQLiteColumn, userId)),
      db.select().from(apiToken).where(and(eq(apiToken.userId as unknown as SQLiteColumn, userId), isNull(apiToken.revokedAt as unknown as SQLiteColumn))),
    ]);
    const spent = orders.reduce((n, o) => n + (Number(o.totalCents) || 0), 0);
    return [
      { label: "Orders", value: orders.length, href: "/dashboard/s/orders" },
      { label: "Total spent", value: "$" + (spent / 100).toFixed(2), hint: "all time" },
      { label: "Wishlist", value: wl.length, href: "/dashboard/s/wishlist" },
      { label: "API keys", value: toks.length, href: "/dashboard/s/developer" },
    ];
  } catch { return []; }
}

/** The sidebar grouping for the user dashboard (entities + sections). */
export const dashboardGroups = [
  { title: "Account", sections: ["profile", "security", "sessions"] },
  { title: "Commerce", entities: ["Review", "Cart", "Address"], sections: ["orders", "wishlist"] },
  { title: "Developer", entities: ["Project"], sections: ["developer"] },
  { title: "Billing", sections: ["billing"] },
  { title: "Danger zone", sections: ["danger"] },
];

/** Entities the custom sections replace (so the panel doesn't also auto-list them). Order is hidden in favour of the
 *  bespoke `orders` section (the generic list rendered items/shippingAddress as raw JSON and had no openable detail). */
export const dashboardHiddenEntities = ["ApiToken", "BillingAccount", "Order", "WishlistItem"];

const PROFILE = `
<div class="pf-section">
  <div style="display:flex;gap:15px;align-items:center;flex-wrap:wrap">
    <img id="ac-avatar" alt="" width="60" height="60" style="border-radius:50%;border:1px solid var(--line)"/>
    <div style="flex:1;min-width:200px"><div id="ac-name" style="font-weight:700;font-size:18px">Loading…</div><div id="ac-email" class="pf-muted" style="font-size:13.5px"></div></div>
    <a id="ac-signout" class="pf-btn" href="#">Sign out</a>
  </div>
</div>
<div class="pf-section">
  <h2>Display name</h2>
  <p class="pf-sub">How your name appears across the store.</p>
  <form id="ac-profile" style="display:flex;gap:8px;max-width:460px;align-items:center;flex-wrap:wrap">
    <input class="pf-input" name="name" placeholder="Display name" style="flex:1;min-width:180px"/>
    <button class="pf-btn pf-primary" type="submit">Save</button>
    <span id="ac-profmsg" class="pf-muted" style="font-size:13px"></span>
  </form>
</div>
<script>(function(){
  var av=document.getElementById("ac-avatar"),nm=document.getElementById("ac-name"),em=document.getElementById("ac-email"),pf=document.getElementById("ac-profile"),msg=document.getElementById("ac-profmsg");
  fetch("/api/auth/get-session",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(s){
    var u=s&&s.user; if(!u)return; av.src="/avatar?seed="+encodeURIComponent(u.email||u.id); nm.textContent=u.name||u.email; em.textContent=u.email||""; pf.elements["name"].value=u.name||"";
  }).catch(function(){});
  document.getElementById("ac-signout").addEventListener("click",function(e){e.preventDefault();fetch("/api/auth/sign-out",{method:"POST",credentials:"same-origin"}).then(function(){location.href="/";});});
  pf.addEventListener("submit",function(e){e.preventDefault();msg.textContent="Saving…";
    fetch("/api/auth/update-user",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({name:pf.elements["name"].value})}).then(function(r){msg.textContent=r.ok?"Saved ✓":"Could not save.";});});
})();</script>`;

const SECURITY = `
<div class="pf-section">
  <h2>Change password</h2>
  <p class="pf-sub">Update the password you use to sign in. Choose at least 8 characters.</p>
  <form id="ac-pw" style="display:grid;gap:10px;max-width:420px">
    <input class="pf-input" type="password" name="current" placeholder="Current password" autocomplete="current-password"/>
    <input class="pf-input" type="password" name="next" placeholder="New password" autocomplete="new-password"/>
    <div style="display:flex;gap:10px;align-items:center"><button class="pf-btn pf-primary" type="submit">Update password</button><span id="ac-pwmsg" class="pf-muted" style="font-size:13px"></span></div>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("ac-pw"),msg=document.getElementById("ac-pwmsg");
  f.addEventListener("submit",function(e){e.preventDefault();
    var cur=f.elements["current"].value,nx=f.elements["next"].value; if(nx.length<8){msg.textContent="New password must be at least 8 characters.";return;}
    msg.textContent="Updating…";
    fetch("/api/auth/change-password",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({currentPassword:cur,newPassword:nx,revokeOtherSessions:true})})
      .then(function(r){return r.ok?{ok:true}:r.json().then(function(d){return {ok:false,d:d};});})
      .then(function(x){ if(x.ok){msg.textContent="Password updated ✓";f.reset();} else {msg.textContent=(x.d&&(x.d.message||(x.d.error&&x.d.error.message)))||"Could not update — check your current password.";} })
      .catch(function(){msg.textContent="Could not update.";});});
})();</script>`;

const SESSIONS = `
<div class="pf-section">
  <h2>Active sessions</h2>
  <p class="pf-sub">Devices currently signed in to your account.</p>
  <div id="ac-sessions" class="pf-muted">Loading…</div>
  <button class="pf-btn" id="ac-signout-all" style="margin-top:14px">Sign out of all other devices</button>
</div>
<script>(function(){
  var box=document.getElementById("ac-sessions");
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}
  function when(t){return t?new Date(Number(t)).toLocaleString():"—";}
  function load(){fetch("/api/auth/list-sessions",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(raw){
    var arr=Array.isArray(raw)?raw:(raw.sessions||[]);
    box.innerHTML=arr.length?arr.map(function(s){return '<div class="pf-row"><span>'+esc((s.userAgent||"Unknown device").slice(0,80))+'</span><span class="pf-muted">'+esc(when(s.createdAt?new Date(s.createdAt).getTime():0))+'</span></div>';}).join(""):'<div class="pf-empty">No active sessions.</div>';
  }).catch(function(){box.innerHTML='<div class="pf-empty">Could not load sessions.</div>';});}
  document.getElementById("ac-signout-all").addEventListener("click",function(){fetch("/api/auth/revoke-other-sessions",{method:"POST",credentials:"same-origin"}).then(load);});
  load();
})();</script>`;

const BILLING = `
<div class="pf-section">
  <h2>Billing &amp; payment methods</h2>
  <p class="pf-sub">Manage saved cards, invoices and billing details on Stripe's secure, hosted portal — no card data ever touches saasuluk.</p>
  <button class="pf-btn pf-primary" id="ac-billing">Manage billing &amp; cards →</button>
  <span id="ac-billmsg" class="pf-muted" style="margin-inline-start:10px;font-size:13px"></span>
</div>
<script>(function(){
  var btn=document.getElementById("ac-billing"),msg=document.getElementById("ac-billmsg");
  btn.addEventListener("click",function(){btn.disabled=true;msg.textContent="Opening Stripe…";
    fetch("/billing/portal",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:"{}"})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {ok:r.ok,d:d};});})
      .then(function(x){ if(x.ok&&x.d.url){location.href=x.d.url;return;} msg.textContent=x.d.needsPortalConfig?"Billing portal isn't activated yet — enable it in the Stripe dashboard.":(x.d.error||"Could not open billing."); btn.disabled=false; })
      .catch(function(){msg.textContent="Could not open billing — please try again.";btn.disabled=false;});});
})();</script>`;

const DEVELOPER = `
<div class="pf-section">
  <h2>API keys</h2>
  <p class="pf-sub">Create bearer tokens for programmatic access to your data. A token's secret is shown once, at creation.</p>
  <form id="ac-tok" style="display:flex;gap:8px;margin-bottom:12px;max-width:460px"><input class="pf-input" name="name" placeholder="Token name" required style="flex:1"/><button class="pf-btn pf-primary" type="submit">+ Create</button></form>
  <div id="ac-newtok"></div>
  <div id="ac-tokens" class="pf-muted">Loading…</div>
</div>
<script>(function(){
  var box=document.getElementById("ac-tokens"),form=document.getElementById("ac-tok"),newtok=document.getElementById("ac-newtok"),USER=null;
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}
  function when(t){return t?new Date(Number(t)).toLocaleDateString():"—";}
  function load(){fetch("/apiToken",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(ts){
    ts=(ts||[]).filter(function(t){return (!USER||t.userId===USER)&&!t.revokedAt;});
    box.innerHTML=ts.length?ts.map(function(t){return '<div class="pf-row"><span><b>'+esc(t.name)+'</b> <code class="pf-mono">'+esc(t.prefix)+'…</code></span><span class="pf-muted">'+esc(when(t.createdAt))+' <button class="pf-link-danger" data-r="'+esc(t.id)+'">revoke</button></span></div>';}).join(""):'<div class="pf-empty">No API keys yet.</div>';
    box.querySelectorAll("[data-r]").forEach(function(b){b.addEventListener("click",function(){fetch("/tokens/"+encodeURIComponent(b.dataset.r)+"/revoke",{method:"POST",credentials:"same-origin"}).then(load);});});
  }).catch(function(){box.innerHTML='<div class="pf-empty">Could not load keys.</div>';});}
  fetch("/api/auth/get-session",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(s){USER=s&&s.user&&s.user.id;load();}).catch(load);
  form.addEventListener("submit",function(e){e.preventDefault();
    fetch("/tokens/create",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({name:form.elements["name"].value})})
      .then(function(r){return r.json();}).then(function(d){ if(d&&d.token){ newtok.innerHTML='<div class="pf-section" style="background:color-mix(in srgb,var(--accent) 8%,var(--panel))">New key — copy it now, it won\\'t be shown again:<br/><code class="pf-mono" style="font-size:13.5px;word-break:break-all">'+esc(d.token)+'</code></div>'; } form.reset(); load(); })
      .catch(function(){});});
})();</script>`;

const DANGER = `
<div class="pf-section">
  <h2>Your data</h2>
  <p class="pf-sub">Download everything we hold for your account — orders, wishlist, reviews and API-key metadata — as a JSON file (GDPR data export).</p>
  <a class="btn ghost sm" href="/account/export" download="saasuluk-data.json">Export your data</a>
</div>
<div class="pf-section" style="border-color:color-mix(in srgb,var(--danger) 32%,var(--line))">
  <h2 style="color:var(--danger)">Delete account</h2>
  <p class="pf-sub">Permanently delete your account and all your data — orders, wishlist, API keys, billing. This cannot be undone.</p>
  <button class="pf-btn pf-danger" id="ac-del-start">Delete my account</button>
  <div id="ac-del-confirm" style="display:none;margin-top:14px;gap:8px;flex-wrap:wrap;align-items:center">
    <input class="pf-input" id="ac-del-pass" type="password" placeholder="Confirm your password" style="max-width:260px"/>
    <button class="pf-btn pf-danger" id="ac-del-go">Yes, delete everything</button>
    <button class="pf-btn" id="ac-del-cancel">Cancel</button>
    <span id="ac-del-msg" style="color:var(--danger);font-size:13px;width:100%"></span>
  </div>
</div>
<script>(function(){
  var start=document.getElementById("ac-del-start"),conf=document.getElementById("ac-del-confirm"),msg=document.getElementById("ac-del-msg");
  start.addEventListener("click",function(){start.style.display="none";conf.style.display="flex";});
  document.getElementById("ac-del-cancel").addEventListener("click",function(){conf.style.display="none";start.style.display="inline-flex";});
  document.getElementById("ac-del-go").addEventListener("click",function(){
    var p=document.getElementById("ac-del-pass").value; msg.textContent="Deleting…";
    fetch("/api/auth/delete-user",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify(p?{password:p}:{})})
      .then(function(r){return r.ok?{ok:true}:r.json().then(function(d){return {ok:false,d:d};});})
      .then(function(x){ if(x.ok){location.href="/";} else {msg.textContent=(x.d&&(x.d.message||(x.d.error&&x.d.error.message)))||"Could not delete — check your password and try again.";} })
      .catch(function(){msg.textContent="Could not delete.";});});
})();</script>`;

/** The BESPOKE product-dashboard home (vs /superadmin's everything-grid): a personalized overview — welcome, quick
 *  actions, recent orders, recommendations — that adapts to WHO is logged in (admins also get a Superadmin shortcut).
 *  Server-rendered skeleton + an inline script that fills the per-user bits from the owner-scoped REST endpoints. */
export function dashboardHome(opts: { admin: boolean }): string {
  const adminTile = opts.admin ? '<a class="dh-qa dh-qa-admin" href="/superadmin"><span>🛡️</span> Superadmin</a>' : "";
  return `
<style>
  .dh-hero{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:linear-gradient(120deg,color-mix(in oklab,var(--accent) 12%,var(--panel)),var(--panel));border:1px solid var(--line);border-radius:18px;padding:20px 22px;box-shadow:var(--shadow);margin-bottom:20px}
  .dh-hero img{width:64px;height:64px;border-radius:50%;border:1px solid var(--line)}
  .dh-hero h2{margin:0;font-size:21px;letter-spacing:-.01em}.dh-hero p{margin:3px 0 0;color:var(--muted);font-size:13.5px}
  .dh-quick{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px}
  .dh-qa{display:inline-flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:9px 14px;font-weight:600;font-size:13.5px;color:var(--fg);box-shadow:var(--shadow)}
  .dh-qa:hover{border-color:color-mix(in oklab,var(--accent) 50%,var(--line));text-decoration:none}.dh-qa span{font-size:15px}
  .dh-qa-admin{background:color-mix(in oklab,var(--accent) 12%,var(--panel));color:var(--accent)}
  .dh-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}@media(max-width:760px){.dh-grid{grid-template-columns:1fr}}
  .dh-recs{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .dh-rec{display:block;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}
  .dh-rec img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:var(--bg-soft)}
  .dh-rec .dh-rb{padding:9px 11px}.dh-rec b{font-size:13.5px}.dh-rec p{margin:2px 0 0;color:var(--muted);font-size:12.5px}
</style>
<div class="dh-hero">
  <img id="dh-avatar" alt=""/>
  <div style="flex:1;min-width:180px"><h2 id="dh-hi">Welcome back</h2><p id="dh-sub">Loading your dashboard…</p></div>
</div>
<div class="dh-quick">
  <a class="dh-qa" href="/products"><span>🛍️</span> Browse products</a>
  <a class="dh-qa" href="/dashboard/s/orders"><span>📦</span> Your orders</a>
  <a class="dh-qa" href="/dashboard/s/wishlist"><span>❤️</span> Wishlist</a>
  <a class="dh-qa" href="/dashboard/s/billing"><span>💳</span> Billing</a>
  <a class="dh-qa" href="/dashboard/s/developer"><span>🔑</span> API keys</a>
  ${adminTile}
</div>
<div class="dh-grid">
  <div class="pf-section"><h2 style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">Recent orders <a href="/dashboard/s/orders" style="font-size:13px;font-weight:500;white-space:nowrap">View all →</a></h2><p class="pf-sub">Your latest purchases.</p><div id="dh-orders" class="pf-muted">Loading…</div></div>
  <div class="pf-section"><h2>Recommended for you</h2><p class="pf-sub">Fresh from the catalog.</p><div id="dh-recs" class="dh-recs"></div></div>
</div>
<script>(function(){
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}
  function money(c){return window.fmtMoney?window.fmtMoney(c):"$"+(Number(c||0)/100).toFixed(2);}
  function when(t){return t?(window.fmtDate?window.fmtDate(Number(t)):new Date(Number(t)).toLocaleDateString()):"—";}
  fetch("/api/auth/get-session",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(s){
    var u=s&&s.user; var av=document.getElementById("dh-avatar");
    if(u){ av.src="/avatar?seed="+encodeURIComponent(u.email||u.id); document.getElementById("dh-hi").textContent="Welcome back, "+(u.name||u.email.split("@")[0]); document.getElementById("dh-sub").textContent="Signed in as "+u.email; }
    else { av.src="/avatar?seed=you"; document.getElementById("dh-sub").textContent="Here's your dashboard."; }
  }).catch(function(){});
  fetch("/order",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(os){
    os=(os||[]).slice().sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);}).slice(0,4);
    var box=document.getElementById("dh-orders");
    box.innerHTML=os.length?os.map(function(o){return '<a class="pf-row" href="/dashboard/s/orders" style="text-decoration:none;color:inherit"><span>#'+esc(o.id)+' <span class="pf-pill">'+esc(o.status)+'</span></span><span class="pf-muted">'+esc(money(o.totalCents))+' · '+esc(when(o.createdAt))+'</span></a>';}).join(""):'<div class="pf-empty">No orders yet — <a href="/products">shop the store →</a></div>';
  }).catch(function(){document.getElementById("dh-orders").innerHTML='<div class="pf-empty">Could not load orders.</div>';});
  fetch("/product",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(ps){
    ps=(ps||[]).filter(function(p){return p.status==="published";}).slice(0,4);
    document.getElementById("dh-recs").innerHTML=ps.map(function(p){return '<a class="dh-rec" href="/products/'+encodeURIComponent(p.slug)+'">'+(p.imageUrl?'<img src="'+esc(p.imageUrl)+'" alt="" loading="lazy"/>':'')+'<div class="dh-rb"><b>'+esc(p.name)+'</b><p>'+esc(money(p.priceCents))+'</p></div></a>';}).join("");
  }).catch(function(){});
})();</script>`;
}

// A bespoke ORDER-HISTORY view — the @suluk/panel auto-list rendered Order's items/shippingAddress as raw JSON and
// gave a normal user no openable detail (Order is update=admin → no edit link). This replaces it: each order is an
// expandable card that itemizes the snapshot (thumbnail, variant label, qty × unit), the discount, the ship-to block,
// the total, and a one-tap "Buy again". All from the /order rows the buyer already owns — no schema change.
const ORDERS = `
<div class="pf-section">
  <h2 style="margin-top:0">Your orders</h2>
  <p class="pf-sub">Everything you've purchased — open an order to see its items, shipping and total.</p>
  <div id="od-list" class="pf-muted">Loading…</div>
</div>
<style>
  .od-card{border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden;background:var(--panel)}
  .od-head{display:flex;align-items:center;gap:10px;width:100%;padding:13px 15px;background:none;border:0;cursor:pointer;font:inherit;color:var(--fg);text-align:start}
  .od-head:hover{background:var(--bg-soft)}
  .od-id{font-weight:700}
  .od-when{color:var(--muted);font-size:12.5px}
  .od-tot{margin-inline-start:auto;font-family:ui-monospace,monospace;font-weight:700}
  .od-caret{transition:transform .15s;color:var(--muted)}
  .od-card.open .od-caret{transform:rotate(90deg)}
  .od-pill{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--line)}
  .od-pill.paid{color:#16794a;border-color:#16794a55}.od-pill.shipped{color:#1d6fb8;border-color:#1d6fb855}.od-pill.pending{color:#b07b16;border-color:#b07b1655}.od-pill.cancelled{color:#b03636;border-color:#b0363655}
  .od-body{display:none;padding:4px 15px 15px;border-top:1px solid var(--line)}
  .od-card.open .od-body{display:block}
  .od-line{display:flex;gap:11px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}
  .od-line:last-child{border-bottom:0}
  .od-img{width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid var(--line);background:var(--bg-soft);flex:none}
  .od-ln-body{flex:1;min-width:0}.od-ln-name{font-size:14px;font-weight:600}.od-ln-sub{font-size:12px;color:var(--muted)}
  .od-ln-amt{font-family:ui-monospace,monospace;font-size:13.5px;white-space:nowrap}
  .od-tot-row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px}.od-tot-row.g{font-weight:700;border-top:1px solid var(--line);margin-top:4px;padding-top:9px}
  .od-tot-row.disc span{color:var(--accent)}
  .od-ship{margin-top:12px;font-size:13px;line-height:1.55}.od-ship b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:2px}
  .od-dl{margin-top:12px}.od-dl b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:6px}.od-dl-list{display:flex;gap:7px;flex-wrap:wrap}
  .od-actions{margin-top:13px;display:flex;gap:8px;flex-wrap:wrap}
</style>
<script>(function(){
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}
  function money(c){return window.fmtMoney?window.fmtMoney(c):"$"+(Number(c||0)/100).toFixed(2);}
  function when(t){return t?(window.fmtDate?window.fmtDate(Number(t)):new Date(Number(t)).toLocaleDateString()):"";}
  function parse(j){try{return JSON.parse(j||"[]");}catch(e){return [];}}
  function addrBlock(o){var a=null;try{a=o.shippingAddress?JSON.parse(o.shippingAddress):null;}catch(e){}if(!a)return "";
    var L=[a.name,a.line1,a.line2,[a.city,a.state,a.postalCode].filter(Boolean).join(", "),a.country].filter(function(x){return x&&String(x).trim();});
    return L.length?'<div class="od-ship"><b>Shipping to</b>'+L.map(esc).join("<br>")+'</div>':"";}
  function trackBlock(o){if(o.status!=="shipped"||!o.trackingNumber)return "";return '<div class="od-ship"><b>Tracking</b>'+esc(o.carrier||"Carrier")+' · '+esc(o.trackingNumber)+'</div>';}
  function safeUrl(u){u=String(u==null?"":u);return /^(https?:\\/\\/|\\/)/i.test(u)?u:"#";} // http(s) or relative only — never javascript:/data:
  function downloadsBlock(o,items){if(o.status!=="paid"&&o.status!=="shipped")return "";var dls=items.filter(function(it){return it.downloadUrl;});if(!dls.length)return "";
    return '<div class="od-dl"><b>Your downloads</b><div class="od-dl-list">'+dls.map(function(it){return '<a class="btn sm" href="'+esc(safeUrl(it.downloadUrl))+'" target="_blank" rel="noopener">&darr; '+esc(it.name||"Download")+'</a>';}).join("")+'</div></div>';}
  function lineHtml(it){var sub=it.variantLabel?esc(it.variantLabel):"";
    return '<div class="od-line">'+(it.image?'<img class="od-img" src="'+esc(it.image)+'" alt="" loading="lazy"/>':'<span class="od-img"></span>')+
      '<div class="od-ln-body"><div class="od-ln-name">'+esc(it.name||("#"+it.productId))+'</div><div class="od-ln-sub">'+(sub?sub+" · ":"")+'Qty '+(it.qty||1)+' × '+money(it.priceCents)+'</div></div>'+
      '<div class="od-ln-amt">'+money((it.priceCents||0)*(it.qty||1))+'</div></div>';}
  function buyAgain(items){var cart=[];try{cart=JSON.parse(localStorage.getItem("cart")||"[]");}catch(e){}
    items.forEach(function(it){var ex=cart.find(function(x){return x.productId===it.productId&&x.variantId==it.variantId;});
      if(ex)ex.qty+=(it.qty||1);else cart.push({productId:it.productId,variantId:it.variantId,qty:it.qty||1,priceCents:it.priceCents,name:it.name,image:it.image,variantLabel:it.variantLabel});});
    localStorage.setItem("cart",JSON.stringify(cart));window.dispatchEvent(new Event("cart-changed"));
    if(window.toast)window.toast("Added to cart ✓",{type:"success"});}
  var box=document.getElementById("od-list");
  fetch("/order",{credentials:"same-origin"}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(os){
    os=(os||[]).slice().sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);});box.className="";
    if(!os.length){box.innerHTML='<div class="pf-empty">No orders yet — <a href="/products">shop the store →</a></div>';return;}
    box.innerHTML=os.map(function(o){var items=parse(o.items);var n=items.reduce(function(s,i){return s+(i.qty||1);},0);
      var sub=items.reduce(function(s,i){return s+(i.priceCents||0)*(i.qty||1);},0);var shipC=o.shippingCents||0,taxC=o.taxCents||0;var disc=sub-((o.totalCents||0)-shipC-taxC);
      return '<div class="od-card" data-id="'+esc(o.id)+'">'+
        '<button class="od-head" type="button"><span class="od-id">#'+esc(o.id)+'</span><span class="od-pill '+esc(o.status)+'">'+esc(o.status)+'</span><span class="od-when">'+esc(when(o.createdAt))+' · '+n+' item'+(n===1?"":"s")+'</span><span class="od-tot">'+money(o.totalCents)+'</span><span class="od-caret">›</span></button>'+
        '<div class="od-body">'+items.map(lineHtml).join("")+
          '<div style="margin-top:10px">'+(disc>0?'<div class="od-tot-row disc"><span>Discount'+(o.discountCode?" ("+esc(o.discountCode)+")":"")+'</span><span>−'+money(disc)+'</span></div>':"")+
          (shipC>0?'<div class="od-tot-row"><span>Shipping</span><span>'+money(shipC)+'</span></div>':"")+
          (taxC>0?'<div class="od-tot-row"><span>Sales tax</span><span>'+money(taxC)+'</span></div>':"")+
          '<div class="od-tot-row g"><span>Total</span><span>'+money(o.totalCents)+'</span></div></div>'+downloadsBlock(o,items)+trackBlock(o)+addrBlock(o)+
          '<div class="od-actions">'+((o.status==="paid"||o.status==="shipped")?'<a class="btn ghost sm" href="/order/'+esc(o.id)+'/invoice" target="_blank" rel="noopener">Invoice</a>':"")+'<button class="btn sm" type="button" data-buy="'+esc(o.id)+'">Buy again</button></div>'+
        '</div></div>';}).join("");
    box.querySelectorAll(".od-head").forEach(function(h){h.addEventListener("click",function(){h.closest(".od-card").classList.toggle("open");});});
    box.querySelectorAll("[data-buy]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var o=os.find(function(x){return String(x.id)===b.dataset.buy;});if(o)buyAgain(parse(o.items));});});
  }).catch(function(){box.className="";box.innerHTML='<div class="pf-empty">Could not load your orders. <a href="/dashboard/s/orders">Retry</a></div>';});
})();</script>`;

// A shoppable WISHLIST — the @suluk/panel auto-list showed raw numeric productId/variantId with no name/image/price.
// This hydrates each saved item against /product and renders product cards (thumbnail, name, price) with View + Remove.
const WISHLIST = `
<div class="pf-section">
  <h2 style="margin-top:0">Wishlist</h2>
  <p class="pf-sub">Products you've saved for later.</p>
  <div id="wl-list" class="pf-muted">Loading…</div>
</div>
<style>
  .wl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:6px}
  .wl-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);display:flex;flex-direction:column}
  .wl-media{display:block;aspect-ratio:16/11;overflow:hidden;background:var(--bg-soft)}
  .wl-media img{width:100%;height:100%;object-fit:cover;display:block}
  .wl-bd{padding:11px 13px;display:flex;flex-direction:column;gap:6px;flex:1}
  .wl-nm{font-weight:600;font-size:14px;line-height:1.3}.wl-nm a{color:inherit;text-decoration:none}
  .wl-pr{font-family:ui-monospace,monospace;font-weight:700}
  .wl-act{display:flex;gap:7px;margin-top:auto;padding-top:4px}.wl-act .btn{flex:1;justify-content:center}
</style>
<script>(function(){
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}
  function money(c){return window.fmtMoney?window.fmtMoney(c):"$"+(Number(c||0)/100).toFixed(2);}
  var box=document.getElementById("wl-list");
  var EMPTY='<div class="pf-empty">Your wishlist is empty — <a href="/products">find something to save &rarr;</a></div>';
  Promise.all([
    fetch("/wishlistItem",{credentials:"same-origin"}).then(function(r){if(!r.ok)throw 0;return r.json();}),
    fetch("/product",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():[];})
  ]).then(function(res){
    var items=res[0]||[],byId={};(res[1]||[]).forEach(function(p){byId[p.id]=p;});box.className="";
    var cards=items.map(function(w){var p=byId[w.productId];
      if(!p)return '<div class="wl-card" data-w="'+esc(w.id)+'"><div class="wl-bd"><div class="wl-nm" style="color:var(--muted)">Product no longer available</div><div class="wl-pr" style="color:var(--muted)">—</div><div class="wl-act"><button class="btn ghost sm" type="button" data-rm="'+esc(w.id)+'">Remove</button></div></div></div>';
      return '<div class="wl-card" data-w="'+esc(w.id)+'"><a class="wl-media" href="/products/'+esc(p.slug)+'">'+(p.imageUrl?'<img src="'+esc(p.imageUrl)+'" alt="" loading="lazy"/>':'')+'</a>'+
        '<div class="wl-bd"><div class="wl-nm"><a href="/products/'+esc(p.slug)+'">'+esc(p.name)+'</a></div><div class="wl-pr">'+money(p.priceCents)+'</div>'+
        '<div class="wl-act"><a class="btn sm" href="/products/'+esc(p.slug)+'">View</a><button class="btn ghost sm" type="button" data-rm="'+esc(w.id)+'">Remove</button></div></div></div>';}).filter(Boolean).join("");
    box.innerHTML=cards?'<div class="wl-grid">'+cards+'</div>':EMPTY;
    box.querySelectorAll("[data-rm]").forEach(function(b){b.addEventListener("click",function(){b.disabled=true;
      fetch("/wishlistItem/"+encodeURIComponent(b.dataset.rm),{method:"DELETE",credentials:"same-origin"}).then(function(r){
        if(r.ok){var card=b.closest(".wl-card");if(card)card.remove();if(window.toast)window.toast("Removed",{type:"success"});if(!box.querySelectorAll(".wl-card").length)box.innerHTML=EMPTY;}
        else{b.disabled=false;if(window.toast)window.toast("Could not remove.",{type:"error"});}});});});
  }).catch(function(){box.className="";box.innerHTML='<div class="pf-empty">Could not load your wishlist. <a href="/dashboard/s/wishlist">Retry</a></div>';});
})();</script>`;

export const dashboardSections: PanelSection[] = [
  { id: "profile", label: "Profile", summary: "Your name, email and avatar", render: () => PROFILE },
  { id: "security", label: "Security", summary: "Change your password", render: () => SECURITY },
  { id: "sessions", label: "Sessions", summary: "Devices signed in", render: () => SESSIONS },
  { id: "orders", label: "Orders", summary: "Your purchase history", render: () => ORDERS },
  { id: "wishlist", label: "Wishlist", summary: "Saved products", render: () => WISHLIST },
  { id: "billing", label: "Billing", summary: "Cards, invoices & plan", render: () => BILLING },
  { id: "developer", label: "API keys", summary: "Tokens for the API", render: () => DEVELOPER },
  { id: "danger", label: "Danger zone", summary: "Delete your account", render: () => DANGER },
];

// ----- ADMIN side (the /superadmin panel: full document, grouped, with KPIs + the global cost ledger) -----

export async function adminStats(db: AnyDb): Promise<StatCard[]> {
  try {
    const [prods, orders] = await Promise.all([
      db.select().from(product),
      db.select().from(order) as Promise<{ totalCents?: number }[]>,
    ]);
    const revenue = orders.reduce((n, o) => n + (Number(o.totalCents) || 0), 0);
    return [
      { label: "Products", value: prods.length, href: "/panel/Product" },
      { label: "Orders", value: orders.length, href: "/panel/Order" },
      { label: "Revenue", value: "$" + (revenue / 100).toFixed(2), hint: "all orders" },
      { label: "Cost ledger", value: "View →", href: "/panel/s/cost" },
    ];
  } catch { return []; }
}

export const adminGroups = [
  { title: "Catalog", entities: ["Product", "Category", "Variant", "DiscountCode"] },
  { title: "Commerce", entities: ["Order", "Cart", "WishlistItem", "Review"], sections: ["fulfillment"] },
  { title: "Content", entities: ["Post", "Faq"] },
  { title: "Accounts", entities: ["Project", "ApiToken", "BillingAccount"] },
  { title: "Ops", sections: ["cost"] },
];

// Admin FULFILLMENT — the workflow order.status never had: list paid orders waiting to ship + recent shipments, and
// transition paid → shipped (with carrier + tracking) or → cancelled via POST /order/:id/status, which emails the
// buyer (orderStatusEmail). Admin sees ALL orders (gate: owner-rule + isAdmin → unscoped).
const FULFILL = `
<div class="pf-section">
  <h2 style="margin-top:0">Orders</h2>
  <p class="pf-sub">Search, inspect, fulfill + refund every order. Click a row for line items, address, payment + tracking. Shipping or cancelling emails the buyer.</p>
  <div class="ff-controls">
    <input id="ff-q" type="search" placeholder="Search by #id or email" aria-label="Search orders" autocomplete="off" />
    <select id="ff-status" aria-label="Filter by status">
      <option value="all">All statuses</option>
      <option value="pending">Pending</option>
      <option value="paid">Paid</option>
      <option value="shipped">Shipped</option>
      <option value="cancelled">Cancelled</option>
    </select>
  </div>
  <div id="ff-list" class="pf-muted">Loading…</div>
</div>
<style>
  .ff-card{border:1px solid var(--line);border-radius:12px;margin:10px 0;padding:13px 15px;background:var(--panel)}
  .ff-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ff-id{font-weight:700}
  .ff-pill{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--line)}
  .ff-pill.paid{color:#16794a;border-color:#16794a55}.ff-pill.shipped{color:#1d6fb8;border-color:#1d6fb855}.ff-pill.cancelled{color:#b03636;border-color:#b0363655}
  .ff-meta{color:var(--muted);font-size:12.5px;margin-inline-start:auto}
  .ff-sub{font-size:12.5px;color:var(--muted);margin:6px 0 0}
  .ff-ship{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
  .ff-ship input{padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg-soft);color:var(--fg);font:inherit;font-size:13px}
  .ff-ship .ff-carrier{width:170px}.ff-ship .ff-track{flex:1;min-width:140px}
  .ff-controls{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px}
  .ff-controls input,.ff-controls select{padding:8px 11px;border:1px solid var(--line);border-radius:9px;background:var(--bg-soft);color:var(--fg);font:inherit;font-size:13.5px}
  .ff-controls #ff-q{flex:1;min-width:200px}
  .ff-head{cursor:pointer}
  .ff-head .ff-caret{transition:transform .15s;color:var(--muted);margin-inline-start:6px}
  .ff-card.open .ff-caret{transform:rotate(90deg)}
  .ff-detail{display:none;margin-top:11px;padding-top:11px;border-top:1px solid var(--line)}
  .ff-card.open .ff-detail{display:block}
  .ff-l{display:flex;gap:10px;align-items:center;padding:6px 0}
  .ff-li{width:38px;height:38px;border-radius:7px;object-fit:cover;border:1px solid var(--line);background:var(--bg-soft);flex:none}
  .ff-ln{font-size:13px;font-weight:600}.ff-lq{font-size:12px;color:var(--muted)}
  .ff-la{margin-inline-start:auto;font-family:ui-monospace,monospace;font-size:12.5px}
  .ff-pay{margin-top:9px;font-size:13px}
  .ff-pr{display:flex;justify-content:space-between;padding:3px 0}.ff-pr.g{font-weight:700;border-top:1px solid var(--line);margin-top:4px;padding-top:7px}
  .ff-blk{margin-top:10px;font-size:12.5px;line-height:1.5}.ff-blk b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:2px}
</style>
<script>(function(){
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}
  function money(c){return window.fmtMoney?window.fmtMoney(c):"$"+(Number(c||0)/100).toFixed(2);}
  function when(t){return t?(window.fmtDate?window.fmtDate(Number(t)):new Date(Number(t)).toLocaleDateString()):"";}
  function nItems(o){try{return JSON.parse(o.items||"[]").reduce(function(s,i){return s+(i.qty||1);},0);}catch(e){return 0;}}
  function safeUrl(u){u=String(u==null?"":u);return /^(https?:\\/\\/|\\/)/i.test(u)?u:"#";}
  function items(o){try{return JSON.parse(o.items||"[]");}catch(e){return [];}}
  var box=document.getElementById("ff-list"),qEl=document.getElementById("ff-q"),stEl=document.getElementById("ff-status"),all=[];
  function post(id,body,btn){
    fetch("/order/"+encodeURIComponent(id)+"/status",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify(body)}).then(function(r){
      if(r.ok){if(window.toast)window.toast("Order #"+id+" → "+body.status,{type:"success"});load();}
      else{if(btn)btn.disabled=false;if(window.toast)window.toast("Update failed ("+r.status+").",{type:"error"});}
    }).catch(function(){if(btn)btn.disabled=false;});
  }
  function lineHtml(it){return '<div class="ff-l">'+(it.image?'<img class="ff-li" src="'+esc(safeUrl(it.image))+'" alt="" loading="lazy"/>':'<span class="ff-li"></span>')+'<div><div class="ff-ln">'+esc(it.name||("#"+it.productId))+'</div><div class="ff-lq">'+(it.variantLabel?esc(it.variantLabel)+' · ':'')+'Qty '+(it.qty||1)+' × '+money(it.priceCents)+'</div></div><div class="ff-la">'+money((it.priceCents||0)*(it.qty||1))+'</div></div>';}
  function addrBlk(o){var a=null;try{a=o.shippingAddress?JSON.parse(o.shippingAddress):null;}catch(e){}if(!a)return "";var L=[a.name,a.line1,a.line2,[a.city,a.state,a.postalCode].filter(Boolean).join(", "),a.country].filter(function(x){return x&&String(x).trim();});return L.length?'<div class="ff-blk"><b>Ship to</b>'+L.map(esc).join("<br>")+'</div>':"";}
  function trackBlk(o){if(o.status!=="shipped"||!o.trackingNumber)return "";return '<div class="ff-blk"><b>Tracking</b>'+esc(o.carrier||"Carrier")+' · '+esc(o.trackingNumber)+'</div>';}
  function actions(o){
    if(o.status==="paid")return '<div class="ff-ship"><input class="ff-carrier" placeholder="Carrier (ups/usps/fedex/dhl)" data-c="'+esc(o.id)+'"/><input class="ff-track" placeholder="Tracking number (optional)" data-t="'+esc(o.id)+'"/><button class="btn sm" type="button" data-ship="'+esc(o.id)+'">Mark shipped</button><button class="btn ghost sm" type="button" data-cancel="'+esc(o.id)+'" data-refund="1">Cancel + refund</button></div>';
    if(o.status==="pending")return '<div class="ff-ship"><button class="btn ghost sm" type="button" data-cancel="'+esc(o.id)+'">Cancel order</button></div>';
    return "";
  }
  function detail(o){var its=items(o),sub=its.reduce(function(s,i){return s+(i.priceCents||0)*(i.qty||1);},0);
    return '<div class="ff-detail">'+(its.length?its.map(lineHtml).join(""):'<p class="ff-sub">No line items recorded.</p>')+
      '<div class="ff-pay">'+
        '<div class="ff-pr"><span>Subtotal</span><span>'+money(sub)+'</span></div>'+
        (o.discountCode?'<div class="ff-pr"><span>Discount</span><span>'+esc(o.discountCode)+'</span></div>':'')+
        (o.shippingCents?'<div class="ff-pr"><span>Shipping</span><span>'+money(o.shippingCents)+'</span></div>':'')+
        (o.taxCents?'<div class="ff-pr"><span>Tax</span><span>'+money(o.taxCents)+'</span></div>':'')+
        '<div class="ff-pr g"><span>Total</span><span>'+money(o.totalCents)+'</span></div>'+
        '<div class="ff-pr"><span>Payment</span><span>'+(o.stripePaymentIntentId?esc(o.stripePaymentIntentId):'free / $0')+'</span></div>'+
      '</div>'+addrBlk(o)+trackBlk(o)+actions(o)+'</div>';
  }
  function card(o){return '<div class="ff-card" data-id="'+esc(o.id)+'"><div class="ff-head"><span class="ff-id">#'+esc(o.id)+'</span><span class="ff-pill '+esc(o.status)+'">'+esc(o.status)+'</span><span class="ff-meta">'+money(o.totalCents)+' · '+nItems(o)+' item(s) · '+esc(when(o.createdAt))+'</span><span class="ff-caret">&#9656;</span></div>'+
    '<p class="ff-sub">'+(o.customerEmail?esc(o.customerEmail):"(guest — no email on file)")+'</p>'+detail(o)+'</div>';}
  function render(){
    var q=(qEl.value||"").trim().toLowerCase(),st=stEl.value;
    var list=all.filter(function(o){
      if(st!=="all"&&o.status!==st)return false;
      if(q)return String(o.id).indexOf(q)===0||(o.customerEmail||"").toLowerCase().indexOf(q)>=0;
      return true;});
    box.className="";
    if(!list.length){box.innerHTML='<div class="pf-empty">'+(all.length?"No orders match your search.":"No orders yet.")+'</div>';return;}
    box.innerHTML=list.map(card).join("");
  }
  function load(){
    fetch("/order",{credentials:"same-origin"}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(os){
      all=(os||[]).sort(function(a,b){var rank={paid:0,pending:1,shipped:2,cancelled:3};return ((rank[a.status]==null?9:rank[a.status])-(rank[b.status]==null?9:rank[b.status]))||((b.createdAt||0)-(a.createdAt||0));});
      render();
    }).catch(function(){box.className="";box.innerHTML='<div class="pf-empty">Could not load orders.</div>';});
  }
  box.addEventListener("click",function(ev){
    var ship=ev.target.closest("[data-ship]");
    if(ship){var id=ship.getAttribute("data-ship"),c=(box.querySelector('[data-c="'+id+'"]')||{}).value||"",t=(box.querySelector('[data-t="'+id+'"]')||{}).value||"";ship.disabled=true;post(id,{status:"shipped",carrier:c.trim(),trackingNumber:t.trim()},ship);return;}
    var cancel=ev.target.closest("[data-cancel]");
    if(cancel){var rid=cancel.getAttribute("data-cancel");if(!confirm("Cancel order #"+rid+"? The buyer will be emailed"+(cancel.getAttribute("data-refund")==="1"?" and refunded via Stripe":"")+"."))return;cancel.disabled=true;post(rid,{status:"cancelled"},cancel);return;}
    if(ev.target.closest("input"))return;
    var head=ev.target.closest(".ff-head");
    if(head)head.parentNode.classList.toggle("open");
  });
  qEl.addEventListener("input",render);
  stEl.addEventListener("change",render);
  load();
})();</script>`;

export const adminSections: PanelSection[] = [
  { id: "fulfillment", label: "Orders", summary: "Search, inspect, fulfill + refund", render: () => FULFILL },
  { id: "cost", label: "Cost ledger", summary: "Per-request spend, metered", render: () => '<div class="pf-section" style="padding:0;overflow:hidden;border-radius:16px"><iframe src="/cost" title="Cost ledger" style="width:100%;height:72vh;border:0;display:block"></iframe></div>' },
];
