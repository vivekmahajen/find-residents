'use strict';

/*
 * Privacy-safe client profile renderer (deterministic — no LLM in the
 * redaction path). Takes a raw-ish client record and produces a matching-ready
 * profile with sensitive identifiers redacted, contact info role-gated, full
 * DOB reduced to age, free text scrubbed, and a transparency list of what was
 * withheld. Data-minimizing by design.
 *
 * Stateless: callers pass a record in and get a safe view out; nothing here
 * persists anything.
 */

// --- Labeled sensitive values: "SSN: 123-45-6789", "MRN #4567", etc. --------
const LABELED = [
  { cat: 'SSN', kw: "social security(?: number| no\\.?| #)?|ssn" },
  { cat: 'Financial data', kw: "account(?: number| no\\.?| #)?|acct|routing|iban|swift|card(?: number| no\\.?| #)?|cc#?|cvv|cvc|pin" },
  { cat: 'Government ID', kw: "driver'?s? licen[sc]e|dl#?|state id|passport(?: number| no\\.?| #)?|alien(?: number| reg(?:istration)?)?|a-?number|a#|visa(?: number| status)?|green ?card|immigration" },
  { cat: 'Medical ID', kw: "m\\.?r\\.?n\\.?|medical record(?: number)?|medicare(?: number| id)?|mbi|medi-?cal(?: id)?|medicaid(?: id)?|member id|policy(?: number| no\\.?| #)?|health ?plan(?: id)?|insurance(?: id| policy(?: number)?)|\\bcin\\b|\\bbic\\b|subscriber id" },
  { cat: 'Date of birth', kw: "d\\.?o\\.?b\\.?|date of birth|birth ?date|born(?: on)?" },
  { cat: 'Credentials/biometric', kw: "password|passwd|pwd|\\blogin\\b|fingerprint|biometric|retina|face ?id" },
];

// --- Unlabeled shape patterns. SHAPE_FIRST runs before labeled redaction so a
// "card 4111 1111 ..." value is caught whole; SHAPE_LAST mops up bare numeric
// and digit-heavy alphanumeric IDs that a label may have left behind. ---------
const SHAPE_FIRST = [
  { cat: 'SSN', re: /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g },
  { cat: 'Financial data', re: /\b(?:\d[ -]?){13,19}\b/g },
  { cat: 'IP/device identifier', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g },
];
const SHAPE_LAST = [
  { cat: 'SSN / account number', re: /\b\d{9,}\b/g },
  // 6+ char token containing 5+ digits → an ID number (MRN, MBI, policy, etc.).
  { cat: 'ID number', re: /\b(?=[A-Za-z0-9-]*(?:\d[A-Za-z0-9-]*){5})[A-Za-z0-9-]{6,}\b/g },
];

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

const REDACTED = '[redacted]';
const MISSING = '[not provided]';

function applyShape(text, cats, list) {
  let out = text;
  for (const { cat, re } of list) {
    const rx = new RegExp(re.source, re.flags);
    out = out.replace(rx, () => {
      cats.add(cat);
      return REDACTED;
    });
  }
  return out;
}

// Scrub a string of all Rule-1 sensitive identifiers. Returns the cleaned text
// and the set of category labels that were found.
function scrub(input) {
  const cats = new Set();
  let text = String(input == null ? '' : input);

  text = applyShape(text, cats, SHAPE_FIRST);
  for (const { cat, kw } of LABELED) {
    const re = new RegExp(`\\b(${kw})\\b\\s*[:#=\\-]?\\s*([^\\s,;]{2,})`, 'gi');
    text = text.replace(re, (m, label) => {
      cats.add(cat);
      return `${label}: ${REDACTED}`;
    });
  }
  text = applyShape(text, cats, SHAPE_LAST);
  return { text, cats };
}

function maskEmailInline(text) {
  return text.replace(EMAIL_RE, REDACTED);
}
function maskPhoneInline(text) {
  return text.replace(PHONE_RE, REDACTED);
}

// Notes/free text: always scrub Rule-1 items; for non-full roles also strip
// direct contact info (emails/phones) that may appear inline.
function sanitizeNotes(notes, role) {
  const { text, cats } = scrub(notes);
  let out = text;
  if (role !== 'full') {
    out = maskPhoneInline(maskEmailInline(out));
  }
  return { text: out.trim(), cats };
}

// Reduce a date of birth to an age (full DOB is never shown).
function ageFromDob(dob) {
  if (!dob) return null;
  const raw = String(dob).trim();
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime()) && /\d{4}/.test(raw) && /[/-]|\w{3,}/.test(raw)) {
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
    if (age >= 0 && age < 130) return String(age);
  }
  const year = raw.match(/\b(19|20)\d{2}\b/);
  if (year) {
    const approx = new Date().getFullYear() - Number(year[0]);
    if (approx >= 0 && approx < 130) return `~${approx}`;
  }
  return null;
}

function maskPhone(value, role) {
  if (!value) return null;
  if (role === 'full') return String(value);
  if (role === 'partner_facility') return null;
  const digits = String(value).replace(/\D/g, '');
  const last2 = digits.slice(-2) || '••';
  return `phone on file (•• ${last2})`;
}

function maskEmail(value, role) {
  if (!value) return null;
  if (role === 'full') return String(value);
  if (role === 'partner_facility') return null;
  const m = String(value).match(/^([^@]+)@(.+)$/);
  if (!m) return REDACTED;
  const tld = m[2].slice(m[2].lastIndexOf('.'));
  return `${m[1][0] || '•'}•••@•••${tld}`;
}

function nameByRole(name, role) {
  if (!name) return null;
  const clean = scrub(name).text.trim();
  if (role === 'full') return clean;
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || null;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function val(x) {
  const s = String(x == null ? '' : x).trim();
  return s || null;
}

// Scrub a free-ish field value and collect categories.
function field(record, key, withheld) {
  const v = val(record[key]);
  if (!v) return null;
  const { text, cats } = scrub(v);
  cats.forEach((c) => withheld.add(c));
  return text;
}

// Render the privacy-safe profile from a raw record.
function renderProfile(record, viewerRole, outputMode) {
  const role = ['full', 'matching_only', 'partner_facility'].includes(viewerRole)
    ? viewerRole
    : 'matching_only';
  const mode = ['profile', 'table', 'export'].includes(outputMode) ? outputMode : 'profile';
  const r = record && typeof record === 'object' ? record : {};
  const withheld = new Set();

  // DOB → age (full DOB always withheld)
  const dobProvided = !!val(r.dob);
  const age = ageFromDob(r.dob) || val(r.age);
  if (dobProvided) withheld.add('Full date of birth (shown as age)');

  const notes = sanitizeNotes(r.notes, role);
  notes.cats.forEach((c) => withheld.add(c));
  const rawNotes = sanitizeNotes(r.raw, role);
  rawNotes.cats.forEach((c) => withheld.add(c));
  const noteText = [notes.text, rawNotes.text].filter(Boolean).join('\n') || null;

  // Contact gating
  const phone = maskPhone(val(r.phone), role);
  const email = maskEmail(val(r.email), role);
  const contactPhone = maskPhone(val(r.contactPhone), role);
  if (role !== 'full' && (val(r.phone) || val(r.email) || val(r.contactPhone))) {
    withheld.add(role === 'partner_facility' ? 'Direct contact info (partner view)' : 'Full phone/email (masked)');
  }

  const profile = {
    reference: field(r, 'reference', withheld) || MISSING,
    name: nameByRole(field(r, 'name', withheld), role) || MISSING,
    gender: val(r.gender) || MISSING,
    age: age || MISSING,
    contact: {
      phone: phone || MISSING,
      email: email || MISSING,
      mailingArea: field(r, 'mailingArea', withheld) || MISSING,
    },
    primaryContact: {
      name: nameByRole(field(r, 'contactName', withheld), role) || MISSING,
      relationship: val(r.contactRelationship) || MISSING,
      contact: contactPhone || (role === 'partner_facility' ? '[via agency]' : MISSING),
    },
    location: field(r, 'location', withheld) || MISSING,
    carePreference: {
      type: val(r.carePreferenceType) || MISSING,
      features: field(r, 'careFeatures', withheld) || MISSING,
    },
    roomType: val(r.roomType) || MISSING,
    budget: {
      amount: val(r.budgetAmount) || MISSING,
      payor: val(r.payor) || MISSING,
      shareOfCost: val(r.shareOfCost) || MISSING,
    },
    needs: field(r, 'needs', withheld) || MISSING,
    language: val(r.language) || MISSING,
    timeline: val(r.timeline) || MISSING,
    notes: noteText || MISSING,
  };

  return {
    viewerRole: role,
    outputMode: mode,
    matchingReady: mode === 'export',
    profile,
    withheld: [...withheld].sort(),
  };
}

module.exports = { renderProfile, scrub, ageFromDob, MISSING, REDACTED };
