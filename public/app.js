'use strict';

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

const ROLES = [
  'Case Manager',
  'Discharge Planner',
  'Medical Social Worker',
  'Director of Case Management / Care Coordination',
];

const form = document.getElementById('search-form');
const locationInput = document.getElementById('location');
const stateSelect = document.getElementById('state');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

// Populate the state dropdown, default California.
for (const st of US_STATES) {
  const opt = document.createElement('option');
  opt.value = st;
  opt.textContent = st;
  if (st === 'CA') opt.selected = true;
  stateSelect.appendChild(opt);
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw || '';
}

function setStatus(html, isError) {
  statusEl.innerHTML = html;
  statusEl.classList.toggle('error', !!isError);
}

function renderHospitals(data) {
  resultsEl.innerHTML = '';
  if (!data.hospitals.length) {
    setStatus(
      `No hospitals found for "${escapeHtml(data.query.location)}". Try a nearby larger city or a different ZIP.`
    );
    return;
  }

  const where = data.query.mode === 'zip'
    ? `ZIP ${escapeHtml(data.query.location)}`
    : `${escapeHtml(data.query.location)}, ${escapeHtml(data.query.state)}`;
  setStatus(`Found <strong>${data.count}</strong> hospital${data.count === 1 ? '' : 's'} in ${where}.`);

  for (const h of data.hospitals) {
    const card = document.createElement('article');
    card.className = 'hospital';
    const phone = formatPhone(h.phone);
    const phoneDigits = String(h.phone || '').replace(/\D/g, '');

    card.innerHTML = `
      <div class="hospital-top">
        <h3>${escapeHtml(h.name)}</h3>
        ${h.type ? `<span class="badge">${escapeHtml(h.type)}</span>` : ''}
      </div>
      <p class="addr">${escapeHtml(h.fullAddress)}</p>
      <div class="hospital-meta">
        ${phone ? `<a href="tel:${phoneDigits}">📞 ${escapeHtml(phone)}</a>` : ''}
        <a href="${h.mapsUrl}" target="_blank" rel="noopener">🗺️ Map</a>
        <span class="npi">NPI ${escapeHtml(h.npi)}</span>
      </div>
      <div class="strategy-bar">
        <label class="sr-only" for="role-${h.npi}">Role to approach</label>
        <select id="role-${h.npi}" class="role-select">
          ${ROLES.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
        </select>
        <button type="button" class="strategy-btn">Pain points &amp; approach →</button>
      </div>
      <div class="strategy-panel" hidden></div>
    `;

    const btn = card.querySelector('.strategy-btn');
    const select = card.querySelector('.role-select');
    const panel = card.querySelector('.strategy-panel');
    btn.addEventListener('click', () => runStrategy(h, select.value, btn, panel));

    resultsEl.appendChild(card);
  }
}

async function runStrategy(hospital, role, btn, panel) {
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  panel.hidden = false;
  panel.innerHTML = `<p class="muted"><span class="spinner"></span> Agent 1 is identifying pain points, then Agent 2 builds the approach…</p>`;

  try {
    const resp = await fetch('/api/strategy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hospital, role }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      panel.innerHTML = `<p class="panel-error">${escapeHtml(data.error || 'Something went wrong.')}</p>`;
      return;
    }
    renderStrategy(panel, role, data);
  } catch (err) {
    panel.innerHTML = `<p class="panel-error">Network error — is the server running? Try again.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-run analysis ↻';
  }
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function renderStrategy(panel, role, data) {
  const painPoints = (data.painPoints || [])
    .slice()
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const s = data.strategy || {};

  const painHtml = painPoints
    .map(
      (p) => `
      <li class="pain">
        <span class="sev sev-${escapeHtml(p.severity)}">${escapeHtml(p.severity)}</span>
        <strong>${escapeHtml(p.title)}</strong>
        <p>${escapeHtml(p.description)}</p>
      </li>`
    )
    .join('');

  const valueHtml = (s.valueProps || [])
    .map(
      (v) => `
      <li><strong>${escapeHtml(v.painPoint)}</strong><br><span>${escapeHtml(v.howWeHelp)}</span></li>`
    )
    .join('');

  const talkingHtml = (s.talkingPoints || [])
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('');

  const complianceHtml = (s.complianceNotes || [])
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join('');

  const email = s.emailDraft || {};

  panel.innerHTML = `
    <div class="agent-block">
      <h4><span class="agent-tag">Agent 1</span> Pain points · ${escapeHtml(role)}</h4>
      <ul class="pain-list">${painHtml || '<li>No pain points returned.</li>'}</ul>
    </div>
    <div class="agent-block">
      <h4><span class="agent-tag agent-tag-2">Agent 2</span> Recommended approach</h4>
      ${s.summary ? `<p class="strat-summary">${escapeHtml(s.summary)}</p>` : ''}
      ${valueHtml ? `<h5>How we help</h5><ul class="value-list">${valueHtml}</ul>` : ''}
      ${talkingHtml ? `<h5>Talking points</h5><ul class="bullet">${talkingHtml}</ul>` : ''}
      ${s.suggestedFirstStep ? `<h5>Best first step</h5><p>${escapeHtml(s.suggestedFirstStep)}</p>` : ''}
      ${
        email.subject || email.body
          ? `<h5>Draft email</h5>
             <div class="email">
               <p class="email-subject"><strong>Subject:</strong> ${escapeHtml(email.subject || '')}</p>
               <pre class="email-body">${escapeHtml(email.body || '')}</pre>
             </div>`
          : ''
      }
      ${complianceHtml ? `<h5>Compliance reminders</h5><ul class="bullet compliance">${complianceHtml}</ul>` : ''}
    </div>
  `;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const location = locationInput.value.trim();
  const state = stateSelect.value;
  if (!location) {
    setStatus('Enter a city or 5-digit ZIP code.', true);
    return;
  }

  resultsEl.innerHTML = '';
  searchBtn.disabled = true;
  setStatus('<span class="spinner"></span> Searching the NPI Registry…');

  try {
    const params = new URLSearchParams({ location, state });
    const resp = await fetch(`/api/hospitals?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(escapeHtml(data.error || 'Something went wrong.'), true);
      return;
    }
    renderHospitals(data);
  } catch (err) {
    setStatus('Network error — is the server running? Try again.', true);
  } finally {
    searchBtn.disabled = false;
  }
});
