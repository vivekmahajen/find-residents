// Resources widget — the roster of referral sources (hospitals/SNF/hospice that
// send you clients). Pulls the source list out of Reports into its own working
// view: merges placements/revenue (from /api/reports) with live lead counts
// (from /api/leads), and lets you add a new source + first contact in one step
// (POST /api/sources/:ref/contacts, the existing CRM endpoint).
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return '$' + Number(n || 0).toLocaleString('en-US'); }

export default {
  title: 'Resources',
  requiresAuth: true,
  async mount(el, ctx) {
    el.innerHTML = `
      <div class="panel">
        <h1>Referral sources</h1>
        <p class="subtitle">Hospitals, SNFs and hospice/home-health agencies that refer clients to you. Find new ones in the <a href="/app">Workspace</a>; track and grow them here.</p>

        <details class="cov-add">
          <summary>Add a source</summary>
          <div class="cov-form">
            <label class="pf-label">Source name *<input id="rs-source" type="text" placeholder="e.g. Cedars-Sinai – Case Mgmt" /></label>
            <label class="pf-label">NPI (optional)<input id="rs-npi" type="text" placeholder="10-digit NPI" /></label>
            <label class="pf-label">Contact name *<input id="rs-name" type="text" placeholder="Discharge planner" /></label>
            <label class="pf-label">Title<input id="rs-title" type="text" /></label>
            <label class="pf-label">Phone<input id="rs-phone" type="text" /></label>
            <label class="pf-label">Email<input id="rs-email" type="text" /></label>
          </div>
          <div class="cov-btn-row"><button class="primary-btn" id="rs-add" type="button">Add source</button><span id="rs-status" class="plan-status" aria-live="polite"></span></div>
        </details>

        <h3>Your sources <span id="rs-count" class="muted"></span></h3>
        <div id="rs-list"><p class="muted">Loading…</p></div>
      </div>`;
    const ctrl = new AbortController();
    const $ = (id) => el.querySelector('#' + id);

    async function load() {
      let report = { sourceLeaderboard: [] }; let leads = [];
      try {
        const [rR, lR] = await Promise.all([
          fetch('/api/reports?days=0', { signal: ctrl.signal }),
          fetch('/api/leads', { signal: ctrl.signal }),
        ]);
        if (rR.ok) report = await rR.json();
        if (lR.ok) leads = (await lR.json()).leads || [];
      } catch (e) { if (e.name !== 'AbortError') $('rs-list').innerHTML = `<p class="panel-error">${esc(e.message)}</p>`; return; }

      // Merge: every source seen in placements + every source referenced by a lead.
      const roster = new Map();
      for (const s of (report.sourceLeaderboard || [])) {
        roster.set(s.source, { source: s.source, placements: s.placements || 0, revenue: s.revenue || 0, leads: 0 });
      }
      for (const l of leads) {
        const src = (l.source || '').trim();
        if (!src) continue;
        const cur = roster.get(src) || { source: src, placements: 0, revenue: 0, leads: 0 };
        cur.leads += 1;
        roster.set(src, cur);
      }
      const rows = [...roster.values()].sort((a, b) => (b.placements - a.placements) || (b.leads - a.leads) || a.source.localeCompare(b.source));
      $('rs-count').textContent = rows.length ? `(${rows.length})` : '';
      if (!rows.length) { $('rs-list').innerHTML = '<p class="muted">No sources yet. Add one above, or save a referred client in the Workspace and the source shows up here.</p>'; return; }
      $('rs-list').innerHTML = `<table class="rep-table"><tr><th>Source</th><th>Active leads</th><th>Placements</th><th>Revenue</th></tr>${rows.map((r) => `<tr><td>${esc(r.source)}</td><td>${r.leads}</td><td>${r.placements}</td><td>${money(r.revenue)}</td></tr>`).join('')}</table>`;
    }

    $('rs-add').addEventListener('click', async () => {
      const source = $('rs-source').value.trim();
      const name = $('rs-name').value.trim();
      if (!source) { $('rs-status').textContent = 'Source name is required.'; return; }
      if (!name) { $('rs-status').textContent = 'Contact name is required.'; return; }
      const ref = $('rs-npi').value.trim() || source;
      $('rs-add').disabled = true; $('rs-status').textContent = 'Adding…';
      try {
        const r = await fetch('/api/sources/' + encodeURIComponent(ref) + '/contacts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceRef: ref, name, title: $('rs-title').value.trim(), phone: $('rs-phone').value.trim(), email: $('rs-email').value.trim() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { $('rs-status').textContent = d.error || 'Could not add source.'; return; }
        $('rs-status').textContent = 'Added.';
        ['rs-source', 'rs-npi', 'rs-name', 'rs-title', 'rs-phone', 'rs-email'].forEach((id) => { $(id).value = ''; });
        load();
      } catch { $('rs-status').textContent = 'Network error.'; } finally { $('rs-add').disabled = false; }
    });

    await load();
    return () => ctrl.abort();
  },
};
