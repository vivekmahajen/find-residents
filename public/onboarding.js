'use strict';

(function () {
  const panel = document.getElementById('onboard-panel');
  const list = document.getElementById('onboard-steps');
  const dismiss = document.getElementById('onboard-dismiss');
  if (!panel) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function load() {
    if (localStorage.getItem('onboard-dismissed') === '1') return;
    let d;
    try { const r = await fetch('/api/onboarding'); if (!r.ok) return; d = await r.json(); } catch { return; }
    if (d.complete) { panel.hidden = true; return; }
    list.innerHTML = d.steps.map((s) => `
      <li class="onboard-step ${s.done ? 'done' : ''}">
        <span class="ob-check">${s.done ? '✓' : '○'}</span>
        <span class="ob-label">${esc(s.label)}</span>
        ${s.done ? '' : `<span class="ob-hint muted">${esc(s.hint)}</span>`}
      </li>`).join('');
    panel.hidden = false;
  }

  if (dismiss) dismiss.addEventListener('click', () => { localStorage.setItem('onboard-dismissed', '1'); panel.hidden = true; });

  // Refresh as the user completes steps elsewhere on the page.
  window.refreshOnboarding = load;
  load();
})();
