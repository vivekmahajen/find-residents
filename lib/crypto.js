'use strict';

/*
 * Application-level encryption for stored client data (AES-256-GCM). The key is
 * derived from DATA_ENCRYPTION_KEY (any string → SHA-256 → 32 bytes). If the env
 * var is unset, data is stored unencrypted (marked "plain:") so local dev works
 * — set the key in production. Stored client records are also redacted of
 * sensitive identifiers before encryption (defense in depth).
 */

const crypto = require('crypto');

function key() {
  const secret = process.env.DATA_ENCRYPTION_KEY;
  if (!secret) return null;
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function enabled() {
  return !!process.env.DATA_ENCRYPTION_KEY;
}

function encryptJson(obj) {
  const plain = JSON.stringify(obj);
  const k = key();
  if (!k) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

function decryptJson(str) {
  if (str == null) return null;
  if (typeof str === 'object') return str; // already parsed
  if (str.startsWith('plain:')) return JSON.parse(str.slice(6));
  if (str.startsWith('enc:')) {
    const k = key();
    if (!k) throw new Error('DATA_ENCRYPTION_KEY is required to read encrypted records.');
    const buf = Buffer.from(str.slice(4), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(out.toString('utf8'));
  }
  return JSON.parse(str); // legacy plain JSON
}

module.exports = { enabled, encryptJson, decryptJson };
