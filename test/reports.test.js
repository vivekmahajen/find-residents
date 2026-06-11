'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/reports');

const now = Date.now();
const D = 24 * 60 * 60 * 1000;

test('funnel, conversions, leaderboard, time-to-placement', () => {
  const ev = [
    { agencyId: 'A', createdAt: now - 5 * D, data: { type: 'contact_added', entityRef: 'NPI1' } },
    { agencyId: 'A', createdAt: now - 4 * D, data: { type: 'lead_created', entityRef: 'L1', metadata: { source: 'UC Davis' } } },
    { agencyId: 'A', createdAt: now - 4 * D, data: { type: 'lead_created', entityRef: 'L2' } },
    { agencyId: 'A', createdAt: now - 3 * D, data: { type: 'tour_scheduled', entityRef: 'L1' } },
    { agencyId: 'A', createdAt: now - 2 * D, data: { type: 'application', entityRef: 'L1' } },
    { agencyId: 'A', createdAt: now - 1 * D, data: { type: 'placement_made', entityRef: 'L1', metadata: { source: 'UC Davis', revenue: 3800 } } },
  ];
  const rep = R.buildReport(ev, { now, days: 30 });
  assert.equal(rep.funnel.leadsReceived, 2);
  assert.equal(rep.funnel.placements, 1);
  assert.equal(rep.conversions.leadToPlacement, 50);
  assert.equal(rep.timeToPlacementDays, 3);
  assert.equal(rep.sourceLeaderboard[0].source, 'UC Davis');
  assert.equal(rep.revenue.total, 3800);
});

test('admin usage counts weekly-active agencies', () => {
  const ev = [{ agencyId: 'A', createdAt: now, data: { type: 'lead_created' } }];
  const users = [{ id: 'A', username: 'a', email: 'a@x.com' }, { id: 'B', username: 'b', email: 'b@x.com' }];
  const u = R.buildAdminUsage(ev, users, now);
  assert.equal(u.weeklyActiveAgencies, 1);
  assert.equal(u.totalAgencies, 2);
});
