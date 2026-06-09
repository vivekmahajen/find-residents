'use strict';

/*
 * One-off migration: refill every existing account's plan credits to its
 * plan's current allotment (Free → 100). Top-up credits and accrued overage are
 * preserved. Runs against the configured store (Postgres if DATABASE_URL is set,
 * else the JSON file).
 *
 * Usage:  node scripts/reset-credits.js      (or: npm run reset-credits)
 */

const store = require('./../lib/store');
const pricing = require('./../lib/pricing');

(async () => {
  await store.init();
  const users = await store.listUsers();
  let n = 0;
  for (const u of users) {
    const acct = u.account || pricing.defaultAccount();
    const plan = pricing.planById(acct.planId) || pricing.planById('free');
    const allotment = plan.credits || 0;
    acct.planCredits = allotment;
    acct.cycleStart = Date.now();
    await store.updateUser(u.id, { account: acct });
    n += 1;
    console.log(`reset ${u.email} (${plan.name}) -> ${allotment} plan credits`);
  }
  console.log(`Done. Refilled ${n} account(s).`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
