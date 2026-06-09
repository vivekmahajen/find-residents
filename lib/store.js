'use strict';

/*
 * Store facade. Selects the backend by environment:
 *   - DATABASE_URL set  → Postgres (lib/store-pg) — for Vercel / serverless.
 *   - otherwise         → JSON file (lib/store-file) — local dev / persistent disk.
 *
 * All methods are async and share the same signatures, so the rest of the app
 * is backend-agnostic. init() is memoized and must be awaited before first use
 * (the request handler in server.js does this).
 */

const backend = process.env.DATABASE_URL ? require('./store-pg') : require('./store-file');

let initPromise = null;
function init() {
  if (!initPromise) initPromise = backend.init();
  return initPromise;
}

module.exports = Object.assign({}, backend, { init });
