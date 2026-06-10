'use strict';

/*
 * Deterministic resident → care-home matcher (no LLM). Scores an agency's
 * facilities against a resident profile, returns a ranked shortlist with a
 * per-criterion Strong/Partial/Gap fit, the reasons, hard-filter handling,
 * unlicensed flagging, and the California referral-source disclosures attached
 * to every recommendation.
 */

// Map the privacy-safe lead/profile fields onto matcher tokens.
const CARE_TYPE = {
  'assisted living': 'assisted_living',
  'board & care (rcfe)': 'board_and_care_RCFE',
  'board and care (rcfe)': 'board_and_care_RCFE',
  'board and care': 'board_and_care_RCFE',
  'memory care': 'memory_care',
  'independent living': 'independent_living',
  snf: 'SNF',
};
const PAYOR = {
  'private pay': 'private',
  private: 'private',
  'ltc insurance': 'LTC_insurance',
  'long-term-care insurance': 'LTC_insurance',
  'medi-cal': 'Medi-Cal',
  medicaid: 'Medi-Cal',
  'assisted living waiver (alw)': 'ALW',
  alw: 'ALW',
  va: 'VA',
};
const ROOM = { private: 'private', shared: 'shared', studio: 'studio', 'one-bedroom': 'one_bedroom', 'one bedroom': 'one_bedroom' };
const CAPABILITY_HINTS = [
  'memory_care', 'behavioral', 'two_person_transfer', 'oxygen', 'dialysis',
  'bariatric', 'hospice_friendly', 'pet_friendly', 'faith_based',
];

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}
function moneyToNumber(s) {
  const n = Number(String(s == null ? '' : s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function asArray(x) {
  if (Array.isArray(x)) return x.map(norm).filter(Boolean);
  return String(x || '').split(/[;,/]/).map(norm).filter(Boolean);
}

// Build a matcher profile from a stored lead record (redact-schema fields).
function profileFromRecord(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const loc = norm(r.location);
  const zip = (loc.match(/\b\d{5}\b/) || [])[0] || null;
  const needsText = `${norm(r.needs)} ${norm(r.careFeatures)}`;
  const specialNeeds = CAPABILITY_HINTS.filter((c) => needsText.includes(c.replace(/_/g, ' ')) || needsText.includes(c.replace(/_/g, '-')));
  if (/two[- ]?person|transfer/.test(needsText)) specialNeeds.push('two_person_transfer');
  if (/memory|dementia|alzheimer/.test(needsText)) specialNeeds.push('memory_care');
  return {
    careLevel: CARE_TYPE[norm(r.carePreferenceType)] || null,
    payor: PAYOR[norm(r.payor)] || null,
    budget: moneyToNumber(r.budgetAmount),
    zip,
    locationText: loc,
    roomType: ROOM[norm(r.roomType)] || null,
    language: norm(r.language) || null,
    specialNeeds: [...new Set(specialNeeds)],
  };
}

const WEIGHTS = { payor: 25, level: 20, location: 15, budget: 15, needs: 10, availability: 8, roomType: 5, language: 2 };
const FACTOR = { Strong: 1, Partial: 0.5, Gap: 0 };

function isUnlicensed(f) {
  const s = norm(f.license_status);
  return s === 'unlicensed' || s === 'revoked' || s === 'suspended';
}

function scoreFacility(profile, f) {
  const criteria = [];
  const add = (name, fit, detail) => criteria.push({ name, fit, detail });

  // Payor (hard)
  const payors = asArray(f.payors_accepted);
  if (!profile.payor) add('Payor', 'Partial', 'No payor specified');
  else if (!payors.length) add('Payor', 'Partial', 'Facility payors not listed — verify');
  else if (payors.includes(norm(profile.payor))) add('Payor', 'Strong', `Accepts ${profile.payor}`);
  else add('Payor', 'Gap', `Does not accept ${profile.payor}`);

  // Level of care (hard)
  const levels = new Set([norm(f.type), ...asArray(f.levels_of_care)]);
  const caps = asArray(f.capabilities);
  if (!profile.careLevel) add('Level of care', 'Partial', 'No care level specified');
  else if (levels.has(norm(profile.careLevel)) || (profile.careLevel === 'memory_care' && caps.includes('memory_care'))) add('Level of care', 'Strong', `Provides ${profile.careLevel}`);
  else add('Level of care', 'Gap', `Cannot provide ${profile.careLevel}`);

  // Location
  const fz = norm(f.zip);
  const county = norm(f.county);
  const city = norm(f.city);
  const cityHit = !!(profile.locationText && city && profile.locationText.includes(city));
  const countyHit = !!(profile.locationText && county && profile.locationText.includes(county));
  if (profile.zip && fz === profile.zip) add('Location', 'Strong', `Same ZIP (${profile.zip})`);
  else if (cityHit || countyHit) add('Location', 'Strong', `In ${city || county}`);
  else if (!profile.locationText) add('Location', 'Partial', 'No location specified');
  else add('Location', 'Partial', 'Outside the stated area — verify radius');

  // Budget
  const min = moneyToNumber(f.price_min);
  const max = moneyToNumber(f.price_max);
  if (!profile.budget) add('Budget', 'Partial', 'No budget specified');
  else if (min == null && max == null) add('Budget', 'Partial', 'Facility pricing not listed');
  else if ((min == null || profile.budget >= min) && (max == null || profile.budget <= max)) add('Budget', 'Strong', `Within range`);
  else if (max != null && profile.budget <= max * 1.15) add('Budget', 'Partial', 'Slightly over budget');
  else add('Budget', 'Gap', 'Outside budget range');

  // Special needs
  if (!profile.specialNeeds.length) add('Special needs', 'Strong', 'None specified');
  else {
    const met = profile.specialNeeds.filter((n) => caps.includes(n));
    if (met.length === profile.specialNeeds.length) add('Special needs', 'Strong', `Meets: ${met.join(', ')}`);
    else if (met.length) add('Special needs', 'Partial', `Meets ${met.length}/${profile.specialNeeds.length}`);
    else add('Special needs', 'Gap', `Missing: ${profile.specialNeeds.join(', ')}`);
  }

  // Availability
  const avail = norm(f.availability_status);
  if (avail === 'open') add('Availability', 'Strong', 'Open');
  else if (avail === 'limited') add('Availability', 'Partial', 'Limited');
  else if (avail === 'full') add('Availability', 'Gap', 'Full');
  else add('Availability', 'Partial', 'Availability unknown — verify');

  // Room type
  const rooms = asArray(f.room_types);
  if (!profile.roomType) add('Room type', 'Strong', 'No preference');
  else if (!rooms.length) add('Room type', 'Partial', 'Room types not listed');
  else if (rooms.includes(norm(profile.roomType))) add('Room type', 'Strong', `${profile.roomType} available`);
  else add('Room type', 'Gap', `${profile.roomType} not listed`);

  // Language
  const langs = asArray(f.languages);
  if (!profile.language) add('Language', 'Strong', 'No preference');
  else if (langs.includes(profile.language)) add('Language', 'Strong', `${profile.language} spoken`);
  else add('Language', 'Partial', 'Language not confirmed');

  // Score
  let score = 0;
  for (const c of criteria) {
    const key = { Payor: 'payor', 'Level of care': 'level', Location: 'location', Budget: 'budget', 'Special needs': 'needs', Availability: 'availability', 'Room type': 'roomType', Language: 'language' }[c.name];
    score += (WEIGHTS[key] || 0) * FACTOR[c.fit];
  }
  score = Math.round(score);

  // Hard filters + flags
  const flags = [];
  let recommended = true;
  const payorGap = criteria.find((c) => c.name === 'Payor' && c.fit === 'Gap');
  const levelGap = criteria.find((c) => c.name === 'Level of care' && c.fit === 'Gap');
  if (payorGap) { recommended = false; flags.push('Payor not accepted'); }
  if (levelGap) { recommended = false; flags.push('Cannot provide required level of care'); }
  if (isUnlicensed(f)) { recommended = false; flags.push('Apparently unlicensed — report to CDSS; excluded from recommendations'); }
  else if (!norm(f.license_status)) flags.push('License status not verified');

  return {
    facilityId: f.id,
    name: f.name,
    type: f.type,
    city: f.city,
    county: f.county,
    score,
    recommended,
    flags,
    criteria,
    disclosures: disclosuresFor(f),
  };
}

// California RCFE referral-source disclosures attached to every recommendation.
function disclosuresFor(f) {
  return {
    feePaidByFacility: f.fee_paid_by_facility != null ? f.fee_paid_by_facility : 'unknown',
    lastVerifiedAt: f.last_verified_at || null,
    licenseNumber: f.ca_license_number || null,
    licenseStatus: f.license_status || 'unverified',
    knownViolations: f.known_violations || 'none on file (verify on CDSS)',
    note: 'Facilities may pay the agency a referral fee. Disclose the fee, services provided, most recent tour date, and any known CDSS violations to the family. Not legal advice.',
  };
}

function matchFacilities(profile, facilities) {
  const ranked = (facilities || [])
    .map((f) => scoreFacility(profile, f))
    .sort((a, b) => (b.recommended - a.recommended) || (b.score - a.score));
  return ranked;
}

module.exports = { matchFacilities, scoreFacility, profileFromRecord, disclosuresFor };
