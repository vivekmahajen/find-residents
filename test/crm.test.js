'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../lib/crm');

test('unsubscribe token verifies and rejects tampering', () => {
  const t = c.unsubToken('x@y.com', 'agency1');
  assert.equal(c.verifyUnsub('x@y.com', 'agency1', t), true);
  assert.equal(c.verifyUnsub('x@y.com', 'agency1', 'tampered'), false);
  assert.equal(c.verifyUnsub('other@y.com', 'agency1', t), false);
});

test('bucketTasks splits overdue / today / upcoming and skips done', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const tasks = [
    { data: { status: 'open', dueAt: now - 2 * day } },
    { data: { status: 'open', dueAt: now + 2 * day } },
    { data: { status: 'done', dueAt: now - 5 * day } },
  ];
  const b = c.bucketTasks(tasks, now);
  assert.equal(b.overdue.length, 1);
  assert.equal(b.upcoming.length, 1);
  assert.equal(b.today.length, 0);
});
