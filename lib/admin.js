'use strict';

/*
 * Admin accounts bypass billing entirely (no credit checks, no charges).
 * Admins are identified by email via the ADMIN_EMAILS env var (comma-separated).
 * Defaults to the project owner's admin email so it works without extra config.
 */

function adminEmails() {
  const raw = process.env.ADMIN_EMAILS || 'vmahajans@yahoo.com';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isAdminEmail(email) {
  return adminEmails().has(String(email || '').trim().toLowerCase());
}

function isAdmin(user) {
  return !!(user && isAdminEmail(user.email));
}

module.exports = { isAdmin, isAdminEmail };
