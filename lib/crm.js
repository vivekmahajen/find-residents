'use strict';

const crypto = require('crypto');

function secret() {
  return process.env.CRON_SECRET || process.env.DATA_ENCRYPTION_KEY || 'dev-crm-secret';
}

// Signed unsubscribe token so unsubscribe links can't be forged/enumerated.
function unsubToken(email, agencyId) {
  return crypto.createHmac('sha256', secret()).update(`${String(email).toLowerCase()}|${agencyId}`).digest('hex').slice(0, 32);
}
function verifyUnsub(email, agencyId, token) {
  const expected = unsubToken(email, agencyId);
  const got = String(token || '');
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(now) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// Split open tasks into overdue / today / upcoming.
function bucketTasks(tasks, now) {
  const sod = startOfDay(now);
  const eod = endOfDay(now);
  const overdue = [];
  const today = [];
  const upcoming = [];
  for (const t of tasks) {
    if (t.data.status === 'done') continue;
    const due = t.data.dueAt;
    if (due == null) { upcoming.push(t); continue; }
    if (due < sod) overdue.push(t);
    else if (due <= eod) today.push(t);
    else upcoming.push(t);
  }
  return { overdue, today, upcoming };
}

module.exports = { unsubToken, verifyUnsub, bucketTasks };
