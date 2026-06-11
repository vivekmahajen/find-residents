// CDSS Coverage widget — facility inventory + CDSS licensing import, as its own
// sidebar option. Reuses /api/facilities (list/add/avail/delete), CSV import,
// CA sample seed, and the CDSS county import (/api/facilities/cdss-import).
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const TYPE_LABEL = { board_and_care_RCFE: 'Board & care', assisted_living: 'Assisted living', memory_care: 'Memory care', independent_living: 'Independent', SNF: 'SNF' };
const AVAIL = ['open', 'limited', 'full', 'unknown'];

export default {
  title: 'CDSS Coverage',
  requiresAuth: true,
  async mount(el, ctx) {
    el.innerHTML = `
      <div class="panel">
        <h1>CDSS Coverage</h1>
        <p class="subtitle">Your care-home inventory, plus CA licensing data imported from CDSS.</p>

        <div class="cov-tools">
          <div class="cov-block">
            <h3>Import from CDSS</h3>
            <label class="pf-label">County
              <input id="cdss-county" type="text" placeholder="e.g. Los Angeles" />
            </label>
            <div class="cov-btn-row">
              <button class="link-btn" id="cdss-preview" type="button">Preview</button>
              <button class="primary-btn" id="cdss-import" type="button">Import</button>
            </div>
            <p id="cdss-status" class="plan-status" aria-live="polite"></p>
          </div>
          <div class="cov-block">
            <h3>CSV import / demo</h3>
            <textarea id="fa-csv" rows="3" placeholder="name,type,city,price_min,price_max,payors_accepted…"></textarea>
            <div class="cov-btn-row">
              <button class="link-btn" id="import-facilities" type="button">Import CSV</button>
              <button class="link-btn" id="seed-facilities" type="button">Load CA demo data</button>
            </div>
            <p id="import-status" class="plan-status" aria-live="polite"></p>
          </div>
        </div>

        <details class="cov-add">
          <summary>Add a facility manually</summary>
          <div class="cov-form" id="fa-form"></div>
          <div class="cov-btn-row"><button class="primary-btn" id="add-facility" type="button">Add facility</button><span id="facility-status" class="plan-status"></span></div>
        </details>

        <h3>Inventory <span id="fac-count" class="muted"></span></h3>
        <div id="facilities-list"><p class="muted">Loading…</p></div>
      </div>`;
    const ctrl = new AbortController();
    const $ = (id) => el.querySelector('#' + id);

    const FORM_FIELDS = ['name', 'type', 'ca_license_number', 'city', 'county', 'zip', 'price_min', 'price_max', 'availability_status', 'payors_accepted', 'room_types', 'capabilities', 'languages'];
    $('fa-form').innerHTML = FORM_FIELDS.map((f) => `<label class="pf-label">${esc(f.replace(/_/g, ' '))}<input id="fa-${f}" type="text" /></label>`).join('');

    async function load() {
      let data;
      try { const r = await fetch('/api/facilities', { signal: ctrl.signal }); if (!r.ok) return; data = await r.json(); } catch (e) { if (e.name !== 'AbortError') $('facilities-list').innerHTML = `<p class="panel-error">${esc(e.message)}</p>`; return; }
      const facs = data.facilities || [];
      $('fac-count').textContent = facs.length ? `(${facs.length})` : '';
      if (!facs.length) { $('facilities-list').innerHTML = '<p class="muted">No facilities yet. Add one, import a CSV, or load CA demo data.</p>'; return; }
      $('facilities-list').innerHTML = '';
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
          row.querySelector('.fac-avail').addEventListener('change', (e) => fetch('/api/facilities/' + encodeURIComponent(f.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ availability_status: e.target.value }) }));
          row.querySelector('.fac-del').addEventListener('click', async () => { if (!window.confirm('Delete this facility?')) return; await fetch('/api/facilities/' + encodeURIComponent(f.id), { method: 'DELETE' }); load(); });
        }
        $('facilities-list').appendChild(row);
      }
    }

    $('add-facility').addEventListener('click', async () => {
      const body = {};
      for (const f of FORM_FIELDS) { const node = $('fa-' + f); if (node) body[f] = node.value; }
      $('add-facility').disabled = true; $('facility-status').textContent = 'Adding…';
      try {
        const r = await fetch('/api/facilities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) { $('facility-status').textContent = d.error || 'Could not add.'; return; }
        $('facility-status').textContent = 'Added.'; $('fa-name').value = ''; load();
      } catch { $('facility-status').textContent = 'Network error.'; } finally { $('add-facility').disabled = false; }
    });

    $('import-facilities').addEventListener('click', async () => {
      $('import-facilities').disabled = true; $('import-status').textContent = 'Importing…';
      try {
        const r = await fetch('/api/facilities/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: $('fa-csv').value }) });
        const d = await r.json();
        $('import-status').textContent = r.ok ? `Imported ${d.created}${d.errors && d.errors.length ? ' (' + d.errors.length + ' skipped)' : ''}.` : (d.error || 'Failed.');
        if (r.ok) load();
      } catch { $('import-status').textContent = 'Network error.'; } finally { $('import-facilities').disabled = false; }
    });

    $('seed-facilities').addEventListener('click', async () => {
      $('seed-facilities').disabled = true;
      try { await fetch('/api/facilities/sample', { method: 'POST' }); load(); } finally { $('seed-facilities').disabled = false; }
    });

    async function cdss(dryRun) {
      $('cdss-status').textContent = dryRun ? 'Previewing…' : 'Importing…';
      try {
        const r = await fetch('/api/facilities/cdss-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ county: $('cdss-county').value.trim(), dryRun }) });
        const d = await r.json();
        if (!r.ok) { $('cdss-status').textContent = d.error || 'CDSS import failed.'; return; }
        if (dryRun) {
          const dg = d.diagnostic || {};
          if (d.count > 0) {
            $('cdss-status').textContent = `Found ${d.count} facility/ies${d.preview && d.preview[0] ? ` — e.g. ${d.preview[0].name} (${d.preview[0].license_status})` : ''}.`;
          } else {
            // Zero matched — show WHY (fetched rows, columns seen, counties seen).
            const seen = (dg.countiesSeen || []).join(', ');
            $('cdss-status').innerHTML = `Found 0 for that county. <span class="muted">Source fetched <strong>${dg.fetchedRows || 0}</strong> rows`
              + `${dg.mappedRows != null ? `, mapped <strong>${dg.mappedRows}</strong>` : ''}.`
              + `${dg.columns && dg.columns.length ? ` Columns: ${esc(dg.columns.join(', '))}.` : ''}`
              + `${seen ? ` Counties in data: ${esc(seen)}.` : ''}`
              + `${dg.fetchedRows === 0 && dg.sampleRaw ? ` First bytes: ${esc(String(dg.sampleRaw))}` : ''}</span>`;
          }
        } else { $('cdss-status').textContent = `Imported ${d.created} facilities.`; load(); }
      } catch { $('cdss-status').textContent = 'Network error.'; }
    }
    $('cdss-preview').addEventListener('click', () => cdss(true));
    $('cdss-import').addEventListener('click', () => cdss(false));

    await load();
    return () => ctrl.abort();
  },
};
