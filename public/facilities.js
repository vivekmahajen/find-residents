'use strict';

(function () {
  const listEl = document.getElementById('facilities-list');
  const countEl = document.getElementById('fac-count');
  const addBtn = document.getElementById('add-facility');
  const facStatus = document.getElementById('facility-status');
  const importBtn = document.getElementById('import-facilities');
  const importStatus = document.getElementById('import-status');
  const seedBtn = document.getElementById('seed-facilities');
  if (!listEl) return;

  const FORM_FIELDS = ['name', 'type', 'ca_license_number', 'city', 'county', 'zip', 'price_min', 'price_max', 'availability_status', 'payors_accepted', 'room_types', 'capabilities', 'languages'];
  const AVAIL = ['open', 'limited', 'full', 'unknown'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const TYPE_LABEL = { board_and_care_RCFE: 'Board & care', assisted_living: 'Assisted living', memory_care: 'Memory care', independent_living: 'Independent', SNF: 'SNF' };

  async function load() {
    let data;
    try { const r = await fetch('/api/facilities'); if (!r.ok) return; data = await r.json(); } catch { return; }
    const facs = data.facilities || [];
    countEl.textContent = facs.length ? `(${facs.length})` : '';
    if (!facs.length) { listEl.innerHTML = '<p class="muted">No facilities yet. Add one, import a CSV, or load CA demo data.</p>'; return; }
    listEl.innerHTML = '';
    for (const f of facs) {
      const row = document.createElement('div');
      row.className = 'lead-row';
      const price = f.price_min || f.price_max ? `$${f.price_min || '?'}–${f.price_max || '?'}` : '';
      const shared = f.agencyId == null;
      row.innerHTML = `
        <div class="lead-main">
          <strong>${esc(f.name)}</strong>
          <span class="muted">${esc(TYPE_LABEL[f.type] || f.type)} · ${esc(f.city || '')} ${esc(price)}</span>
          <span class="muted">${esc((f.payors_accepted || []).join(', '))}</span>
        </div>
        <div class="lead-actions">
          <select class="fac-avail" ${shared ? 'disabled' : ''}>${AVAIL.map((a) => `<option value="${a}" ${a === f.availability_status ? 'selected' : ''}>${a}</option>`).join('')}</select>
          ${shared ? '<span class="muted">shared</span>' : '<button type="button" class="link-btn fac-del">Delete</button>'}
        </div>`;
      if (!shared) {
        row.querySelector('.fac-avail').addEventListener('change', (e) => updateAvail(f.id, e.target.value));
        row.querySelector('.fac-del').addEventListener('click', () => del(f.id));
      }
      listEl.appendChild(row);
    }
  }

  async function updateAvail(id, status) {
    await fetch('/api/facilities/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ availability_status: status }) });
  }
  async function del(id) {
    if (!window.confirm('Delete this facility?')) return;
    await fetch('/api/facilities/' + encodeURIComponent(id), { method: 'DELETE' });
    load();
  }

  if (addBtn) addBtn.addEventListener('click', async () => {
    const body = {};
    for (const f of FORM_FIELDS) { const el = document.getElementById('fa-' + f); if (el) body[f] = el.value; }
    addBtn.disabled = true; facStatus.textContent = 'Adding…';
    try {
      const r = await fetch('/api/facilities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { facStatus.textContent = d.error || 'Could not add.'; return; }
      facStatus.textContent = 'Added.';
      document.getElementById('fa-name').value = '';
      load();
    } catch { facStatus.textContent = 'Network error.'; } finally { addBtn.disabled = false; }
  });

  if (importBtn) importBtn.addEventListener('click', async () => {
    const csv = document.getElementById('fa-csv').value;
    importBtn.disabled = true; importStatus.textContent = 'Importing…';
    try {
      const r = await fetch('/api/facilities/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
      const d = await r.json();
      importStatus.textContent = r.ok ? `Imported ${d.created}${d.errors && d.errors.length ? ' (' + d.errors.length + ' skipped)' : ''}.` : (d.error || 'Failed.');
      if (r.ok) load();
    } catch { importStatus.textContent = 'Network error.'; } finally { importBtn.disabled = false; }
  });

  if (seedBtn) seedBtn.addEventListener('click', async () => {
    seedBtn.disabled = true;
    try { await fetch('/api/facilities/sample', { method: 'POST' }); load(); } finally { seedBtn.disabled = false; }
  });

  // Shared match renderer used by leads.js (View shortlist for a lead).
  window.renderMatch = function (data, target) {
    const fitClass = (f) => 'fit-' + String(f).toLowerCase();
    const rows = (data.results || []).slice(0, 8).map((r) => {
      const crit = r.criteria.map((c) => `<span class="fitchip ${fitClass(c.fit)}" title="${esc(c.detail)}">${esc(c.name)}</span>`).join('');
      const flags = r.flags && r.flags.length ? `<div class="match-flags">⚠️ ${r.flags.map(esc).join('; ')}</div>` : '';
      const d = r.disclosures || {};
      const disc = `<div class="match-disc">Disclosures — fee: ${esc(d.feePaidByFacility)} · license: ${esc(d.licenseStatus)}${d.licenseNumber ? ' (' + esc(d.licenseNumber) + ')' : ''} · violations: ${esc(d.knownViolations)}. ${esc(d.note)}</div>`;
      return `<div class="match-card ${r.recommended ? '' : 'not-rec'}">
        <div class="match-top"><strong>${esc(r.name)}</strong><span class="score">${r.score}<span class="muted">/100</span> ${r.recommended ? '<span class="rec">recommended</span>' : '<span class="norec">not recommended</span>'}</span></div>
        <div class="fitchips">${crit}</div>${flags}${disc}</div>`;
    }).join('');
    target.innerHTML = `<div class="cl-head"><h3>Care-home shortlist <span class="muted">· ${data.count} facilities scored</span></h3></div>${rows || '<p class="muted">No facilities to match — add inventory first.</p>'}`;
    target.hidden = false;
  };

  window.reloadFacilities = load;
  load();
})();
