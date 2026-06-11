'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const p = require('../lib/pricing');

test('free plan blocks at zero credits', () => {
  const a = p.defaultAccount();
  a.planCredits = 0;
  assert.equal(p.canAfford(a, 'document'), false);
});

test('paid plan meters overage when depleted', () => {
  const a = p.defaultAccount();
  p.setPlan(a, 'pro', false);
  a.planCredits = 0; a.topupCredits = 0;
  const r = p.charge(a, 'deck');
  assert.equal(r.mode, 'overage');
  assert.ok(a.overageUsd > 0);
});

test('past-due paid plan is restricted like free', () => {
  const a = p.defaultAccount();
  p.setPlan(a, 'pro', false);
  a.planCredits = 0; a.pastDue = true;
  assert.equal(p.canAfford(a, 'deck'), false);
});

test('stripe-managed accounts skip the timer refresh; refillPlan refills + clears past-due', () => {
  const a = p.defaultAccount();
  p.setPlan(a, 'pro', false);
  a.stripeSubscriptionId = 'sub_1';
  a.cycleStart = Date.now() - 40 * 24 * 60 * 60 * 1000;
  a.planCredits = 10; a.pastDue = true;
  assert.equal(p.refreshCycle(a), false);
  p.refillPlan(a);
  assert.equal(a.planCredits, 750);
  assert.equal(a.pastDue, false);
});

test('annual billing = 12 months at the annual discount', () => {
  const b = p.planBilling(p.planById('pro'), true);
  assert.equal(b.interval, 'year');
  assert.equal(b.unitAmount, Math.round(59 * 12 * 0.8) * 100);
});
