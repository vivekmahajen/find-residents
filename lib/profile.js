'use strict';

/*
 * Agency profile: the structured capability profile an agency builds once.
 * The case-generator agent reads it to match real capabilities to a contact's
 * pain points. Truth-only — empty fields are surfaced as "[not provided]".
 */

const STRING_FIELDS = [
  'identity',
  'serviceArea',
  'languages',
  'hours',
  'facilityNetwork',
  'responsiveness',
  'credibility',
  'integration',
  'feeModel',
];

const ARRAY_FIELDS = ['levelsOfCare', 'payors', 'complexCases', 'processServices'];

// Checkbox option sets surfaced to the form.
const OPTIONS = {
  levelsOfCare: [
    'Assisted living',
    'Board & care (RCFE)',
    'Memory care',
    'Independent living',
    'Skilled-nursing referral',
  ],
  payors: [
    'Private pay',
    'Long-term-care insurance',
    'Medi-Cal',
    'Assisted Living Waiver (ALW)',
    'VA',
    'County / low-income programs',
  ],
  complexCases: [
    'Behavioral health',
    'Dementia / memory care',
    'Two-person transfer / bariatric',
    'Oxygen / dialysis / wound / tube feeding',
    'Intellectual & developmental disability (IDD)',
    'Substance use',
    'Conservatorship / LPS',
    'Unhoused / SB 1152',
    'Undocumented',
    'Medi-Cal-only / low-income',
  ],
  processServices: [
    'Needs assessment',
    'Accompanied tours',
    'Paperwork handling',
    'Benefits / financial navigation',
    'Transportation coordination',
    'Post-placement follow-up & retention',
    'Family support',
  ],
};

// Human labels for building the agent context.
const LABELS = {
  identity: 'Identity (legal name/DBA, founded, ownership, locations, CA referral-source registration, insurance, background-check policy)',
  serviceArea: 'Service area (counties / cities / ZIP radius)',
  languages: 'Languages served',
  hours: 'Hours / availability',
  levelsOfCare: 'Levels of care placed',
  payors: 'Payors handled',
  complexCases: 'Complex / hard-to-place case capabilities',
  facilityNetwork: 'Facility network (# & types of partners, density, vetting / quality screening)',
  responsiveness: 'Responsiveness & SLAs (avg response time, time-to-placement, bedside assessment, same-day/weekend capacity)',
  processServices: 'Process & family services',
  credibility: 'Credibility & proof (years, placements/year, existing relationships, staff credentials, testimonials, measured outcomes)',
  integration: 'Integration & intake (e-referral platforms, CRM, no-PHI intake)',
  feeModel: 'Fee model & disclosures',
};

const ORDER = [
  'identity',
  'serviceArea',
  'languages',
  'hours',
  'levelsOfCare',
  'payors',
  'complexCases',
  'facilityNetwork',
  'responsiveness',
  'processServices',
  'credibility',
  'integration',
  'feeModel',
];

function sanitize(body) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const k of STRING_FIELDS) {
    out[k] = String(src[k] == null ? '' : src[k]).slice(0, 4000).trim();
  }
  for (const k of ARRAY_FIELDS) {
    const arr = Array.isArray(src[k]) ? src[k] : [];
    out[k] = [...new Set(arr.map((v) => String(v).slice(0, 200)))].slice(0, 50);
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

function isEmpty(profile) {
  if (!profile) return true;
  const noStrings = STRING_FIELDS.every((k) => !String(profile[k] || '').trim());
  const noArrays = ARRAY_FIELDS.every((k) => !(Array.isArray(profile[k]) && profile[k].length));
  return noStrings && noArrays;
}

// Build the readable context block the agent consumes.
function toContext(profile) {
  const lines = [];
  for (const key of ORDER) {
    let value;
    if (ARRAY_FIELDS.includes(key)) {
      value = Array.isArray(profile[key]) && profile[key].length ? profile[key].join('; ') : '';
    } else {
      value = String(profile[key] || '').trim();
    }
    lines.push(`- ${LABELS[key]}: ${value || '[not provided — verify]'}`);
  }
  return lines.join('\n');
}

module.exports = { STRING_FIELDS, ARRAY_FIELDS, OPTIONS, sanitize, isEmpty, toContext };
