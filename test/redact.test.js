'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../lib/redact');

test('scrubs SSN, MRN, card, and account numbers (no leaks)', () => {
  const cases = ['SSN 123-45-6789', 'MRN #44821', 'card 4111 1111 1111 1111', 'account 1234567890', 'Medi-Cal CIN 90000000A'];
  for (const c of cases) {
    const s = r.scrub(c);
    assert.ok(!/123-45-6789|44821|4111 1111 1111 1111|1234567890|90000000A/.test(s.text), `leak in: ${c} -> ${s.text}`);
  }
});

test('DOB reduces to age, never the date', () => {
  const age = new Date().getFullYear() - 1943;
  assert.equal(r.ageFromDob('04/12/1943'), String(age));
});

test('role-gating: full keeps contact (but scrubs notes), matching masks, partner hides', () => {
  const rec = { name: 'Maria Gonzalez', dob: '1943', phone: '(916) 555-0142', email: 'm@x.com', notes: 'SSN 111-22-3333' };
  const full = r.renderProfile(rec, 'full', 'profile');
  assert.ok(!/111-22-3333/.test(JSON.stringify(full)));
  const mo = r.renderProfile(rec, 'matching_only', 'profile');
  assert.match(mo.profile.name, /^Maria G/);
  assert.notEqual(mo.profile.contact.phone, '(916) 555-0142');
  const pf = r.renderProfile(rec, 'partner_facility', 'profile');
  assert.equal(pf.profile.contact.phone, '[not provided]');
});

test('toStorableRecord strips identifiers + DOB, keeps age', () => {
  const { record } = r.toStorableRecord({ name: 'A', dob: '1943', notes: 'SSN 123-45-6789', phone: '916-555-0142' });
  assert.ok(!record.dob);
  assert.ok(record.age);
  assert.ok(!/123-45-6789/.test(JSON.stringify(record)));
});
