'use strict';

// Header (auth/logout) + the optional, free "data coverage" county picker.
// Billing lives in pricing.js; coverage here is just a data-scope preference.

const whoEl = document.getElementById('who');
const logoutBtn = document.getElementById('logout-btn');
const subStateSel = document.getElementById('sub-state');
const countiesEl = document.getElementById('counties');
const countyCountEl = document.getElementById('county-count');
const saveBtn = document.getElementById('save-plan');
const planStatusEl = document.getElementById('plan-status');

let MAX_COUNTIES = 3;

function selectedCounties() {
  return [...countiesEl.querySelectorAll('input:checked')].map((c) => c.value);
}

function updateLimits() {
  const n = countiesEl.querySelectorAll('input:checked').length;
  const atMax = n >= MAX_COUNTIES;
  countiesEl.querySelectorAll('input').forEach((box) => {
    box.disabled = atMax && !box.checked;
  });
  countyCountEl.textContent = n ? `(${n} of ${MAX_COUNTIES} selected)` : '';
  saveBtn.disabled = n === 0;
}

function renderCounties(counties, preselected) {
  const set = new Set(preselected || []);
  countiesEl.innerHTML = '';
  for (const name of counties) {
    const label = document.createElement('label');
    label.className = 'county';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = name;
    if (set.has(name)) input.checked = true;
    input.addEventListener('change', updateLimits);
    const span = document.createElement('span');
    span.textContent = name;
    label.appendChild(input);
    label.appendChild(span);
    countiesEl.appendChild(label);
  }
}

async function init() {
  const meResp = await fetch('/api/auth/me');
  if (!meResp.ok) {
    window.location.href = '/';
    return;
  }
  whoEl.textContent = (await meResp.json()).user.username;

  const plans = await (await fetch('/api/plans')).json();
  MAX_COUNTIES = plans.maxCounties || 3;
  subStateSel.innerHTML = plans.states.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  const stateDef = plans.states[0];

  const sub = (await (await fetch('/api/subscription')).json()).subscription;
  renderCounties(stateDef.counties, sub ? sub.counties : []);
  updateLimits();
  if (sub && sub.counties && sub.counties.length) {
    planStatusEl.textContent = `Coverage: ${sub.counties.join(', ')}.`;
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
  } else {
    planStatusEl.textContent = `Coverage saved: ${data.subscription.counties.join(', ')}.`;
  }
  saveBtn.disabled = false;
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

init();
