'use strict';

/*
 * Minimal JSON-file data store (zero dependencies). Holds users, sessions, and
 * password-reset tokens. Loaded into memory on boot; every mutation writes the
 * whole file atomically (temp + rename). Fine for an MVP / low volume — swap for
 * SQLite or Postgres when you outgrow it.
 *
 * The data file (default data/db.json) is gitignored — it holds password hashes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = { users: {}, sessions: {}, resets: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      users: parsed.users || {},
      sessions: parsed.sessions || {},
      resets: parsed.resets || {},
    };
  } catch {
    // No file yet — start fresh.
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

load();

function token() {
  return crypto.randomBytes(24).toString('hex');
}

// ---- Users ----------------------------------------------------------------

function findById(id) {
  return db.users[id] || null;
}

function findByEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  return Object.values(db.users).find((u) => u.emailLower === lower) || null;
}

function findByUsername(username) {
  const lower = String(username || '').trim().toLowerCase();
  return Object.values(db.users).find((u) => u.usernameLower === lower) || null;
}

function createUser({ username, email, passwordHash }) {
  const id = crypto.randomUUID();
  const user = {
    id,
    username,
    usernameLower: username.toLowerCase(),
    email,
    emailLower: email.toLowerCase(),
    passwordHash,
    subscription: null,
    createdAt: new Date().toISOString(),
  };
  db.users[id] = user;
  save();
  return user;
}

function updateUser(id, patch) {
  const user = db.users[id];
  if (!user) return null;
  Object.assign(user, patch);
  save();
  return user;
}

// ---- Sessions -------------------------------------------------------------

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createSession(userId) {
  const t = token();
  db.sessions[t] = { userId, expires: Date.now() + SESSION_TTL_MS };
  save();
  return t;
}

function getSession(t) {
  const s = db.sessions[t];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete db.sessions[t];
    save();
    return null;
  }
  return s;
}

function deleteSession(t) {
  if (db.sessions[t]) {
    delete db.sessions[t];
    save();
  }
}

function deleteSessionsForUser(userId) {
  let changed = false;
  for (const [t, s] of Object.entries(db.sessions)) {
    if (s.userId === userId) {
      delete db.sessions[t];
      changed = true;
    }
  }
  if (changed) save();
}

// ---- Password resets ------------------------------------------------------

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function createReset(userId) {
  const t = token();
  db.resets[t] = { userId, expires: Date.now() + RESET_TTL_MS };
  save();
  return t;
}

function getReset(t) {
  const r = db.resets[t];
  if (!r) return null;
  if (r.expires < Date.now()) {
    delete db.resets[t];
    save();
    return null;
  }
  return r;
}

function deleteReset(t) {
  if (db.resets[t]) {
    delete db.resets[t];
    save();
  }
}

module.exports = {
  findById,
  findByEmail,
  findByUsername,
  createUser,
  updateUser,
  createSession,
  getSession,
  deleteSession,
  deleteSessionsForUser,
  createReset,
  getReset,
  deleteReset,
};
