'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../lib/matcher');

test('perfect fit scores high, recommended, with disclosures', () => {
  const fac = { id: 'A', name: 'Good', type: 'board_and_care_RCFE', city: 'Sacramento', zip: '95823', license_status: 'licensed', availability_status: 'open', levels_of_care: ['board_and_care_RCFE', 'memory_care'], payors_accepted: ['private', 'Medi-Cal'], price_min: 3000, price_max: 4500, room_types: ['private'], languages: ['english', 'spanish'], capabilities: ['memory_care', 'two_person_transfer'] };
  const p = m.profileFromRecord({ carePreferenceType: 'Board & care (RCFE)', payor: 'Medi-Cal', budgetAmount: '$3800', location: 'Sacramento 95823', roomType: 'Private', language: 'Spanish', needs: 'two-person transfer, memory care' });
  const [r] = m.matchFacilities(p, [fac]);
  assert.equal(r.recommended, true);
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.ok(r.disclosures.note);
});

test('wrong payor hard-fails (not recommended)', () => {
  const fac = { id: 'B', name: 'X', type: 'assisted_living', license_status: 'licensed', payors_accepted: ['private'] };
  const p = m.profileFromRecord({ carePreferenceType: 'Board & care (RCFE)', payor: 'Medi-Cal' });
  const [r] = m.matchFacilities(p, [fac]);
  assert.equal(r.recommended, false);
});

test('unlicensed facility is flagged and never recommended', () => {
  const fac = { id: 'C', name: 'U', type: 'board_and_care_RCFE', license_status: 'unlicensed', payors_accepted: ['Medi-Cal'], levels_of_care: ['board_and_care_RCFE'] };
  const p = m.profileFromRecord({ carePreferenceType: 'Board & care (RCFE)', payor: 'Medi-Cal' });
  const [r] = m.matchFacilities(p, [fac]);
  assert.equal(r.recommended, false);
  assert.ok(r.flags.some((f) => /unlicensed/i.test(f)));
});
