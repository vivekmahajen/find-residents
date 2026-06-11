// Profile widget — read-only account info + editable agency profile.
// Reuses /api/auth/me and /api/profile. Never shows sensitive identifiers.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const STRING_FIELDS = ['identity', 'serviceArea', 'languages', 'hours', 'facilityNetwork', 'responsiveness', 'credibility', 'integration', 'feeModel'];
const ARRAY_FIELDS = ['levelsOfCare', 'payors', 'complexCases', 'processServices'];

export default {
  title: 'Profile',
  requiresAuth: true,
  async mount(el, ctx) {
    el.innerHTML = '<div class="panel"><h1>Profile</h1><p class="muted" id="pstatus">Loading…</p><div id="pbody"></div></div>';
    const ctrl = new AbortController();
    try {
      const [meR, profR] = await Promise.all([
        fetch('/api/auth/me', { signal: ctrl.signal }),
        fetch('/api/profile', { signal: ctrl.signal }),
      ]);
      if (!meR.ok) throw new Error('Not signed in.');
      const me = (await meR.json()).user;
      const pj = profR.ok ? await profR.json() : { profile: {}, options: {} };
      const profile = pj.profile || {};
      const options = pj.options || {};

      const checks = (field) => `<fieldset><legend>${esc(field.replace(/([A-Z])/g, ' $1'))}</legend><div class="checks">${(options[field] || []).map((opt) => {
        const on = (profile[field] || []).includes(opt);
        return `<label class="check"><input type="checkbox" data-arr="${field}" value="${esc(opt)}" ${on ? 'checked' : ''}/><span>${esc(opt)}</span></label>`;
      }).join('')}</div></fieldset>`;

      el.querySelector('#pstatus').textContent = '';
      el.querySelector('#pbody').innerHTML = `
        <div class="profile-account">
          <p><strong>User ID:</strong> ${esc(me.username)} &nbsp; <strong>Email:</strong> ${esc(me.email)}</p>
          <p class="muted">Sensitive identifiers are never shown; agency profile feeds the AI case generator (truth-only).</p>
        </div>
        <form id="pf" autocomplete="off">
          ${STRING_FIELDS.map((f) => `<label class="pf-label">${esc(f.replace(/([A-Z])/g, ' $1'))}<input id="pf-${f}" type="text" value="${esc(profile[f] || '')}" /></label>`).join('')}
          ${ARRAY_FIELDS.map(checks).join('')}
          <div class="plan-footer"><span id="psave-status" class="plan-status"></span><button class="primary-btn" id="psave" type="button">Save profile</button></div>
        </form>`;

      const saveBtn = el.querySelector('#psave');
      const ss = el.querySelector('#psave-status');
      async function save() {
        const payload = {};
        STRING_FIELDS.forEach((f) => { payload[f] = (el.querySelector('#pf-' + f) || {}).value || ''; });
        ARRAY_FIELDS.forEach((f) => { payload[f] = [...el.querySelectorAll(`input[data-arr="${f}"]:checked`)].map((i) => i.value); });
        saveBtn.disabled = true; ss.textContent = 'Saving…';
        try {
          const r = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          ss.textContent = r.ok ? 'Saved.' : 'Could not save.';
        } catch { ss.textContent = 'Network error.'; } finally { saveBtn.disabled = false; }
      }
      saveBtn.addEventListener('click', save);
    } catch (e) {
      if (e.name !== 'AbortError') el.querySelector('#pstatus').innerHTML = `<span class="panel-error">${esc(e.message)}</span>`;
    }
    return () => ctrl.abort();
  },
};
