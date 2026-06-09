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
};
