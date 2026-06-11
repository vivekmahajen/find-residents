'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  if (!$('reports-panel')) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US'); }

  async function loadReport() {
    const days = $('rp-period').value;
    let d;
    try { const r = await fetch('/api/reports?days=' + days); if (!r.ok) return; d = await r.json(); } catch { return; }

    const f = d.funnel;
    const co = d.conversions;
    const steps = [
      ['Sources contacted', f.sourcesContacted, null],
      ['Leads received', f.leadsReceived, co.contactToLead],
      ['Tours', f.tours, co.leadToTour],
      ['Applications', f.applications, co.tourToApplication],
      ['Placements', f.placements, co.applicationToPlacement],
    ];
    $('funnel').innerHTML = steps.map(([label, n, conv], i) => `
      ${i > 0 ? `<div class="funnel-arrow">${conv}%</div>` : ''}
      <div class="funnel-step"><div class="fn-num">${n}</div><div class="fn-label">${esc(label)}</div></div>`).join('');

    $('report-meta').innerHTML =
      `<span><strong>${co.leadToPlacement}%</strong> lead→placement</span>` +
      `<span><strong>${d.timeToPlacementDays != null ? d.timeToPlacementDays + ' days' : '—'}</strong> avg time-to-placement</span>` +
      `<span><strong>${money(d.revenue.total)}</strong> revenue · ${money(d.revenue.perPlacement)}/placement</span>`;

    $('leaderboard').innerHTML = d.sourceLeaderboard.length
      ? `<table class="rep-table"><tr><th>Source</th><th>Placements</th><th>Revenue</th></tr>${d.sourceLeaderboard.map((s) => `<tr><td>${esc(s.source)}</td><td>${s.placements}</td><td>${money(s.revenue)}</td></tr>`).join('')}</table>`
      : '<p class="muted">No placements attributed yet.</p>';

    const a = d.activity;
    $('activity-stats').innerHTML = [
      ['Searches', a.searches], ['Cases', a.casesGenerated], ['Decks', a.decksBuilt],
      ['Emails sent', a.emailsSent], ['Enrollments', a.sequencesEnrolled], ['Matches', a.matchesRun],
    ].map(([k, v]) => `<span><strong>${v}</strong> ${k}</span>`).join('');
  }

  async function loadAdmin() {
    let d;
    try { const r = await fetch('/api/admin/usage'); if (!r.ok) return; d = await r.json(); } catch { return; }
    $('admin-panel').hidden = false;
    $('admin-summary').innerHTML = `<span><strong>${d.weeklyActiveAgencies}</strong> / ${d.totalAgencies} agencies active this week</span>`;
    $('admin-list').innerHTML = d.agencies.map((a) => `
      <div class="lead-row"><div class="lead-main"><strong>${esc(a.username)}</strong>
      <span class="muted">${esc(a.email)} · ${a.eventsLast7} events/7d · last active ${a.lastActive ? new Date(a.lastActive).toLocaleDateString() : 'never'}</span>
      <span class="muted">features: ${esc(a.features.join(', ') || 'none')}</span></div></div>`).join('');
  }

  $('rp-period').addEventListener('change', loadReport);
  loadReport();
  loadAdmin();
})();
