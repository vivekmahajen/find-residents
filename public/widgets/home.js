// Home widget — onboarding checklist + entry to the workspace.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export default {
  title: 'Home',
  requiresAuth: true,
  async mount(el, ctx) {
    el.innerHTML = `
      <div class="panel">
        <h1>Welcome${ctx.user ? ', ' + esc(ctx.user.username) : ''}</h1>
        <p class="subtitle">Finish setup, then work the full toolset in the workspace.</p>
        <ul id="ob" class="onboard-steps"><li class="muted">Loading…</li></ul>
        <p style="margin-top:1rem"><a class="primary-btn" href="/app">Open the workspace →</a></p>
      </div>`;
    const ctrl = new AbortController();
    try {
      const r = await fetch('/api/onboarding', { signal: ctrl.signal });
      if (!r.ok) throw new Error('Could not load your checklist.');
      const d = await r.json();
      el.querySelector('#ob').innerHTML = (d.steps || []).map((s) => `
        <li class="onboard-step ${s.done ? 'done' : ''}">
          <span class="ob-check">${s.done ? '✓' : '○'}</span>
          <span class="ob-label">${esc(s.label)}</span>
          ${s.done ? '' : `<span class="ob-hint muted">${esc(s.hint)}</span>`}
        </li>`).join('');
    } catch (e) {
      if (e.name !== 'AbortError') el.querySelector('#ob').innerHTML = `<li class="panel-error">${esc(e.message)}</li>`;
    }
    return () => ctrl.abort();
  },
};
