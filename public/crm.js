'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  if (!$('crm-panel')) return;
  const status = $('crm-status');
  let sequences = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  }

  // --- Tasks ---
  async function loadTasks() {
    const { data } = await api('GET', '/api/tasks');
    const b = data.buckets || { overdue: [], today: [], upcoming: [] };
    const open = [...b.overdue.map((t) => ['overdue', t]), ...b.today.map((t) => ['today', t]), ...b.upcoming.map((t) => ['upcoming', t])];
    const el = $('tasks-list');
    if (!open.length) { el.innerHTML = '<p class="muted">No open tasks.</p>'; return; }
    el.innerHTML = '';
    for (const [bucket, t] of open) {
      const row = document.createElement('div');
      row.className = 'lead-row';
      const due = t.data.dueAt ? new Date(t.data.dueAt).toLocaleDateString() : 'no date';
      row.innerHTML = `<div class="lead-main"><strong>${esc(t.data.title)}</strong><span class="muted">${esc(bucket)} · due ${esc(due)}${t.data.linkedRef ? ' · ' + esc(t.data.linkedType) + ' ' + esc(t.data.linkedRef) : ''}</span></div>
        <div class="lead-actions"><button type="button" class="link-btn t-done">Complete</button><button type="button" class="link-btn t-del">Delete</button></div>`;
      row.querySelector('.t-done').addEventListener('click', async () => { await api('POST', '/api/tasks/' + t.id, { status: 'done' }); loadTasks(); });
      row.querySelector('.t-del').addEventListener('click', async () => { await api('DELETE', '/api/tasks/' + t.id); loadTasks(); });
      el.appendChild(row);
    }
  }
  $('add-task').addEventListener('click', async () => {
    const title = $('tk-title').value.trim();
    if (!title) return;
    const { ok, data } = await api('POST', '/api/tasks', { title, dueAt: $('tk-due').value || null });
    status.textContent = ok ? 'Task added.' : (data.error || 'Failed.');
    if (ok) { $('tk-title').value = ''; loadTasks(); }
  });

  // --- Contacts ---
  async function loadActivities(ref) {
    const head = $('activities-head');
    const el = $('activities-list');
    if (!ref) { if (head) head.hidden = true; el.innerHTML = ''; return; }
    const { data } = await api('GET', '/api/activities?entityRef=' + encodeURIComponent(ref));
    const acts = data.activities || [];
    if (head) head.hidden = acts.length === 0;
    el.innerHTML = acts.map((a) => `<div class="lead-row"><div class="lead-main"><strong>${esc(a.type)}</strong> <span class="muted">${esc(a.note || '')}</span><span class="muted">${new Date(a.createdAt).toLocaleString()} · ${esc(a.author || '')}</span></div></div>`).join('');
  }

  async function loadContacts() {
    const ref = $('cn-source').value.trim();
    loadActivities(ref);
    const { data } = await api('GET', '/api/sources/' + encodeURIComponent(ref || '_') + '/contacts');
    const el = $('contacts-list');
    const cs = data.contacts || [];
    if (!cs.length) { el.innerHTML = '<p class="muted">No contacts for this source.</p>'; return; }
    const seqOpts = sequences.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    el.innerHTML = '';
    for (const c of cs) {
      const row = document.createElement('div');
      row.className = 'lead-row';
      row.innerHTML = `<div class="lead-main"><strong>${esc(c.name)}</strong><span class="muted">${esc(c.title)} · ${esc(c.email)} · consent: ${esc(c.consentStatus)}</span></div>
        <div class="lead-actions">
          <select class="cn-seq">${seqOpts || '<option value="">no sequences</option>'}</select>
          <button type="button" class="link-btn cn-enroll">Enroll</button>
          <button type="button" class="link-btn cn-act">Log call</button>
          <button type="button" class="link-btn cn-del">Delete</button>
        </div>`;
      row.querySelector('.cn-enroll').addEventListener('click', async () => {
        const seqId = row.querySelector('.cn-seq').value;
        if (!seqId) return;
        const { ok, data: d } = await api('POST', '/api/sequences/' + seqId + '/enroll', { contactId: c.id });
        status.textContent = ok ? 'Enrolled.' : (d.error || 'Enroll failed.');
        loadEnrollments();
      });
      row.querySelector('.cn-act').addEventListener('click', async () => {
        await api('POST', '/api/activities', { entityType: 'contact', entityRef: c.id, type: 'call', note: 'Logged a call' });
        status.textContent = 'Activity logged.';
      });
      row.querySelector('.cn-del').addEventListener('click', async () => { await api('DELETE', '/api/contacts/' + c.id); loadContacts(); });
      el.appendChild(row);
    }
  }
  $('load-contacts').addEventListener('click', loadContacts);
  $('add-contact').addEventListener('click', async () => {
    const ref = $('cn-source').value.trim();
    if (!ref) { status.textContent = 'Enter a source ref first.'; return; }
    const body = { name: $('cn-name').value.trim(), title: $('cn-title').value.trim(), email: $('cn-email').value.trim(), consentStatus: $('cn-consent').value };
    const { ok, data } = await api('POST', '/api/sources/' + encodeURIComponent(ref) + '/contacts', body);
    status.textContent = ok ? 'Contact added.' : (data.error || 'Failed.');
    if (ok) { $('cn-name').value = ''; $('cn-email').value = ''; loadContacts(); }
  });

  // --- Sequences ---
  async function loadSequences() {
    const { data } = await api('GET', '/api/sequences');
    sequences = data.sequences || [];
    const el = $('sequences-list');
    el.innerHTML = sequences.length
      ? sequences.map((s) => `<div class="lead-row"><div class="lead-main"><strong>${esc(s.name)}</strong><span class="muted">${s.steps.length} step(s): ${esc(s.steps.map((x) => x.channel === 'manual_task' ? 'task' : 'email').join(' → '))}</span></div></div>`).join('')
      : '<p class="muted">No sequences yet.</p>';
  }
  $('add-sequence').addEventListener('click', async () => {
    const name = $('sq-name').value.trim();
    const lines = $('sq-steps').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const steps = lines.map((l) => {
      const manual = /^manual:/i.test(l);
      const parts = l.replace(/^manual:/i, '').split('|').map((x) => x.trim());
      return { channel: manual ? 'manual_task' : 'email', subject: parts[0] || '', body: parts[1] || '', delayDays: Number(parts[2]) || 0 };
    });
    if (!name || !steps.length) { status.textContent = 'Name + at least one step required.'; return; }
    const { ok, data } = await api('POST', '/api/sequences', { name, steps });
    status.textContent = ok ? 'Sequence created.' : (data.error || 'Failed.');
    if (ok) { $('sq-name').value = ''; $('sq-steps').value = ''; loadSequences(); }
  });

  // --- Enrollments ---
  async function loadEnrollments() {
    const { data } = await api('GET', '/api/enrollments');
    const es = data.enrollments || [];
    const el = $('enrollments-list');
    if (!es.length) { el.innerHTML = '<p class="muted">No enrollments.</p>'; return; }
    el.innerHTML = '';
    for (const e of es) {
      const row = document.createElement('div');
      row.className = 'lead-row';
      row.innerHTML = `<div class="lead-main"><strong>${esc(e.sequenceName || 'Sequence')}</strong><span class="muted">${esc(e.contactEmail)} · ${esc(e.status)} · step ${e.currentStep}${e.stoppedReason ? ' · ' + esc(e.stoppedReason) : ''}</span></div>
        <div class="lead-actions">${e.status === 'active' ? '<button type="button" class="link-btn en-stop">Stop</button>' : ''}</div>`;
      if (e.status === 'active') row.querySelector('.en-stop').addEventListener('click', async () => { await api('POST', '/api/enrollments/' + e.id + '/stop'); loadEnrollments(); });
      el.appendChild(row);
    }
  }

  $('run-cron').addEventListener('click', async () => {
    const { data } = await api('POST', '/api/cron/run');
    status.textContent = `Cron ran — ${data.reminders || 0} reminder(s), ${data.sequenceSteps || 0} sequence step(s) sent.`;
    loadTasks(); loadEnrollments();
  });

  window.reloadCrmTasks = loadTasks;
  loadTasks();
  loadSequences();
  loadEnrollments();
})();
