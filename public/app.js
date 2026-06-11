'use strict';

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

const form = document.getElementById('search-form');
const locationInput = document.getElementById('location');
const stateSelect = document.getElementById('state');
const typeSelect = document.getElementById('facility-type');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

// Facility types (with their staff roles) fetched from the server.
let FACILITY_TYPES = [];
const DEFAULT_ROLES = ['Case Manager', 'Discharge Planner', 'Medical Social Worker'];

// Populate the state dropdown, default California.
for (const st of US_STATES) {
  const opt = document.createElement('option');
  opt.value = st;
  opt.textContent = st;
  if (st === 'CA') opt.selected = true;
  stateSelect.appendChild(opt);
}

// Load facility types → populate the source-type dropdown.
(async function loadFacilityTypes() {
  try {
    const resp = await fetch('/api/facility-types');
    const data = await resp.json();
    FACILITY_TYPES = data.types || [];
    for (const t of FACILITY_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      if (t.id === data.default) opt.selected = true;
      typeSelect.appendChild(opt);
    }
  } catch {
    // Fallback so the page still works if the call fails.
    const opt = document.createElement('option');
    opt.value = 'hospital';
    opt.textContent = 'Hospitals';
    typeSelect.appendChild(opt);
  }
})();

function rolesForType(typeId) {
  const t = FACILITY_TYPES.find((x) => x.id === typeId);
  return (t && t.roles) || DEFAULT_ROLES;
}

function labelForType(typeId) {
  const t = FACILITY_TYPES.find((x) => x.id === typeId);
  return (t && t.label) || 'facilities';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US');
}

// In-plan credit cost for an action (from the loaded pricing model).
function actionCredits(key) {
  const m = window.PRICING;
  if (m && m.actions) {
    const a = m.actions.find((x) => x.key === key);
    if (a) return a.inPlanCredits;
  }
  return key === 'deck' ? 30 : 10;
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

function renderFacilities(data) {
  resultsEl.innerHTML = '';
  const typeId = data.query.type;
  const noun = labelForType(typeId).toLowerCase();
  const facilities = data.facilities || [];

  if (!facilities.length) {
    setStatus(
      `No ${noun} found for "${escapeHtml(data.query.location)}". Try a nearby larger city or a different ZIP.`
    );
    return;
  }

  const where = data.query.mode === 'zip'
    ? `ZIP ${escapeHtml(data.query.location)}`
    : `${escapeHtml(data.query.location)}, ${escapeHtml(data.query.state)}`;
  setStatus(
    `Found <strong>${data.count}</strong> ${escapeHtml(data.query.typeLabel || 'result')}${data.count === 1 ? '' : 's'} in ${where}.`
  );

  const roles = rolesForType(typeId);

  for (const f of facilities) {
    const card = document.createElement('article');
    card.className = 'hospital';
    const phone = formatPhone(f.phone);
    const phoneDigits = String(f.phone || '').replace(/\D/g, '');

    card.innerHTML = `
      <div class="hospital-top">
        <h3>${escapeHtml(f.name)}</h3>
        ${f.type ? `<span class="badge">${escapeHtml(f.type)}</span>` : ''}
      </div>
      <p class="addr">${escapeHtml(f.fullAddress)}</p>
      <div class="hospital-meta">
        ${phone ? `<a href="tel:${phoneDigits}">📞 ${escapeHtml(phone)}</a>` : ''}
        <a href="${f.mapsUrl}" target="_blank" rel="noopener">🗺️ Map</a>
        <span class="npi">NPI ${escapeHtml(f.npi)}</span>
        <button type="button" class="link-btn add-contact-btn">+ Add CRM contact</button>
      </div>
      <div class="strategy-bar">
        <label class="sr-only" for="role-${f.npi}">Role to approach</label>
        <select id="role-${f.npi}" class="role-select">
          ${roles.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
        </select>
        <button type="button" class="strategy-btn">Pain points &amp; approach · ${actionCredits('document')} cr →</button>
      </div>
      <div class="strategy-panel" hidden></div>
    `;

    const btn = card.querySelector('.strategy-btn');
    const select = card.querySelector('.role-select');
    const panel = card.querySelector('.strategy-panel');
    btn.addEventListener('click', () => runStrategy(f, select.value, typeId, btn, panel));

    // Prefill the CRM contact form's source ref (the NPI) from this result.
    const addContactBtn = card.querySelector('.add-contact-btn');
    if (addContactBtn) {
      addContactBtn.addEventListener('click', () => {
        const srcInput = document.getElementById('cn-source');
        const nameInput = document.getElementById('cn-name');
        if (srcInput) srcInput.value = f.npi || f.name;
        const panelEl = document.getElementById('crm-panel');
        if (panelEl) panelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (nameInput) setTimeout(() => nameInput.focus(), 400);
      });
    }

    resultsEl.appendChild(card);
  }
}

async function runStrategy(facility, role, facilityType, btn, panel) {
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  panel.hidden = false;
  panel.innerHTML = `<p class="muted"><span class="spinner"></span> Agent 1 is identifying pain points, then Agent 2 builds the approach…</p>`;

  try {
    const resp = await fetch('/api/strategy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hospital: facility, role, facilityType }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      panel.innerHTML = `<p class="panel-error">${escapeHtml(data.error || 'Something went wrong.')}</p>`;
      if (data.account && window.setAccount) window.setAccount(data.account);
      return;
    }
    if (data.account && window.setAccount) window.setAccount(data.account);
    renderStrategy(panel, role, data, facility, facilityType);
  } catch (err) {
    panel.innerHTML = `<p class="panel-error">Network error — is the server running? Try again.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-run analysis ↻';
  }
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function renderStrategy(panel, role, data, facility, facilityType) {
  const painPoints = (data.painPoints || [])
    .slice()
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const s = data.strategy || {};
  const sv = s.savingsComputed;

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

  const matchHtml = (s.matches || [])
    .map(
      (m) => `
      <li class="match">
        <span class="strength strength-${escapeHtml((m.strength || '').toLowerCase())}">${escapeHtml(m.strength || '')}</span>
        <strong>${escapeHtml(m.painPoint)}</strong>
        <p>${escapeHtml(m.howWeHelp)}</p>
        ${m.proof ? `<p class="proof"><em>Proof:</em> ${escapeHtml(m.proof)}</p>` : ''}
      </li>`
    )
    .join('');

  const talkingHtml = (s.talkingPoints || [])
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('');

  const objectionHtml = (s.objections || [])
    .map(
      (o) => `
      <li><strong>“${escapeHtml(o.objection)}”</strong><br><span>${escapeHtml(o.response)}</span></li>`
    )
    .join('');

  const complianceHtml = (s.complianceNotes || [])
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join('');

  const email = s.emailDraft || {};
  const profileBadge = data.usedProfile
    ? '<span class="profile-badge ok">using your profile</span>'
    : '<span class="profile-badge warn">generic — build your profile</span>';

  panel.innerHTML = `
    <div class="agent-block">
      <h4><span class="agent-tag">Agent 1</span> Pain points · ${escapeHtml(role)}</h4>
      <ul class="pain-list">${painHtml || '<li>No pain points returned.</li>'}</ul>
    </div>
    <div class="agent-block">
      <h4><span class="agent-tag agent-tag-2">Agent 2</span> Tailored case ${profileBadge}</h4>
      ${s.headline ? `<p class="headline">${escapeHtml(s.headline)}</p>` : ''}
      ${s.summary ? `<p class="strat-summary">${escapeHtml(s.summary)}</p>` : ''}
      ${matchHtml ? `<h5>Capability match</h5><ul class="match-list">${matchHtml}</ul>` : ''}
      ${
        s.biggestStrength || s.biggestGap
          ? `<div class="coverage">
               ${s.biggestStrength ? `<p>✅ <strong>Biggest strength:</strong> ${escapeHtml(s.biggestStrength)}</p>` : ''}
               ${s.biggestGap ? `<p>⚠️ <strong>Biggest gap:</strong> ${escapeHtml(s.biggestGap)}</p>` : ''}
             </div>`
          : ''
      }
      ${talkingHtml ? `<h5>Talking points</h5><ul class="bullet">${talkingHtml}</ul>` : ''}
      ${objectionHtml ? `<h5>Objection handling</h5><ul class="value-list">${objectionHtml}</ul>` : ''}
      ${s.suggestedFirstStep ? `<h5>Best first step</h5><p>${escapeHtml(s.suggestedFirstStep)}</p>` : ''}
      ${
        sv
          ? `<h5>Estimated impact (illustrative)</h5>
             <div class="savings">
               <div class="savings-figure">${fmtMoney(sv.estimatedMonthly)} / month <span class="muted">· ≈ ${fmtMoney(sv.estimatedAnnual)} / year</span></div>
               <p class="savings-basis">${escapeHtml(sv.driver || 'avoidable bed-days')} — ${sv.avoidedDaysPerCase} day(s)/case × ${sv.casesPerMonth} case(s)/mo × ${fmtMoney(sv.costPerDay)}/inpatient day</p>
               <p class="savings-disclaimer">${escapeHtml(sv.disclaimer || 'Illustrative industry estimate to validate against your own data — not a guaranteed result.')}</p>
             </div>`
          : ''
      }
      ${
        email.subject || email.body
          ? `<div class="email-head">
               <h5>Draft email</h5>
               <button type="button" class="copy-btn">📋 Copy email</button>
             </div>
             <div class="email">
               <p class="email-subject"><strong>Subject:</strong> ${escapeHtml(email.subject || '')}</p>
               <pre class="email-body">${escapeHtml(email.body || '')}</pre>
             </div>`
          : ''
      }
      ${complianceHtml ? `<h5>Compliance reminders</h5><ul class="bullet compliance">${complianceHtml}</ul>` : ''}
      <div class="deck-bar">
        <button type="button" class="deck-btn">📊 Build PowerPoint · ${actionCredits('deck')} cr</button>
        <span class="deck-status"></span>
      </div>
    </div>
  `;

  const copyBtn = panel.querySelector('.copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => copyEmail(copyBtn, email));
  }

  const deckBtn = panel.querySelector('.deck-btn');
  const deckStatus = panel.querySelector('.deck-status');
  if (deckBtn) {
    deckBtn.addEventListener('click', () =>
      buildDeck(deckBtn, deckStatus, {
        hospital: facility,
        role,
        facilityType,
        painPoints: data.painPoints,
        strategy: data.strategy,
      })
    );
  }
}

async function buildDeck(btn, statusEl, payload) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Building…';
  if (statusEl) statusEl.textContent = '';
  try {
    const resp = await fetch('/api/deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = d.error || 'Could not build the deck.';
      if (d.account && window.setAccount) window.setAccount(d.account);
      return;
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = m ? m[1] : 'proposal.pptx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (statusEl) statusEl.textContent = 'Downloaded ✓';
    if (window.refreshAccount) window.refreshAccount(); // deck consumed credits
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Network error building the deck.';
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function copyEmail(btn, email) {
  const text = `Subject: ${email.subject || ''}\n\n${email.body || ''}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for non-secure contexts / older browsers.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy email'; }, 1800);
  } catch {
    btn.textContent = 'Copy failed';
    setTimeout(() => { btn.textContent = '📋 Copy email'; }, 1800);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const location = locationInput.value.trim();
  const state = stateSelect.value;
  if (!location) {
    setStatus('Enter a city or 5-digit ZIP code.', true);
    return;
  }

  const type = typeSelect.value || 'hospital';
  resultsEl.innerHTML = '';
  searchBtn.disabled = true;
  setStatus('<span class="spinner"></span> Searching the NPI Registry…');

  try {
    const params = new URLSearchParams({ location, state, type });
    const resp = await fetch(`/api/hospitals?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(escapeHtml(data.error || 'Something went wrong.'), true);
      return;
    }
    renderFacilities(data);
  } catch (err) {
    setStatus('Network error — is the server running? Try again.', true);
  } finally {
    searchBtn.disabled = false;
  }
});
