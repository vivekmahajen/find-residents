// Reports widget — placement funnel + conversions + source leaderboard.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return '$' + Number(n || 0).toLocaleString('en-US'); }

export default {
  title: 'Reports',
  requiresAuth: true,
  async mount(el, ctx) {
    el.innerHTML = `
      <div class="panel">
        <div class="plan-head"><h1>Reports</h1>
          <select id="rp"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="0">All time</option></select>
        </div>
        <div id="funnel" class="funnel"></div>
        <div id="meta" class="report-meta"></div>
        <h3>Source leaderboard</h3><div id="lb"></div>
        <h3>Activity</h3><div id="act" class="report-meta"></div>
      </div>`;
    let ctrl;
    async function load() {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      try {
        const d = await (await fetch('/api/reports?days=' + el.querySelector('#rp').value, { signal: ctrl.signal })).json();
        const f = d.funnel; const co = d.conversions;
        const steps = [['Sources', f.sourcesContacted, null], ['Leads', f.leadsReceived, co.contactToLead], ['Tours', f.tours, co.leadToTour], ['Applications', f.applications, co.tourToApplication], ['Placements', f.placements, co.applicationToPlacement]];
        el.querySelector('#funnel').innerHTML = steps.map(([l, n, c], i) => `${i ? `<div class="funnel-arrow">${c}%</div>` : ''}<div class="funnel-step"><div class="fn-num">${n}</div><div class="fn-label">${esc(l)}</div></div>`).join('');
        el.querySelector('#meta').innerHTML = `<span><strong>${co.leadToPlacement}%</strong> lead→placement</span><span><strong>${d.timeToPlacementDays != null ? d.timeToPlacementDays + ' days' : '—'}</strong> avg time-to-placement</span><span><strong>${money(d.revenue.total)}</strong> revenue</span>`;
        el.querySelector('#lb').innerHTML = d.sourceLeaderboard.length ? `<table class="rep-table"><tr><th>Source</th><th>Placements</th><th>Revenue</th></tr>${d.sourceLeaderboard.map((s) => `<tr><td>${esc(s.source)}</td><td>${s.placements}</td><td>${money(s.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No placements yet.</p>';
        const a = d.activity;
        el.querySelector('#act').innerHTML = [['Searches', a.searches], ['Cases', a.casesGenerated], ['Decks', a.decksBuilt], ['Emails', a.emailsSent], ['Matches', a.matchesRun]].map(([k, v]) => `<span><strong>${v}</strong> ${k}</span>`).join('');
      } catch (e) { if (e.name !== 'AbortError') el.querySelector('#meta').innerHTML = `<span class="panel-error">${esc(e.message)}</span>`; }
    }
    el.querySelector('#rp').addEventListener('change', load);
    await load();
    return () => { if (ctrl) ctrl.abort(); };
  },
};
