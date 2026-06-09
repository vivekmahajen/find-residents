'use strict';

// Password hashing + input validation using only Node's built-in crypto.

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// A practical email check — not RFC-perfect, but rejects obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '').trim());
}

function usernameIssue(username) {
  const u = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(u)) {
    return 'User ID must be 3–32 characters: letters, numbers, dot, underscore, or hyphen.';
  }
  return null;
}

function passwordIssue(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  isValidEmail,
  usernameIssue,
  passwordIssue,
};
