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
      <p class="approach">
        Approach via <strong>Case Management / Discharge Planning</strong> —
        verify the current contact on the hospital's official site before outreach.
      </p>
    `;
    resultsEl.appendChild(card);
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
