'use strict';

/*
 * Postgres-backed store (Vercel / serverless / any DATABASE_URL). Async API,
 * interchangeable with the file backend. `pg` is lazy-required so the file
 * backend works without it installed. Tables are created on first init().
 *
 * Works with Vercel Postgres, Neon, Supabase, etc. SSL is on by default
 * (set PGSSL=disable for a local non-TLS Postgres).
 */

const crypto = require('crypto');

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 3),
    });
  }
  return pool;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function token() {
  return crypto.randomBytes(24).toString('hex');
}

let initDone = false;
async function init() {
  if (initDone) return;
  const p = getPool();
  await p.query(`CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    username text NOT NULL,
    username_lower text UNIQUE NOT NULL,
    email text NOT NULL,
    email_lower text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    subscription jsonb,
    profile jsonb,
    account jsonb,
    created_at timestamptz DEFAULT now()
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    user_id text NOT NULL,
    expires bigint NOT NULL
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS resets (
    token text PRIMARY KEY,
    user_id text NOT NULL,
    expires bigint NOT NULL
  )`);
  await p.query(`CREATE TABLE IF NOT EXISTS leads (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    status text,
    source jsonb,
    data text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS leads_user_idx ON leads (user_id)');
  await p.query(`CREATE TABLE IF NOT EXISTS facilities (
    id text PRIMARY KEY,
    agency_id text,
    data jsonb NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS facilities_agency_idx ON facilities (agency_id)');
  initDone = true;
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    usernameLower: r.username_lower,
    email: r.email,
    emailLower: r.email_lower,
    passwordHash: r.password_hash,
    subscription: r.subscription || null,
    profile: r.profile || null,
    account: r.account || null,
    createdAt: r.created_at,
  };
}

async function findById(id) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(rows[0]);
}
async function findByEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  const { rows } = await getPool().query('SELECT * FROM users WHERE email_lower = $1', [lower]);
  return rowToUser(rows[0]);
}
async function findByUsername(username) {
  const lower = String(username || '').trim().toLowerCase();
  const { rows } = await getPool().query('SELECT * FROM users WHERE username_lower = $1', [lower]);
  return rowToUser(rows[0]);
}
async function createUser({ username, email, passwordHash }) {
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO users (id, username, username_lower, email, email_lower, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, username, username.toLowerCase(), email, email.toLowerCase(), passwordHash]
  );
  return findById(id);
}
async function updateUser(id, patch) {
  const cols = { passwordHash: 'password_hash', subscription: 'subscription', profile: 'profile', account: 'account' };
  const jsonCols = new Set(['subscription', 'profile', 'account']);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, col] of Object.entries(cols)) {
    if (key in patch) {
      sets.push(`${col} = $${i++}`);
      vals.push(jsonCols.has(col) ? JSON.stringify(patch[key]) : patch[key]);
    }
  }
  if (!sets.length) return findById(id);
  vals.push(id);
  await getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return findById(id);
}

async function listUsers() {
  const { rows } = await getPool().query('SELECT * FROM users');
  return rows.map(rowToUser);
}

async function createSession(userId) {
  const t = token();
  await getPool().query('INSERT INTO sessions (token, user_id, expires) VALUES ($1, $2, $3)', [
    t, userId, Date.now() + SESSION_TTL_MS,
  ]);
  return t;
}
async function getSession(t) {
  const { rows } = await getPool().query('SELECT * FROM sessions WHERE token = $1', [t]);
  const s = rows[0];
  if (!s) return null;
  if (Number(s.expires) < Date.now()) {
    await getPool().query('DELETE FROM sessions WHERE token = $1', [t]);
    return null;
  }
  return { userId: s.user_id, expires: Number(s.expires) };
}
async function deleteSession(t) {
  await getPool().query('DELETE FROM sessions WHERE token = $1', [t]);
}
async function deleteSessionsForUser(userId) {
  await getPool().query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

async function createReset(userId) {
  const t = token();
  await getPool().query('INSERT INTO resets (token, user_id, expires) VALUES ($1, $2, $3)', [
    t, userId, Date.now() + RESET_TTL_MS,
  ]);
  return t;
}
async function getReset(t) {
  const { rows } = await getPool().query('SELECT * FROM resets WHERE token = $1', [t]);
  const r = rows[0];
  if (!r) return null;
  if (Number(r.expires) < Date.now()) {
    await getPool().query('DELETE FROM resets WHERE token = $1', [t]);
    return null;
  }
  return { userId: r.user_id, expires: Number(r.expires) };
}
async function deleteReset(t) {
  await getPool().query('DELETE FROM resets WHERE token = $1', [t]);
}

function rowToLead(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    source: r.source || null,
    data: r.data,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
async function createLead(lead) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await getPool().query(
    'INSERT INTO leads (id, user_id, status, source, data, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, lead.userId, lead.status || 'new', JSON.stringify(lead.source || null), lead.data, now, now]
  );
  return getLead(id);
}
async function listLeads(userId) {
  const { rows } = await getPool().query(
    'SELECT * FROM leads WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows.map(rowToLead);
}
async function getLead(id) {
  const { rows } = await getPool().query('SELECT * FROM leads WHERE id = $1', [id]);
  return rowToLead(rows[0]);
}
async function updateLead(id, patch) {
  const cols = { status: 'status', data: 'data' };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, col] of Object.entries(cols)) {
    if (key in patch) {
      sets.push(`${col} = $${i++}`);
      vals.push(patch[key]);
    }
  }
  if ('source' in patch) {
    sets.push(`source = $${i++}`);
    vals.push(JSON.stringify(patch.source || null));
  }
  sets.push(`updated_at = $${i++}`);
  vals.push(Date.now());
  vals.push(id);
  await getPool().query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return getLead(id);
}
async function deleteLead(id) {
  await getPool().query('DELETE FROM leads WHERE id = $1', [id]);
  return true;
}

// Facilities are stored as a jsonb blob (the full record incl. id/agencyId).
function rowToFacility(r) {
  if (!r) return null;
  return r.data;
}
async function createFacility(fac) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec = { id, ...fac, createdAt: now, updatedAt: now };
  await getPool().query(
    'INSERT INTO facilities (id, agency_id, data, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)',
    [id, fac.agencyId || null, JSON.stringify(rec), now, now]
  );
  return rec;
}
async function listFacilities(agencyId) {
  const { rows } = await getPool().query(
    'SELECT data FROM facilities WHERE agency_id = $1 OR agency_id IS NULL ORDER BY (data->>\'name\')',
    [agencyId]
  );
  return rows.map(rowToFacility);
}
async function getFacility(id) {
  const { rows } = await getPool().query('SELECT data FROM facilities WHERE id = $1', [id]);
  return rowToFacility(rows[0]);
}
async function updateFacility(id, patch) {
  const current = await getFacility(id);
  if (!current) return null;
  const rec = { ...current, ...patch, updatedAt: Date.now() };
  await getPool().query('UPDATE facilities SET data = $1, updated_at = $2 WHERE id = $3', [
    JSON.stringify(rec), rec.updatedAt, id,
  ]);
  return rec;
}
async function deleteFacility(id) {
  await getPool().query('DELETE FROM facilities WHERE id = $1', [id]);
  return true;
}

module.exports = {
  init,
  findById,
  findByEmail,
  findByUsername,
  createUser,
  updateUser,
  listUsers,
  createSession,
  getSession,
  deleteSession,
  deleteSessionsForUser,
  createReset,
  getReset,
  deleteReset,
  createLead,
  listLeads,
  getLead,
  updateLead,
  deleteLead,
  createFacility,
  listFacilities,
  getFacility,
  updateFacility,
  deleteFacility,
};
