'use strict';

(function () {
  const listEl = document.getElementById('leads-list');
  const viewEl = document.getElementById('lead-view');
  const encNote = document.getElementById('enc-note');
  if (!listEl) return;

  let STATUSES = ['new', 'contacted', 'touring', 'application', 'placed', 'closed'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function load() {
    let data;
    try {
      const resp = await fetch('/api/leads');
      if (!resp.ok) return;
      data = await resp.json();
    } catch { return; }

    STATUSES = data.statuses || STATUSES;
    if (encNote) encNote.textContent = data.encrypted
      ? 'Encryption at rest: on.'
      : 'Encryption at rest: OFF — set DATA_ENCRYPTION_KEY.';

    if (!data.leads.length) {
      listEl.innerHTML = '<p class="muted">No clients yet. Fill the form above and choose “Save to my clients”.</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const l of data.leads) {
      const row = document.createElement('div');
      row.className = 'lead-row';
      const meta = [l.age, l.carePreference, l.location].filter((x) => x && x !== '[not provided]').join(' · ');
      row.innerHTML = `
        <div class="lead-main">
          <strong>${esc(l.name)}</strong>
          <span class="muted">${esc(meta)}</span>
          ${l.source ? `<span class="lead-src">referred by ${esc(l.source)}</span>` : ''}
        </div>
        <div class="lead-actions">
          <select class="lead-status">${STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <button type="button" class="link-btn lead-view">View</button>
          <button type="button" class="link-btn lead-del">Delete</button>
        </div>`;
      row.querySelector('.lead-status').addEventListener('change', (e) => setStatus(l.id, e.target.value));
      row.querySelector('.lead-view').addEventListener('click', () => view(l.id));
      row.querySelector('.lead-del').addEventListener('click', () => del(l.id));
      listEl.appendChild(row);
    }
  }

  async function setStatus(id, status) {
    await fetch('/api/leads/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  }

  async function del(id) {
    if (!window.confirm('Delete this client record? This cannot be undone.')) return;
    await fetch('/api/leads/' + encodeURIComponent(id), { method: 'DELETE' });
    if (viewEl) viewEl.hidden = true;
    load();
  }

  async function view(id) {
    const role = (document.getElementById('cl-viewerRole') || {}).value || 'matching_only';
    const mode = (document.getElementById('cl-outputMode') || {}).value || 'profile';
    try {
      const resp = await fetch(`/api/leads/${encodeURIComponent(id)}?viewerRole=${role}&outputMode=${mode}`);
      const data = await resp.json();
      if (!resp.ok) return;
      if (window.renderSafeProfile) window.renderSafeProfile(data.rendered, viewEl);
      viewEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch { /* ignore */ }
  }

  window.reloadLeads = load;
  load();
})();
