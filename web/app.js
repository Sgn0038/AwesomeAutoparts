/* Awesome Autoparts demo front end.
 * Plain JS single-page app: hash routes render into #view and talk to the
 * Flask API under /api. No build step required.
 */
"use strict";

// Served by Flask, the API is on the same origin. Opened straight from disk
// (file://), fall back to the local dev server.
const API_BASE = location.protocol.startsWith("http") ? "/api" : "http://localhost:5000/api";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");

// ------------------------------------------------------------------ helpers
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt$ = (n) => money.format(Number(n) || 0);
const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtMonth = (ym) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-US", { month: "short" });
const today = () => new Date().toISOString().slice(0, 10);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function initials(text) {
  return String(text).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    throw new Error("Can't reach the API. Is the Flask server running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("aap." + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("aap." + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

// ------------------------------------------------------------------ state
const state = {
  stores: [],
  storeId: store.get("storeId", null),
  cart: store.get("cart", []),          // [{part_number, name, brand, price, qty}]
  customer: store.get("customer", null),
  employee: store.get("employee", null),
  stock: {},                             // part_number -> qty at state.storeId
};

const storeName = (id) => state.stores.find((s) => s.store_id === Number(id))?.name ?? `Store ${id}`;
const shortStore = (id) => storeName(id).replace(" Auto Parts", "");

function saveCart() {
  store.set("cart", state.cart);
  const count = state.cart.reduce((n, l) => n + l.qty, 0);
  const badge = $("#cart-count");
  badge.textContent = count;
  badge.hidden = count === 0;
}

function setCustomer(customer) {
  state.customer = customer;
  store.set("customer", customer);
  $("#account-label").textContent = customer ? customer.name.split(" ")[0] : "Sign in";
}

function setEmployee(employee) {
  state.employee = employee;
  store.set("employee", employee);
}

async function loadStock() {
  if (!state.storeId) return;
  const rows = await api(`/stores/${state.storeId}/inventory`);
  state.stock = Object.fromEntries(rows.map((r) => [r.part_number, r.quantity]));
}

function stockPill(qty) {
  if (qty === undefined) return `<span class="pill">Not stocked here</span>`;
  if (qty === 0) return `<span class="pill bad">Out of stock</span>`;
  if (qty <= 10) return `<span class="pill warn">Only ${qty} left</span>`;
  return `<span class="pill good">In stock · ${qty}</span>`;
}

// ------------------------------------------------------------------ overlays
function openModal(html) {
  $("#modal-body").innerHTML = html;
  $("#modal").classList.add("open");
  $("#modal").setAttribute("aria-hidden", "false");
}
function closeModal() {
  $("#modal").classList.remove("open");
  $("#modal").setAttribute("aria-hidden", "true");
}
function openCart() {
  renderCart();
  $("#cart-drawer").classList.add("open");
  $("#cart-drawer").setAttribute("aria-hidden", "false");
}
function closeCart() {
  $("#cart-drawer").classList.remove("open");
  $("#cart-drawer").setAttribute("aria-hidden", "true");
}
document.addEventListener("click", (e) => {
  if (e.target.closest("#modal [data-close]")) closeModal();
  if (e.target.closest("#cart-drawer [data-close]")) closeCart();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeCart(); }
});
$("#cart-btn").addEventListener("click", openCart);

// chart tooltip (shared)
const tip = $("#chart-tip");
document.addEventListener("mousemove", (e) => {
  const target = e.target.closest("[data-tip]");
  if (!target) { tip.hidden = true; return; }
  tip.innerHTML = target.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px";
  tip.style.top = (e.clientY - tip.offsetHeight - 12) + "px";
});

// ------------------------------------------------------------------ cart
function addToCart(part, qty = 1) {
  const line = state.cart.find((l) => l.part_number === part.part_number);
  if (line) line.qty += qty;
  else state.cart.push({ part_number: part.part_number, name: part.name, brand: part.brand, price: part.price, qty });
  saveCart();
  toast(`Added ${part.name} to cart`);
}

function renderCart() {
  const body = $("#cart-body");
  if (!state.cart.length) {
    body.innerHTML = `<div class="empty">Your cart is empty.<br><br><a class="btn btn-ghost btn-sm" href="#/shop" data-close>Browse parts</a></div>`;
    return;
  }
  const subtotal = state.cart.reduce((s, l) => s + l.price * l.qty, 0);
  const lines = state.cart.map((l, i) => {
    const avail = state.stock[l.part_number];
    const short = avail === undefined || avail < l.qty;
    return `
      <div class="cart-line">
        <div><h4>${esc(l.name)}</h4><div class="part-meta">${esc(l.brand)} · <span class="mono">${esc(l.part_number)}</span></div></div>
        <div class="price" style="font-size:15px">${fmt$(l.price * l.qty)}</div>
        <div class="row">
          <div class="qty">
            <button data-dec="${i}" aria-label="Decrease">−</button>
            <input value="${l.qty}" readonly aria-label="Quantity">
            <button data-inc="${i}" aria-label="Increase">+</button>
          </div>
          ${short ? `<span class="pill bad">${avail ? `${avail} at this store` : "Not at this store"}</span>` : ""}
          <button class="link-btn" data-remove="${i}">Remove</button>
        </div>
      </div>`;
  }).join("");

  const c = state.customer;
  const checkout = c ? `
    <form id="checkout" class="stack">
      <h3 style="font-size:15px">Checkout · pickup at ${esc(shortStore(state.storeId))}</h3>
      <label class="field">Payment method
        <select name="payment_method" required>
          <option>Credit Card</option><option>Debit Card</option><option>Store Credit</option><option>Cash</option>
        </select>
      </label>
      <label class="field" id="card-type-field">Card type
        <select name="card_type"><option>Visa</option><option>Mastercard</option><option>American Express</option><option>Discover</option></select>
      </label>
      <label class="field">Billing address
        <input name="billing_address" required value="${esc(c.address)}">
      </label>
      <label class="check"><input type="checkbox" name="deliver"> Deliver instead of store pickup</label>
      <label class="field" id="delivery-field" hidden>Delivery address
        <input name="delivery_address" value="${esc(c.address)}">
      </label>
      <p class="muted" style="font-size:12.5px;margin:0">Demo checkout — no card details are collected or charged.</p>
      <button class="btn btn-primary btn-block" type="submit">Place order · ${fmt$(subtotal)}</button>
    </form>`
    : `<a class="btn btn-dark btn-block" href="#/account" data-close>Sign in to check out</a>`;

  body.innerHTML = `
    ${lines}
    <div class="stack" style="gap:6px">
      <div class="summary-row"><span class="muted">Items</span><span>${state.cart.reduce((n, l) => n + l.qty, 0)}</span></div>
      <div class="summary-row total"><span>Total</span><span>${fmt$(subtotal)}</span></div>
    </div>
    ${checkout}`;

  body.onclick = (e) => {
    const t = e.target;
    if (t.dataset.inc) state.cart[t.dataset.inc].qty++;
    else if (t.dataset.dec) {
      const l = state.cart[t.dataset.dec];
      if (--l.qty <= 0) state.cart.splice(t.dataset.dec, 1);
    } else if (t.dataset.remove) state.cart.splice(t.dataset.remove, 1);
    else return;
    saveCart();
    renderCart();
  };

  const form = $("#checkout");
  if (!form) return;
  const syncFields = () => {
    $("#card-type-field").hidden = !/Card/.test(form.payment_method.value);
    $("#delivery-field").hidden = !form.deliver.checked;
  };
  form.addEventListener("change", syncFields);
  syncFields();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const isCard = /Card/.test(form.payment_method.value);
      const order = await api("/orders", {
        method: "POST",
        body: {
          customer_id: state.customer.customer_id,
          store_id: state.storeId,
          payment_method: form.payment_method.value,
          card_type: isCard ? form.card_type.value : null,
          billing_address: form.billing_address.value,
          delivery_address: form.deliver.checked ? form.delivery_address.value : null,
          items: state.cart.map((l) => ({ part_number: l.part_number, quantity: l.qty })),
        },
      });
      state.cart = [];
      saveCart();
      closeCart();
      await loadStock();
      openModal(`
        <div style="text-align:center;padding:10px 0">
          <div class="eyebrow">Order placed</div>
          <h2 style="font-size:24px;margin:8px 0">Thanks, ${esc(state.customer.name.split(" ")[0])}!</h2>
          <p class="muted">Order <b class="mono">#${order.order_id}</b> · ${fmt$(order.total_amount)} · ${esc(order.store_name)}</p>
          <a class="btn btn-primary" href="#/account" data-close>View order history</a>
        </div>`);
      if (location.hash.startsWith("#/shop") || !location.hash) render();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ shop
const shopFilters = { q: "", category: "", brand: "", inStock: false, sort: "category" };

async function renderShop() {
  const [categories, brands] = await Promise.all([api("/parts/categories"), api("/parts/brands")]);
  view.innerHTML = `
    <section class="hero">
      <div class="eyebrow">Customer storefront</div>
      <h1>The right part, at the store down the street.</h1>
      <p>Browse real-time inventory across ${state.stores.length} locations, reserve online, and pick up today.</p>
      <form class="hero-search" id="hero-search">
        <input name="q" placeholder="Search parts, brands, or part numbers…" value="${esc(shopFilters.q)}" autocomplete="off">
        <button class="btn btn-primary">Search</button>
      </form>
    </section>
    <div class="shop-layout">
      <aside class="filters">
        <div class="filter-group">
          <h3>Category</h3>
          <div class="chip-list" id="cat-chips">
            <button class="chip ${!shopFilters.category ? "active" : ""}" data-cat="">All</button>
            ${categories.map((c) => `<button class="chip ${shopFilters.category === c ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
          </div>
        </div>
        <div class="filter-group">
          <h3>Brand</h3>
          <select class="input" id="brand-filter">
            <option value="">All brands</option>
            ${brands.map((b) => `<option ${shopFilters.brand === b ? "selected" : ""}>${esc(b)}</option>`).join("")}
          </select>
        </div>
        <div class="filter-group">
          <h3>Availability</h3>
          <label class="check"><input type="checkbox" id="instock" ${shopFilters.inStock ? "checked" : ""}> In stock at ${esc(shortStore(state.storeId))}</label>
        </div>
      </aside>
      <section>
        <div class="section-head">
          <div><h2 id="result-count">Parts</h2></div>
          <select class="input" id="sort" style="width:auto">
            <option value="category">Sort: Category</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div class="grid" id="parts-grid"><div class="loading">Loading parts…</div></div>
      </section>
    </div>`;

  $("#sort").value = shopFilters.sort;
  $("#hero-search").addEventListener("submit", (e) => { e.preventDefault(); shopFilters.q = e.target.q.value.trim(); loadParts(); });
  $("#cat-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cat]");
    if (!chip) return;
    shopFilters.category = chip.dataset.cat;
    $$("#cat-chips .chip").forEach((c) => c.classList.toggle("active", c === chip));
    loadParts();
  });
  $("#brand-filter").addEventListener("change", (e) => { shopFilters.brand = e.target.value; loadParts(); });
  $("#instock").addEventListener("change", (e) => { shopFilters.inStock = e.target.checked; loadParts(); });
  $("#sort").addEventListener("change", (e) => { shopFilters.sort = e.target.value; loadParts(); });
  await loadParts();
}

async function loadParts() {
  const params = new URLSearchParams();
  if (shopFilters.q) params.set("q", shopFilters.q);
  if (shopFilters.category) params.set("category", shopFilters.category);
  if (shopFilters.brand) params.set("brand", shopFilters.brand);
  if (shopFilters.inStock) params.set("store_id", state.storeId);
  const parts = await api("/parts?" + params);
  const sorters = {
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    name: (a, b) => a.name.localeCompare(b.name),
    category: (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  };
  parts.sort(sorters[shopFilters.sort]);

  const grid = $("#parts-grid");
  if (!grid) return;
  $("#result-count").textContent = `${parts.length} part${parts.length === 1 ? "" : "s"}`;
  if (!parts.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1">No parts match those filters.</div>`; return; }
  grid.innerHTML = parts.map((p) => {
    const qty = state.stock[p.part_number];
    return `
      <article class="card part-card" data-pn="${esc(p.part_number)}">
        <div class="part-thumb">${stockPill(qty)}<div class="glyph">${esc(initials(p.category))}</div></div>
        <div class="part-body">
          <div class="part-meta">${esc(p.category)} · ${esc(p.brand)}</div>
          <h3>${esc(p.name)}</h3>
          <div class="part-meta mono">${esc(p.part_number)}</div>
          <div class="part-foot">
            <span class="price">${fmt$(p.price)}</span>
            <button class="btn btn-dark btn-sm" data-add="${esc(p.part_number)}" ${qty ? "" : "disabled"}>Add</button>
          </div>
        </div>
      </article>`;
  }).join("");

  const byPn = Object.fromEntries(parts.map((p) => [p.part_number, p]));
  grid.onclick = (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { e.stopPropagation(); addToCart(byPn[add.dataset.add]); return; }
    const card = e.target.closest("[data-pn]");
    if (card) showPart(card.dataset.pn);
  };
}

async function showPart(partNumber) {
  const p = await api(`/parts/${encodeURIComponent(partNumber)}`);
  const qtyHere = state.stock[p.part_number];
  openModal(`
    <div class="detail">
      <div class="part-thumb"><div class="glyph" style="width:84px;height:84px;font-size:28px">${esc(initials(p.category))}</div></div>
      <div>
        <div class="eyebrow">${esc(p.category)}</div>
        <h2>${esc(p.name)}</h2>
        <div class="part-meta">${esc(p.brand)} · <span class="mono">${esc(p.part_number)}</span> · ${esc(p.condition)}</div>
        <p style="color:var(--text-2)">${esc(p.description)}</p>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="price" style="font-size:24px">${fmt$(p.price)}</span>
          ${stockPill(qtyHere)}
        </div>
        <div style="display:flex;gap:10px;margin-top:16px">
          <div class="qty">
            <button id="d-dec" aria-label="Decrease">−</button>
            <input id="d-qty" value="1" inputmode="numeric" aria-label="Quantity">
            <button id="d-inc" aria-label="Increase">+</button>
          </div>
          <button class="btn btn-primary" id="d-add" ${qtyHere ? "" : "disabled"}>Add to cart</button>
        </div>
        <h3 style="font-size:13px;margin-top:22px" class="muted">AVAILABILITY BY STORE</h3>
        <ul class="avail-list">
          ${p.availability.map((a) => `
            <li class="${a.store_id === Number(state.storeId) ? "current" : ""}">
              <span>${esc(a.store_name)}</span><b>${a.quantity ? `${a.quantity} in stock` : "Out of stock"}</b>
            </li>`).join("") || `<li>Not stocked at any store</li>`}
        </ul>
      </div>
    </div>`);
  const qtyInput = $("#d-qty");
  const clamp = (v) => Math.max(1, Math.min(qtyHere || 1, parseInt(v, 10) || 1));
  $("#d-inc").onclick = () => { qtyInput.value = clamp(+qtyInput.value + 1); };
  $("#d-dec").onclick = () => { qtyInput.value = clamp(+qtyInput.value - 1); };
  $("#d-add").onclick = () => { addToCart(p, clamp(qtyInput.value)); closeModal(); };
}

// ------------------------------------------------------------------ account
async function renderAccount() {
  if (!state.customer) return renderCustomerAuth();
  const c = state.customer;
  const orders = await api(`/customers/${c.customer_id}/orders`);
  const spent = orders.reduce((s, o) => s + o.total_amount, 0);
  view.innerHTML = `
    <div class="section-head"><div><div class="eyebrow">My account</div><h1>Welcome back, ${esc(c.name.split(" ")[0])}</h1></div></div>
    <div class="account-layout">
      <aside class="card card-pad profile">
        <div class="avatar">${esc(initials(c.name))}</div>
        <h2 style="font-size:18px">${esc(c.name)}</h2>
        <div class="muted" style="font-size:13px">@${esc(c.username)}</div>
        <dl class="kv">
          <dt>Email</dt><dd>${esc(c.email)}</dd>
          <dt>Phone</dt><dd>${esc(c.phone)}</dd>
          <dt>Vehicle</dt><dd>${esc(c.car_year)} ${esc(c.car_make)} ${esc(c.car_model)}</dd>
          <dt>Home store</dt><dd>${esc(shortStore(c.preferred_store_id))}</dd>
          <dt>Member since</dt><dd>${fmtDate(c.created_at)}</dd>
          <dt>Lifetime spend</dt><dd><b>${fmt$(spent)}</b></dd>
        </dl>
        <button class="btn btn-ghost btn-block" id="signout">Sign out</button>
      </aside>
      <section class="card">
        <div class="card-pad" style="padding-bottom:6px"><h3>Order history</h3><div class="caption">${orders.length} order${orders.length === 1 ? "" : "s"} · click one for details</div></div>
        ${orders.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Order</th><th>Date</th><th>Store</th><th>Payment</th><th class="num">Items</th><th class="num">Total</th></tr></thead>
          <tbody>${orders.map((o) => `
            <tr class="clickable" data-order="${o.order_id}">
              <td class="mono">#${o.order_id}</td><td>${fmtDate(o.order_date)}</td><td>${esc(shortStore(o.store_id))}</td>
              <td>${esc(o.payment_method)}${o.card_type ? ` · ${esc(o.card_type)}` : ""}</td>
              <td class="num">${o.item_count}</td><td class="num"><b>${fmt$(o.total_amount)}</b></td>
            </tr>`).join("")}
          </tbody></table></div>`
        : `<div class="empty">No orders yet. <a href="#/shop" style="color:var(--accent)">Start shopping →</a></div>`}
      </section>
    </div>`;
  $("#signout").onclick = () => { setCustomer(null); toast("Signed out"); render(); };
  view.querySelector("tbody")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-order]");
    if (row) showOrder(row.dataset.order);
  });
}

function renderCustomerAuth() {
  view.innerHTML = `
    <div class="auth-wrap">
      <div class="card card-pad">
        <div class="tabs"><button class="active" data-tab="signin">Sign in</button><button data-tab="register">Create account</button></div>
        <div id="auth-panel"></div>
      </div>
    </div>`;
  const panel = $("#auth-panel");

  const showSignIn = () => {
    panel.innerHTML = `
      <form class="stack" id="signin">
        <label class="field">Username<input name="username" required autocomplete="username"></label>
        <label class="field">Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn btn-primary btn-block">Sign in</button>
      </form>
      <div class="divider">or</div>
      <button class="btn btn-ghost btn-block" id="demo-customer">Continue as a sample customer</button>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Demo shortcut: loads a customer from the sample data without a password.</p>`;
    $("#signin").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api("/login", { method: "POST", body: { username: e.target.username.value, password: e.target.password.value, type: "customer" } });
        setCustomer(res.user);
        toast(`Signed in as ${res.user.name}`);
        render();
      } catch (err) { toast(err.message, true); }
    };
    $("#demo-customer").onclick = async () => {
      const orders = await api("/orders");
      const sample = await api(`/customers/${orders[0].customer_id}`);
      setCustomer(sample);
      toast(`Signed in as ${sample.name} (demo)`);
      render();
    };
  };

  const showRegister = () => {
    panel.innerHTML = `
      <form class="form-grid" id="register">
        <label class="field full">Full name<input name="name" required></label>
        <label class="field">Email<input name="email" type="email" required></label>
        <label class="field">Phone<input name="phone" required></label>
        <label class="field full">Address<input name="address" required></label>
        <label class="field">Car make<input name="car_make" required placeholder="Toyota"></label>
        <label class="field">Car model<input name="car_model" required placeholder="Camry"></label>
        <label class="field">Car year<input name="car_year" type="number" min="1950" max="2030" required></label>
        <label class="field">Home store
          <select name="preferred_store_id">${state.stores.map((s) => `<option value="${s.store_id}" ${s.store_id === Number(state.storeId) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
        </label>
        <label class="field">Username<input name="username" required autocomplete="username"></label>
        <label class="field">Password<input name="password" type="password" required minlength="4" autocomplete="new-password"></label>
        <button class="btn btn-primary btn-block full">Create account</button>
      </form>`;
    $("#register").onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const customer = await api("/customers", { method: "POST", body });
        setCustomer(customer);
        toast("Account created — welcome!");
        render();
      } catch (err) { toast(err.message, true); }
    };
  };

  $(".tabs").onclick = (e) => {
    const tab = e.target.closest("[data-tab]");
    if (!tab) return;
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b === tab));
    (tab.dataset.tab === "signin" ? showSignIn : showRegister)();
  };
  showSignIn();
}

async function showOrder(orderId) {
  const o = await api(`/orders/${orderId}`);
  openModal(`
    <div class="eyebrow">Order #${o.order_id}</div>
    <h2 style="font-size:22px;margin:6px 0 4px">${fmt$(o.total_amount)}</h2>
    <div class="muted" style="font-size:13.5px">${fmtDate(o.order_date)} · ${esc(o.store_name)} · ${esc(o.customer_name)}</div>
    <div class="table-wrap" style="margin:18px 0">
      <table>
        <thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead>
        <tbody>${o.items.map((i) => `
          <tr><td><b>${esc(i.name)}</b><div class="part-meta">${esc(i.brand)} · <span class="mono">${esc(i.part_number)}</span></div></td>
          <td class="num">${i.quantity}</td><td class="num">${fmt$(i.unit_price)}</td><td class="num">${fmt$(i.line_total)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
    <dl class="kv">
      <dt>Payment</dt><dd>${esc(o.payment_method)}${o.card_type ? ` · ${esc(o.card_type)}` : ""}</dd>
      <dt>Billing address</dt><dd>${esc(o.billing_address)}</dd>
      <dt>Fulfillment</dt><dd>${o.delivery_address ? `Delivery to ${esc(o.delivery_address)}` : "Store pickup"}</dd>
    </dl>`);
}

// ------------------------------------------------------------------ staff
const STAFF_PAGES = [
  { id: "dashboard", label: "Dashboard", allow: () => true },
  { id: "inventory", label: "Inventory", allow: () => true },
  { id: "orders", label: "Customer orders", allow: () => true },
  { id: "deliveries", label: "Deliveries", allow: () => true },
  { id: "employees", label: "Employees", allow: (e) => e.department === "Management" },
];
const isManager = () => state.employee?.department === "Management";
const canEditInventory = () => ["Management", "Inventory"].includes(state.employee?.department);
let staffStore = null; // manager's chosen scope ("" = all stores)

async function renderStaff(page) {
  if (!state.employee) return renderStaffAuth();
  const e = state.employee;
  const pages = STAFF_PAGES.filter((p) => p.allow(e));
  if (!pages.some((p) => p.id === page)) page = "dashboard";
  if (staffStore === null) staffStore = isManager() ? "" : e.store_id;

  view.innerHTML = `
    <div class="staff-layout">
      <nav class="side-nav">
        <div class="card who"><strong>${esc(e.name)}</strong><span>${esc(e.role)} · ${esc(shortStore(e.store_id))}</span></div>
        ${pages.map((p) => `<a href="#/staff/${p.id}" class="${p.id === page ? "active" : ""}"><span class="dot"></span>${p.label}</a>`).join("")}
        <a href="#/staff" id="staff-signout" style="margin-top:12px"><span class="dot"></span>Sign out</a>
      </nav>
      <section id="staff-main"><div class="loading">Loading…</div></section>
    </div>`;
  $("#staff-signout").onclick = (ev) => { ev.preventDefault(); setEmployee(null); staffStore = null; toast("Signed out"); render(); };
  const main = $("#staff-main");
  await ({ dashboard: staffDashboard, inventory: staffInventory, orders: staffOrders, deliveries: staffDeliveries, employees: staffEmployees })[page](main);
}

function storeScopeSelect() {
  if (!isManager()) return `<span class="pill">${esc(storeName(state.employee.store_id))}</span>`;
  return `<select class="input" id="scope" style="width:auto">
    <option value="">All stores</option>
    ${state.stores.map((s) => `<option value="${s.store_id}" ${String(s.store_id) === String(staffStore) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
  </select>`;
}
function bindScope(rerender) {
  const sel = $("#scope");
  if (sel) sel.onchange = () => { staffStore = sel.value; rerender(); };
}

async function renderStaffAuth() {
  const employees = await api("/employees");
  view.innerHTML = `
    <div class="auth-wrap">
      <div class="card card-pad">
        <div class="eyebrow">Employee mode</div>
        <h1 style="font-size:22px;margin:6px 0 18px">Staff sign in</h1>
        <form class="stack" id="staff-signin">
          <label class="field">Username<input name="username" required autocomplete="username"></label>
          <label class="field">Password<input name="password" type="password" required autocomplete="current-password"></label>
          <button class="btn btn-dark btn-block">Sign in</button>
        </form>
        <div class="divider">demo shortcut</div>
        <div class="stack">
          <label class="field">Sign in as a sample employee
            <select id="demo-employee">
              ${employees.map((x) => `<option value="${x.employee_id}">${esc(x.name)} — ${esc(x.role)}, ${esc(shortStore(x.store_id))}</option>`).join("")}
            </select>
          </label>
          <button class="btn btn-ghost btn-block" id="demo-staff">Continue</button>
          <p class="muted" style="font-size:12px;margin:0">Store Managers see every store and the employee directory; Inventory staff can edit stock; others are read-only.</p>
        </div>
      </div>
    </div>`;
  const firstManager = employees.find((x) => x.department === "Management");
  if (firstManager) $("#demo-employee").value = firstManager.employee_id;
  $("#staff-signin").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const res = await api("/login", { method: "POST", body: { username: ev.target.username.value, password: ev.target.password.value, type: "employee" } });
      setEmployee(res.user);
      render();
    } catch (err) { toast(err.message, true); }
  };
  $("#demo-staff").onclick = () => {
    setEmployee(employees.find((x) => String(x.employee_id) === $("#demo-employee").value));
    staffStore = null;
    toast(`Signed in as ${state.employee.name} (demo)`);
    render();
  };
}

function vbarChart(rows, { label, value, format }) {
  const max = Math.max(...rows.map(value), 1);
  return `
    <div class="vbars" role="img" aria-label="Bar chart">
      ${rows.map((r) => `
        <div class="vbar-col" data-tip="<b>${esc(label(r, true))}</b>${esc(format(value(r)))}">
          <div class="vbar" style="height:${(value(r) / max) * 100}%"></div>
        </div>`).join("")}
    </div>
    <div class="vbar-labels">${rows.map((r) => `<span>${esc(label(r))}</span>`).join("")}</div>`;
}

function hbarChart(rows, { label, value, format, tip }) {
  const max = Math.max(...rows.map(value), 1);
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar-row" data-tip="${esc(tip(r))}">
      <span class="name">${esc(label(r))}</span>
      <div class="hbar-track"><div class="hbar" style="width:${(value(r) / max) * 100}%"></div></div>
      <span class="val">${esc(format(value(r)))}</span>
    </div>`).join("")}</div>`;
}

async function staffDashboard(main) {
  const q = staffStore ? `?store_id=${staffStore}` : "";
  const r = await api("/reports/summary" + q);
  const t = r.totals;
  main.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">Reports</div><h1>Dashboard</h1></div>
      ${storeScopeSelect()}
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="label">Revenue</div><div class="value">${fmt$(t.revenue)}</div><div class="sub">all recorded orders</div></div>
      <div class="card kpi"><div class="label">Orders</div><div class="value">${fmtInt(t.order_count)}</div><div class="sub">${fmtInt(t.customers)} unique customers</div></div>
      <div class="card kpi"><div class="label">Average order</div><div class="value">${fmt$(t.average_order)}</div><div class="sub">per checkout</div></div>
      <div class="card kpi"><div class="label">Low-stock items</div><div class="value" style="color:${t.low_stock_items ? "var(--warn)" : "inherit"}">${fmtInt(t.low_stock_items)}</div><div class="sub"><a href="#/staff/inventory" style="color:var(--accent)">at or below reorder level →</a></div></div>
    </div>
    <div class="two-col">
      <div class="card card-pad">
        <h3>Revenue by month</h3><div class="caption">Total order value per month · hover a bar for details</div>
        ${r.by_month.length ? vbarChart(r.by_month, {
          label: (m, long) => long ? new Date(m.month + "-01T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : fmtMonth(m.month),
          value: (m) => m.revenue,
          format: (v) => `${fmt$(v)}`,
        }) : `<div class="empty">No orders yet.</div>`}
      </div>
      <div class="card card-pad">
        <h3>Revenue by payment method</h3><div class="caption">Share of order value</div>
        ${hbarChart(r.by_payment, {
          label: (p) => p.payment_method, value: (p) => p.revenue, format: fmt$,
          tip: (p) => `${p.payment_method}: ${fmt$(p.revenue)} across ${p.order_count} orders`,
        })}
      </div>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-pad" style="padding-bottom:6px"><h3>Top-selling parts</h3><div class="caption">By units sold</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Part</th><th>Category</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead>
          <tbody>${r.top_parts.map((p) => `<tr><td><b>${esc(p.name)}</b><div class="part-meta mono">${esc(p.part_number)}</div></td><td>${esc(p.category)}</td><td class="num">${p.units_sold}</td><td class="num">${fmt$(p.revenue)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>
      <div class="card card-pad">
        <h3>Revenue by store</h3><div class="caption">All locations, for comparison</div>
        ${hbarChart(r.by_store, {
          label: (s) => s.name.replace(" Auto Parts", ""), value: (s) => s.revenue, format: fmt$,
          tip: (s) => `${s.name}: ${fmt$(s.revenue)} from ${s.order_count} orders`,
        })}
      </div>
    </div>`;
  bindScope(() => staffDashboard(main));
}

async function staffInventory(main) {
  const scope = staffStore || state.employee.store_id;
  if (isManager() && !staffStore) staffStore = scope; // inventory is per store
  const rows = await api(`/stores/${scope}/inventory`);
  const editable = canEditInventory();
  main.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">Inventory manager</div><h1>${esc(storeName(scope))}</h1></div>
      ${isManager() ? storeScopeSelect().replace('<option value="">All stores</option>', "") : storeScopeSelect()}
    </div>
    ${editable ? "" : `<div class="notice" style="margin-bottom:14px">You have read-only access. Inventory and Management staff can adjust stock.</div>`}
    <div class="toolbar">
      <input class="input" id="inv-search" placeholder="Filter by name or part #" style="min-width:240px">
      <label class="check"><input type="checkbox" id="inv-low"> Only items needing reorder</label>
      <span class="muted" id="inv-count" style="margin-left:auto;font-size:13px"></span>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Part</th><th>Category</th><th class="num">Price</th><th class="num">On hand</th><th class="num">Reorder at</th><th>Status</th>${editable ? "<th></th>" : ""}</tr></thead>
      <tbody id="inv-body"></tbody>
    </table></div></div>`;

  const body = $("#inv-body");
  const draw = () => {
    const q = $("#inv-search").value.toLowerCase();
    const low = $("#inv-low").checked;
    const shown = rows.filter((r) =>
      (!q || r.name.toLowerCase().includes(q) || r.part_number.toLowerCase().includes(q)) &&
      (!low || r.quantity <= r.reorder_level));
    $("#inv-count").textContent = `${shown.length} of ${rows.length} parts`;
    body.innerHTML = shown.map((r) => {
      const status = r.quantity === 0 ? `<span class="pill bad">Out</span>`
        : r.quantity <= r.reorder_level ? `<span class="pill warn">Reorder</span>` : `<span class="pill good">OK</span>`;
      const cell = (field) => editable
        ? `<input class="cell-input" type="number" min="0" data-field="${field}" data-orig="${r[field]}" value="${r[field]}">`
        : r[field];
      return `<tr data-pn="${esc(r.part_number)}">
        <td><b>${esc(r.name)}</b><div class="part-meta mono">${esc(r.part_number)}</div></td>
        <td>${esc(r.category)}</td><td class="num">${fmt$(r.price)}</td>
        <td class="num">${cell("quantity")}</td><td class="num">${cell("reorder_level")}</td>
        <td>${status}</td>
        ${editable ? `<td class="num"><button class="btn btn-dark btn-sm" data-save disabled>Save</button></td>` : ""}
      </tr>`;
    }).join("") || `<tr><td colspan="7" class="empty">Nothing matches.</td></tr>`;
  };
  draw();
  $("#inv-search").oninput = draw;
  $("#inv-low").onchange = draw;
  bindScope(() => staffInventory(main));

  body.addEventListener("input", (e) => {
    if (!e.target.dataset.field) return;
    e.target.classList.toggle("dirty", e.target.value !== e.target.dataset.orig);
    const tr = e.target.closest("tr");
    tr.querySelector("[data-save]").disabled = !$$(".cell-input.dirty", tr).length;
  });
  body.addEventListener("click", async (e) => {
    if (!e.target.matches("[data-save]")) return;
    const tr = e.target.closest("tr");
    const payload = Object.fromEntries($$(".cell-input", tr).map((i) => [i.dataset.field, Number(i.value)]));
    try {
      const updated = await api(`/stores/${scope}/inventory/${encodeURIComponent(tr.dataset.pn)}`, { method: "PATCH", body: payload });
      Object.assign(rows.find((r) => r.part_number === tr.dataset.pn), updated);
      if (Number(scope) === Number(state.storeId)) await loadStock();
      toast(`Updated ${tr.dataset.pn}`);
      draw();
    } catch (err) { toast(err.message, true); }
  });
}

async function staffOrders(main) {
  const q = staffStore ? `?store_id=${staffStore}` : "";
  const orders = await api("/orders" + q);
  main.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">Sales</div><h1>Customer orders</h1></div>
      ${storeScopeSelect()}
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Store</th><th>Fulfillment</th><th class="num">Total</th></tr></thead>
      <tbody>${orders.map((o) => `
        <tr class="clickable" data-order="${o.order_id}">
          <td class="mono">#${o.order_id}</td><td>${fmtDate(o.order_date)}</td><td>${esc(o.customer_name)}</td>
          <td>${esc(shortStore(o.store_id))}</td>
          <td>${o.delivery_address ? `<span class="pill">Delivery</span>` : `<span class="pill">Pickup</span>`}</td>
          <td class="num"><b>${fmt$(o.total_amount)}</b></td>
        </tr>`).join("") || `<tr><td colspan="6" class="empty">No orders.</td></tr>`}
      </tbody>
    </table></div></div>`;
  bindScope(() => staffOrders(main));
  main.querySelector("tbody").onclick = (e) => {
    const row = e.target.closest("[data-order]");
    if (row) showOrder(row.dataset.order);
  };
}

async function staffDeliveries(main) {
  const q = staffStore ? `?store_id=${staffStore}` : "";
  const pos = await api("/purchase-orders" + q);
  const now = today();
  main.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">Supplier deliveries</div><h1>Purchase orders</h1></div>
      ${storeScopeSelect()}
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>PO</th><th>Supplier</th><th>Store</th><th>Ordered by</th><th>Ordered</th><th>Expected</th><th>Status</th><th class="num">Cost</th></tr></thead>
      <tbody>${pos.map((p) => `
        <tr class="clickable" data-po="${p.po_id}">
          <td class="mono">#${p.po_id}</td><td>${esc(p.supplier_name)}</td><td>${esc(shortStore(p.store_id))}</td>
          <td>${esc(p.employee_name)}</td><td>${fmtDate(p.order_date)}</td><td>${fmtDate(p.expected_date)}</td>
          <td>${p.expected_date > now ? `<span class="pill warn">In transit</span>` : `<span class="pill good">Delivered</span>`}</td>
          <td class="num"><b>${fmt$(p.total_cost)}</b></td>
        </tr>`).join("") || `<tr><td colspan="8" class="empty">No purchase orders.</td></tr>`}
      </tbody>
    </table></div></div>`;
  bindScope(() => staffDeliveries(main));
  main.querySelector("tbody").onclick = async (e) => {
    const row = e.target.closest("[data-po]");
    if (!row) return;
    const po = await api(`/purchase-orders/${row.dataset.po}`);
    const total = po.lines.reduce((s, l) => s + l.line_total, 0);
    openModal(`
      <div class="eyebrow">Purchase order #${po.po_id}</div>
      <h2 style="font-size:22px;margin:6px 0 4px">${esc(po.supplier_name)}</h2>
      <div class="muted" style="font-size:13.5px">${esc(po.store_name)} · ordered ${fmtDate(po.order_date)} by ${esc(po.employee_name)} · expected ${fmtDate(po.expected_date)}</div>
      <div class="table-wrap" style="margin-top:18px"><table>
        <thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead>
        <tbody>${po.lines.map((l) => `<tr><td><b>${esc(l.name)}</b><div class="part-meta mono">${esc(l.part_number)}</div></td><td class="num">${l.quantity}</td><td class="num">${fmt$(l.unit_cost)}</td><td class="num">${fmt$(l.line_total)}</td></tr>`).join("")}
          <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${fmt$(total)}</b></td></tr>
        </tbody>
      </table></div>`);
  };
}

async function staffEmployees(main) {
  const q = staffStore ? `?store_id=${staffStore}` : "";
  const employees = await api("/employees" + q);
  main.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">Management</div><h1>Employees</h1></div>
      ${storeScopeSelect()}
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Store</th><th>Contact</th><th>Hired</th></tr></thead>
      <tbody>${employees.map((x) => `
        <tr><td><b>${esc(x.name)}</b><div class="part-meta">@${esc(x.username)}</div></td>
        <td>${esc(x.role)}</td><td><span class="pill">${esc(x.department)}</span></td><td>${esc(shortStore(x.store_id))}</td>
        <td><div>${esc(x.email)}</div><div class="part-meta">${esc(x.phone)}</div></td><td>${fmtDate(x.hire_date)}</td></tr>`).join("")}
      </tbody>
    </table></div></div>`;
  bindScope(() => staffEmployees(main));
}

// ------------------------------------------------------------------ router
async function render() {
  const [, section = "shop", sub] = (location.hash || "#/shop").split("/");
  const staff = section === "staff";
  $$(".mode-switch a").forEach((a) => a.classList.toggle("active", a.dataset.mode === (staff ? "staff" : "shop")));
  $(".store-picker").hidden = staff;
  $("#account-btn").hidden = staff;
  $("#cart-btn").hidden = staff;
  view.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    if (staff) await renderStaff(sub);
    else if (section === "account") await renderAccount();
    else await renderShop();
  } catch (err) {
    view.innerHTML = `<div class="card card-pad empty"><b>Something went wrong.</b><br>${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    state.stores = await api("/stores");
  } catch (err) {
    view.innerHTML = `<div class="card card-pad empty"><b>Can't load the store.</b><br>${esc(err.message)}<br><br>Start it with <span class="mono">python -m api.app</span> and open <span class="mono">http://localhost:5000</span>.</div>`;
    return;
  }
  if (!state.stores.some((s) => s.store_id === Number(state.storeId))) {
    state.storeId = state.customer?.preferred_store_id ?? state.stores[0].store_id;
  }
  const select = $("#store-select");
  select.innerHTML = state.stores.map((s) => `<option value="${s.store_id}">${esc(s.name)}</option>`).join("");
  select.value = state.storeId;
  select.onchange = async () => {
    state.storeId = Number(select.value);
    store.set("storeId", state.storeId);
    await loadStock();
    render();
  };
  setCustomer(state.customer);
  saveCart();
  await loadStock();
  window.addEventListener("hashchange", render);
  render();
}

boot();
