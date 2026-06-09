'use strict';

/*
 * Create or update an admin account in the configured store (Postgres if
 * DATABASE_URL is set, else the JSON file). Admins bypass all billing — make
 * sure the email is also listed in ADMIN_EMAILS (it defaults to the project
 * owner's email; see lib/admin.js).
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret node scripts/create-admin.js
 *   node scripts/create-admin.js you@example.com secret
 *
 * Running it again for an existing email updates that account's password.
 */

const store = require('../lib/store');
const authlib = require('../lib/auth');

(async () => {
  await store.init();

  const email = String(process.env.ADMIN_EMAIL || process.argv[2] || '').trim();
  const password = process.env.ADMIN_PASSWORD || process.argv[3] || '';
  if (!email || !password) {
    console.error('Usage: ADMIN_EMAIL=.. ADMIN_PASSWORD=.. node scripts/create-admin.js');
    process.exit(1);
  }

  const passwordHash = authlib.hashPassword(password);
  const existing = await store.findByEmail(email);

  if (existing) {
    await store.updateUser(existing.id, { passwordHash });
    console.log(`Updated password for existing account: ${email} (username "${existing.username}")`);
  } else {
    let username = (email.split('@')[0] || 'admin').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
    if (username.length < 3) username = 'admin';
    let candidate = username;
    let n = 1;
    while (await store.findByUsername(candidate)) candidate = `${username.slice(0, 28)}${n++}`.slice(0, 32);
    await store.createUser({ username: candidate, email, passwordHash });
    console.log(`Created admin account: ${email} (username "${candidate}")`);
  }

  console.log('Log in with the email above. Make sure it is in ADMIN_EMAILS so billing is bypassed.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
