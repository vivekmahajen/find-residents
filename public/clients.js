'use strict';

(function () {
  const btn = document.getElementById('render-client');
  const statusEl = document.getElementById('client-status');
  const resultEl = document.getElementById('client-result');
  if (!btn) return;

  const FIELDS = [
    'reference', 'name', 'gender', 'dob', 'phone', 'email', 'mailingArea',
    'contactName', 'contactRelationship', 'contactPhone', 'location',
    'carePreferenceType', 'careFeatures', 'roomType', 'language',
    'budgetAmount', 'payor', 'shareOfCost', 'needs', 'timeline', 'notes', 'raw',
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function gather() {
    const record = {};
    for (const f of FIELDS) {
      const el = document.getElementById('cl-' + f);
      if (el) record[f] = el.value;
    }
    return record;
  }

  function line(label, value) {
    return `<div class="cl-line"><span class="cl-key">${esc(label)}</span><span class="cl-val">${esc(value)}</span></div>`;
  }

  function render(data) {
    const p = data.profile;
    const roleLabel = { full: 'Full', matching_only: 'Matching only', partner_facility: 'Partner facility' }[data.viewerRole] || data.viewerRole;

    const banner = data.matchingReady
      ? `<div class="cl-banner ok">✅ Matching-ready export — no sensitive identifiers present.</div>`
      : '';

    const body = [
      line('Reference', p.reference),
      line('Name', p.name),
      line('Gender', p.gender),
      line('Age', p.age),
      line('Contact', `${p.contact.phone} · ${p.contact.email} · ${p.contact.mailingArea}`),
      line('Decision-maker', `${p.primaryContact.name} (${p.primaryContact.relationship}) · ${p.primaryContact.contact}`),
      line('Location', p.location),
      line('Care preference', `${p.carePreference.type} · ${p.carePreference.features}`),
      line('Room type', p.roomType),
      line('Budget', `${p.budget.amount} · ${p.budget.payor}${p.budget.shareOfCost && p.budget.shareOfCost !== '[not provided]' ? ' · share of cost ' + p.budget.shareOfCost : ''}`),
      line('Care needs', p.needs),
      line('Language', p.language),
      line('Timeline', p.timeline),
      line('Notes', p.notes),
    ].join('');

    const withheld = data.withheld && data.withheld.length
      ? `<div class="cl-withheld"><strong>Withheld for privacy:</strong> ${data.withheld.map(esc).join('; ')}.</div>`
      : `<div class="cl-withheld"><strong>Withheld for privacy:</strong> none detected.</div>`;

    resultEl.innerHTML = `
      <div class="cl-head">
        <h3>Privacy-safe profile <span class="muted">· ${esc(roleLabel)} view</span></h3>
        <button type="button" class="copy-btn" id="cl-copy">📋 Copy</button>
      </div>
      ${banner}
      <div class="cl-card">${body}</div>
      ${withheld}
    `;
    resultEl.hidden = false;

    document.getElementById('cl-copy').addEventListener('click', () => copyProfile(data));
  }

  function toText(data) {
    const p = data.profile;
    const rows = [
      ['Reference', p.reference], ['Name', p.name], ['Gender', p.gender], ['Age', p.age],
      ['Phone', p.contact.phone], ['Email', p.contact.email], ['Mailing area', p.contact.mailingArea],
      ['Decision-maker', `${p.primaryContact.name} (${p.primaryContact.relationship}) — ${p.primaryContact.contact}`],
      ['Location', p.location], ['Care preference', p.carePreference.type], ['Features', p.carePreference.features],
      ['Room type', p.roomType], ['Budget', p.budget.amount], ['Payor', p.budget.payor], ['Share of cost', p.budget.shareOfCost],
      ['Care needs', p.needs], ['Language', p.language], ['Timeline', p.timeline], ['Notes', p.notes],
    ];
    return rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\nWithheld for privacy: ${(data.withheld || []).join('; ') || 'none detected'}.`;
  }

  async function copyProfile(data) {
    const text = toText(data);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const b = document.getElementById('cl-copy');
      b.textContent = '✓ Copied';
      setTimeout(() => { b.textContent = '📋 Copy'; }, 1800);
    } catch { /* ignore */ }
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    statusEl.textContent = 'Rendering…';
    try {
      const resp = await fetch('/api/client-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record: gather(),
          viewerRole: document.getElementById('cl-viewerRole').value,
          outputMode: document.getElementById('cl-outputMode').value,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        statusEl.textContent = data.error || 'Could not render.';
        return;
      }
      statusEl.textContent = '';
      render(data);
    } catch {
      statusEl.textContent = 'Network error — try again.';
    } finally {
      btn.disabled = false;
    }
  });
})();
