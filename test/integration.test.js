'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-it-'));
process.env.DATA_ENCRYPTION_KEY = 'test-key';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.ADMIN_EMAILS; // no admins in this run

const handler = require('../server.js');
const store = require('../lib/store');

let server;
let port;

before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(() => server.close());

function rq(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port, path: p, method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } },
      (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => resolve({ status: x.statusCode, body: s, setCookie: x.headers['set-cookie'] })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const J = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
async function signup(u) {
  const r = await rq('POST', '/api/auth/signup', { username: u, email: `${u}@x.com`, password: 'abcd1234' });
  return (r.setCookie || [''])[0].split(';')[0];
}

test('access control: another agency cannot read a lead (404)', async () => {
  const a = await signup('agencyone');
  const b = await signup('agencytwo');
  const lead = J(await rq('POST', '/api/leads', { record: { name: 'X' }, status: 'new' }, a)).lead;
  assert.equal((await rq('GET', `/api/leads/${lead.id}`, null, b)).status, 404);
});

test('facility create + deterministic match from a lead', async () => {
  const a = await signup('agencythree');
  await rq('POST', '/api/facilities', { name: 'Mem Care', type: 'memory_care', city: 'Elk Grove', payors_accepted: 'Medi-Cal', levels_of_care: 'memory_care', availability_status: 'open' }, a);
  const lead = J(await rq('POST', '/api/leads', { record: { name: 'M', carePreferenceType: 'Memory care', payor: 'Medi-Cal', location: 'Elk Grove' }, status: 'new' }, a)).lead;
  const match = J(await rq('POST', '/api/match', { leadId: lead.id }, a));
  assert.ok(match.count >= 1);
  assert.equal(match.results[0].recommended, true);
});

test('onboarding reflects incomplete setup', async () => {
  const a = await signup('agencyfour');
  const ob = J(await rq('GET', '/api/onboarding', null, a));
  assert.equal(ob.complete, false);
  assert.ok(ob.steps.find((s) => s.key === 'lead' && s.done === false));
});

test('admin usage is forbidden for non-admins (403)', async () => {
  const a = await signup('agencyfive');
  assert.equal((await rq('GET', '/api/admin/usage', null, a)).status, 403);
});

test('stripe invoice.paid refills credits + clears past-due', async () => {
  const a = await signup('agencysix');
  const id = J(await rq('GET', '/api/auth/me', null, a)).user.id;
  await store.updateUser(id, { account: { planId: 'pro', annual: false, planCredits: 0, topupCredits: 25, overageUsd: 5, pastDue: true, cycleStart: Date.now() - 40 * 864e5, stripeCustomerId: 'cus_it', stripeSubscriptionId: 'sub_it' } });
  await handler.fulfillStripeEvent({ type: 'invoice.paid', data: { object: { customer: 'cus_it', subscription: 'sub_it', amount_paid: 5900 } } });
  const acct = (await store.findById(id)).account;
  assert.equal(acct.planCredits, 750);
  assert.equal(acct.pastDue, false);
  assert.equal(acct.topupCredits, 25);
});
