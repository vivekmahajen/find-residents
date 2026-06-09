'use strict';

const whoEl = document.getElementById('who');
const logoutBtn = document.getElementById('logout-btn');
const subStateSel = document.getElementById('sub-state');
const tiersEl = document.getElementById('tiers');
const countiesEl = document.getElementById('counties');
const countyCountEl = document.getElementById('county-count');
const priceEl = document.getElementById('price');
const saveBtn = document.getElementById('save-plan');
const planStatusEl = document.getElementById('plan-status');
const finderEl = document.getElementById('finder');
const finderLockedEl = document.getElementById('finder-locked');

let MAX_COUNTIES = 3;
let TIERS = [];
let priceByCount = {};

function selectedCounties() {
  return [...countiesEl.querySelectorAll('input:checked')].map((c) => c.value);
}

function updatePriceAndLimits() {
  const checked = countiesEl.querySelectorAll('input:checked');
  const n = checked.length;

  // Enforce the max: disable unchecked boxes once the cap is reached.
  const atMax = n >= MAX_COUNTIES;
  countiesEl.querySelectorAll('input').forEach((box) => {
    box.disabled = atMax && !box.checked;
  });

  countyCountEl.textContent = n ? `(${n} of ${MAX_COUNTIES} selected)` : '';
  if (n === 0) {
    priceEl.textContent = `Select 1–${MAX_COUNTIES} counties`;
    saveBtn.disabled = true;
  } else {
    const price = priceByCount[n];
    priceEl.innerHTML = `<strong>$${price}</strong> / month <span class="muted">(${n} count${n === 1 ? 'y' : 'ies'})</span>`;
    saveBtn.disabled = false;
  }
}

function renderCounties(counties, preselected) {
  const set = new Set(preselected || []);
  countiesEl.innerHTML = '';
  for (const name of counties) {
    const id = `c-${name.replace(/\s+/g, '-')}`;
    const label = document.createElement('label');
    label.className = 'county';
    label.innerHTML = `<input type="checkbox" id="${id}" value="${name}" ${set.has(name) ? 'checked' : ''}/> <span>${name}</span>`;
    label.querySelector('input').addEventListener('change', updatePriceAndLimits);
    countiesEl.appendChild(label);
  }
}

function renderTiers() {
  tiersEl.innerHTML = TIERS.map(
    (t) => `<div class="tier"><span class="tier-n">${t.counties} count${t.counties === 1 ? 'y' : 'ies'}</span><span class="tier-p">$${t.priceMonthly}/mo</span></div>`
  ).join('');
}

function setFinderUnlocked(unlocked) {
  finderEl.hidden = !unlocked;
  finderLockedEl.hidden = unlocked;
}

async function init() {
  // Require auth.
  const meResp = await fetch('/api/auth/me');
  if (!meResp.ok) {
    window.location.href = '/';
    return;
  }
  const { user } = await meResp.json();
  whoEl.textContent = user.username;

  // Plans.
  const plans = await (await fetch('/api/plans')).json();
  MAX_COUNTIES = plans.maxCounties || 3;
  TIERS = plans.tiers || [];
  priceByCount = Object.fromEntries(TIERS.map((t) => [t.counties, t.priceMonthly]));
  renderTiers();

  // State dropdown (CA only for now).
  subStateSel.innerHTML = plans.states
    .map((s) => `<option value="${s.code}">${s.name}</option>`)
    .join('');
  const stateDef = plans.states[0];

  // Current subscription (if any).
  const sub = (await (await fetch('/api/subscription')).json()).subscription;
  renderCounties(stateDef.counties, sub ? sub.counties : []);
  updatePriceAndLimits();
  setFinderUnlocked(!!(sub && sub.counties && sub.counties.length));
  if (sub) {
    planStatusEl.textContent = `Current plan: ${sub.counties.length} county/ies — $${sub.priceMonthly}/month.`;
  }
}

saveBtn.addEventListener('click', async () => {
  const counties = selectedCounties();
  saveBtn.disabled = true;
  planStatusEl.textContent = 'Saving…';
  const resp = await fetch('/api/subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: subStateSel.value, counties }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    planStatusEl.textContent = data.error || 'Could not save.';
    saveBtn.disabled = false;
    return;
  }
  const sub = data.subscription;
  planStatusEl.textContent = `Saved! ${sub.counties.length} county/ies — $${sub.priceMonthly}/month.`;
  setFinderUnlocked(true);
  saveBtn.disabled = false;
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

init();
