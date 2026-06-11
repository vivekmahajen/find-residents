// App shell: persistent sidebar + header + content outlet, History-API router,
// declarative nav registry, widget mount/unmount contract, auth-aware nav.
// Widgets are lazy-loaded ES modules exporting { title, requiresAuth, mount, unmount }.

// ---- Tiny pub/sub store ----------------------------------------------------
const store = {
  state: { user: null, ready: false },
  subs: new Set(),
  set(patch) { Object.assign(this.state, patch); this.subs.forEach((f) => f(this.state)); },
  sub(f) { this.subs.add(f); return () => this.subs.delete(f); },
};

// ---- Nav registry (the heart of extensibility) -----------------------------
// Add a view = add one entry here + a /widgets/<id>.js module. No shell edits.
const REGISTRY = [
  { id: 'home', label: 'Home', icon: '🏠', requiresAuth: true, load: () => import('/widgets/home.js') },
  { id: 'resources', label: 'Resources', icon: '🏥', requiresAuth: true, load: () => import('/widgets/resources.js') },
  { id: 'coverage', label: 'CDSS Coverage', icon: '🗺️', requiresAuth: true, load: () => import('/widgets/coverage.js') },
  { id: 'reports', label: 'Reports', icon: '📊', requiresAuth: true, load: () => import('/widgets/reports.js') },
  { id: 'pricing', label: 'Pricing', icon: '💳', requiresAuth: true, load: () => import('/widgets/pricing.js') },
  { id: 'profile', label: 'Profile', icon: '🪪', requiresAuth: true, load: () => import('/widgets/profile.js') },
  { id: 'login', label: 'Log in', icon: '🔑', requiresAuth: false, load: () => import('/widgets/login.js') },
];
// External link (not a widget) — the live workspace where the day-to-day work
// happens (referral search → leads → CRM). Stays the operational hub.
const EXTERNAL = [{ id: 'classic', label: 'Workspace ↗', icon: '🗂️', href: '/app', requiresAuth: true }];

const byId = (id) => REGISTRY.find((e) => e.id === id);
const defaultViewId = () => (store.state.user ? 'home' : 'login');

// ---- DOM refs --------------------------------------------------------------
const navEl = document.getElementById('nav');
const outlet = document.getElementById('view');
const titleEl = document.getElementById('view-title');
const userMenu = document.getElementById('user-menu');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
const hamburger = document.getElementById('hamburger');

// ---- Session ---------------------------------------------------------------
async function hydrateSession() {
  try {
    const r = await fetch('/api/auth/me');
    store.set({ user: r.ok ? (await r.json()).user : null, ready: true });
  } catch {
    store.set({ user: null, ready: true });
  }
}

// ---- Router + outlet manager ----------------------------------------------
let current = null; // { entry, unmount }
let navToken = 0;

function pathToId(pathname) {
  const m = pathname.match(/^\/shell\/([\w-]+)/);
  return m ? m[1] : null;
}

function navigate(id, { replace = false, params = {} } = {}) {
  const path = `/shell/${id}`;
  if (replace) history.replaceState({ id }, '', path);
  else history.pushState({ id }, '', path);
  resolve(params);
}

async function resolve(params = {}) {
  const id = pathToId(location.pathname) || defaultViewId();
  let entry = byId(id);

  // Unknown route → 404 view.
  if (!entry) { renderNotFound(); renderNav(); return; }

  // Auth guard (client-side UX; server still enforces every data call).
  if (entry.requiresAuth && !store.state.user) {
    sessionStorage.setItem('shell:next', id);
    navigate('login', { replace: true });
    return;
  }
  // Logged-in users hitting login → bounce to home.
  if (entry.id === 'login' && store.state.user) { navigate('home', { replace: true }); return; }

  const token = ++navToken;
  if (current && current.unmount) { try { current.unmount(); } catch { /* ignore */ } }
  current = null;
  outlet.innerHTML = '<div class="view-loading"><span class="spinner"></span> Loading…</div>';
  renderNav();
  closeDrawer();

  try {
    const mod = await entry.load();
    if (token !== navToken) return; // a newer navigation superseded this one
    const widget = mod.default || mod.widget || mod;
    outlet.innerHTML = '';
    const ctx = {
      user: store.state.user,
      params,
      navigate,
      refreshSession: hydrateSession,
      go: (toId) => navigate(toId),
    };
    const teardown = await widget.mount(outlet, ctx);
    current = { entry, unmount: typeof teardown === 'function' ? teardown : widget.unmount };
    titleEl.textContent = widget.title || entry.label;
    document.title = `${widget.title || entry.label} · Find-Residents`;
    focusHeading();
    outlet.scrollTop = 0;
  } catch (err) {
    if (token !== navToken) return;
    renderError(entry, params, err);
  }
}

function focusHeading() {
  const h = outlet.querySelector('h1');
  (h || outlet).setAttribute('tabindex', '-1');
  (h || outlet).focus({ preventScroll: true });
}

function renderNotFound() {
  outlet.innerHTML = '<div class="panel"><h1>Not found</h1><p class="muted">That view doesn’t exist.</p><button class="primary-btn" id="nf-home">Go home</button></div>';
  const b = document.getElementById('nf-home');
  if (b) b.addEventListener('click', () => navigate(defaultViewId()));
  titleEl.textContent = 'Not found';
}

function renderError(entry, params, err) {
  outlet.innerHTML = `<div class="panel"><h1>Couldn’t load ${entry.label}</h1><p class="panel-error">${String(err && err.message || err)}</p><button class="primary-btn" id="err-retry">Retry</button></div>`;
  const b = document.getElementById('err-retry');
  if (b) b.addEventListener('click', () => resolve(params));
}

// ---- Sidebar + header rendering -------------------------------------------
function renderNav() {
  const user = store.state.user;
  const activeId = pathToId(location.pathname) || defaultViewId();
  // Logged in: show auth views + externals (not Login). Logged out: only Login.
  const visible = user
    ? [...REGISTRY.filter((e) => e.requiresAuth), ...EXTERNAL]
    : REGISTRY.filter((e) => e.requiresAuth === false);

  navEl.innerHTML = visible.map((e) => {
    const active = e.id === activeId;
    if (e.href) return `<a class="nav-item" href="${e.href}"><span class="nav-icon">${e.icon}</span>${e.label}</a>`;
    return `<button class="nav-item ${active ? 'active' : ''}" data-id="${e.id}" ${active ? 'aria-current="page"' : ''}><span class="nav-icon">${e.icon}</span>${e.label}</button>`;
  }).join('');

  navEl.querySelectorAll('.nav-item[data-id]').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.id));
  });

  // Header user menu
  if (user) {
    userMenu.innerHTML = `<span class="who">${escapeHtml(user.username)}</span><button class="link-btn" id="logout-btn">Log out</button>`;
    const lb = document.getElementById('logout-btn');
    if (lb) lb.addEventListener('click', logout);
  } else {
    userMenu.innerHTML = '';
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  store.set({ user: null });
  navigate('login', { replace: true });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Mobile drawer ---------------------------------------------------------
function openDrawer() { sidebar.classList.add('open'); overlay.hidden = false; hamburger.setAttribute('aria-expanded', 'true'); }
function closeDrawer() { sidebar.classList.remove('open'); overlay.hidden = true; hamburger.setAttribute('aria-expanded', 'false'); }
hamburger.addEventListener('click', () => (sidebar.classList.contains('open') ? closeDrawer() : openDrawer()));
overlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---- Boot ------------------------------------------------------------------
window.addEventListener('popstate', () => resolve());
store.sub(() => renderNav());

(async function boot() {
  renderNav();
  await hydrateSession();
  // If at /shell (no view), route to the default.
  if (!pathToId(location.pathname)) navigate(defaultViewId(), { replace: true });
  else resolve();
})();
