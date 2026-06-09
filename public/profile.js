'use strict';

(function () {
  const STRING_FIELDS = [
    'identity', 'serviceArea', 'languages', 'hours', 'facilityNetwork',
    'responsiveness', 'credibility', 'integration', 'feeModel',
  ];
  const ARRAY_FIELDS = ['levelsOfCare', 'payors', 'complexCases', 'processServices'];

  const statusEl = document.getElementById('profile-status');
  const saveBtn = document.getElementById('save-profile');

  function renderChecks(field, options, selected) {
    const container = document.getElementById('grp-' + field);
    if (!container) return;
    container.innerHTML = '';
    const set = new Set(selected || []);
    for (const opt of options) {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = opt;
      if (set.has(opt)) input.checked = true;
      const span = document.createElement('span');
      span.textContent = opt;
      label.appendChild(input);
      label.appendChild(span);
      container.appendChild(label);
    }
  }

  function gatherChecks(field) {
    return [...document.querySelectorAll(`#grp-${field} input:checked`)].map((i) => i.value);
  }

  async function load() {
    let data;
    try {
      const resp = await fetch('/api/profile');
      if (!resp.ok) return; // not authed; dashboard.js handles redirect
      data = await resp.json();
    } catch {
      return;
    }
    const profile = data.profile || {};
    const options = data.options || {};

    for (const f of STRING_FIELDS) {
      const el = document.getElementById('p-' + f);
      if (el) el.value = profile[f] || '';
    }
    for (const f of ARRAY_FIELDS) {
      renderChecks(f, options[f] || [], profile[f] || []);
    }
  }

  async function save() {
    const payload = {};
    for (const f of STRING_FIELDS) {
      const el = document.getElementById('p-' + f);
      payload[f] = el ? el.value.trim() : '';
    }
    for (const f of ARRAY_FIELDS) {
      payload[f] = gatherChecks(f);
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.style.color = '';
    try {
      const resp = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        statusEl.textContent = data.error || 'Could not save profile.';
        statusEl.style.color = '#b42318';
      } else {
        statusEl.textContent = 'Profile saved. Your tailored cases will use it.';
      }
    } catch {
      statusEl.textContent = 'Network error — try again.';
      statusEl.style.color = '#b42318';
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);
  load();
})();
