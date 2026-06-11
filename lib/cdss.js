'use strict';

/*
 * California CDSS / Community Care Licensing (CCLD) facility adapter.
 *
 * Public organizational/licensing data only — never PHI. The exact CHHS Open
 * Data dataset (data.chhs.ca.gov) and its column names change, so this adapter
 * is CONFIGURED BY ENV rather than hardcoded:
 *
 *   CDSS_RESOURCE_ID = <CKAN resource id>     # uses datastore_search on data.chhs.ca.gov
 *   CDSS_BASE        = https://data.chhs.ca.gov   # optional, for CKAN
 *   --- or ---
 *   CDSS_DATA_URL    = <CSV or JSON download URL> # any public dataset export
 *   --- and optionally ---
 *   CDSS_FIELD_MAP   = JSON overriding the column-name mapping below
 *
 * Find the current RCFE dataset on data.chhs.ca.gov (search "Community Care
 * Licensing residential elder"), copy the resource id or CSV URL, and set the
 * env var. Verify the column names map correctly with a dry-run before importing.
 */

const csvLib = require('./csv');

class CdssUnavailable extends Error {}

function enabled() {
  return !!(process.env.CDSS_RESOURCE_ID || process.env.CDSS_DATA_URL);
}

// Default column-name candidates for common CHHS CCLD facility exports.
const DEFAULT_MAP = {
  name: ['Facility Name', 'FACILITY_NAME', 'facility_name'],
  license: ['Facility Number', 'FACILITY_NUMBER', 'facility_number', 'License Number', 'license_number'],
  status: ['Facility Status', 'FACILITY_STATUS', 'facility_status', 'License Status'],
  type: ['Facility Type', 'FACILITY_TYPE', 'facility_type'],
  street: ['Facility Address', 'FACILITY_ADDRESS', 'facility_address', 'Street Address', 'Address'],
  city: ['Facility City', 'FACILITY_CITY', 'facility_city', 'City'],
  county: ['County Name', 'COUNTY_NAME', 'county_name', 'County'],
  zip: ['Facility Zip', 'FACILITY_ZIP', 'facility_zip', 'Zip', 'ZIP'],
  capacity: ['Facility Capacity', 'FACILITY_CAPACITY', 'facility_capacity', 'Capacity'],
  phone: ['Facility Telephone Number', 'TELEPHONE_NUMBER', 'Phone', 'Telephone'],
};

function fieldMap() {
  if (process.env.CDSS_FIELD_MAP) {
    try { return { ...DEFAULT_MAP, ...JSON.parse(process.env.CDSS_FIELD_MAP) }; } catch { /* ignore */ }
  }
  return DEFAULT_MAP;
}

function pick(row, candidates) {
  for (const k of candidates) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('licens')) return 'licensed';
  if (v.includes('closed')) return 'closed';
  if (v.includes('revok')) return 'revoked';
  if (v.includes('suspend')) return 'suspended';
  return v || 'unverified';
}

// Map a raw dataset row to our facility schema. RCFE licenses don't distinguish
// board-and-care vs assisted living, so we infer from capacity (<=6 = board & care).
function mapRow(row) {
  const map = fieldMap();
  const name = pick(row, map.name);
  const license = pick(row, map.license);
  if (!name || !license) return null;
  const capacity = Number(String(pick(row, map.capacity)).replace(/\D/g, '')) || null;
  const type = capacity && capacity <= 6 ? 'board_and_care_RCFE' : 'assisted_living';
  return {
    name,
    type,
    ca_license_number: license,
    license_status: normalizeStatus(pick(row, map.status)),
    street: pick(row, map.street),
    city: pick(row, map.city),
    county: pick(row, map.county),
    zip: pick(row, map.zip),
    capacity,
    levels_of_care: [type],
    contact_phone: pick(row, map.phone),
    known_violations: '', // violations live in a separate CDSS complaints dataset — verify on CDSS
    data_source: 'cdss',
    last_verified_at: Date.now(),
  };
}

// Generic fetch from a configured source: a CKAN resource id (datastore_search
// on data.chhs.ca.gov) or any public CSV/JSON URL.
async function fetchRowsFrom(source, { q, limit } = {}) {
  if (source.resourceId) {
    const base = (source.base || 'https://data.chhs.ca.gov').replace(/\/+$/, '');
    const url = new URL(`${base}/api/3/action/datastore_search`);
    url.searchParams.set('resource_id', source.resourceId);
    url.searchParams.set('limit', String(limit || 200));
    if (q && String(q).trim()) url.searchParams.set('q', String(q).trim());
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`CDSS CKAN ${r.status}`);
    const j = await r.json();
    return (j && j.result && j.result.records) || [];
  }
  if (source.url) {
    const r = await fetch(source.url, { headers: { Accept: 'text/csv, application/json' } });
    if (!r.ok) throw new Error(`CDSS data ${r.status}`);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const text = await r.text();
    if (ct.includes('json') || text.trim().startsWith('[') || text.trim().startsWith('{')) {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : parsed.records || parsed.data || [];
    }
    return csvLib.csvToObjects(text);
  }
  throw new CdssUnavailable('CDSS source not configured.');
}

// ---- Violations / citations (separate CDSS dataset, joined by license #) ----
const VIOL_DEFAULT_MAP = {
  license: ['Facility Number', 'FACILITY_NUMBER', 'facility_number', 'License Number', 'license_number'],
  type: ['Type', 'Citation Type', 'CITATION_TYPE', 'Deficiency Type', 'POC Type', 'Visit Type'],
  date: ['Date', 'Visit Date', 'CITATION_DATE', 'Complaint Date', 'date'],
  description: ['Description', 'DESCRIPTION', 'Deficiency', 'Narrative', 'Citation', 'Section', 'Regulation'],
};
function violFieldMap() {
  if (process.env.CDSS_VIOLATIONS_FIELD_MAP) {
    try { return { ...VIOL_DEFAULT_MAP, ...JSON.parse(process.env.CDSS_VIOLATIONS_FIELD_MAP) }; } catch { /* ignore */ }
  }
  return VIOL_DEFAULT_MAP;
}
function violationsEnabled() {
  return !!(process.env.CDSS_VIOLATIONS_RESOURCE_ID || process.env.CDSS_VIOLATIONS_URL);
}
function mapViolation(row) {
  const m = violFieldMap();
  const license = pick(row, m.license);
  if (!license) return null;
  return { license, type: pick(row, m.type), date: pick(row, m.date), description: pick(row, m.description) };
}
function summarizeViolations(list) {
  if (!list || !list.length) return '';
  const sorted = list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const latest = sorted[0];
  const detail = `${latest.date ? latest.date + ': ' : ''}${[latest.type, latest.description].filter(Boolean).join(' — ')}`.slice(0, 180);
  return `${list.length} citation(s) on file. Latest — ${detail}`;
}
async function fetchViolationsMap({ county, city, limit } = {}) {
  const rows = await fetchRowsFrom(
    { resourceId: process.env.CDSS_VIOLATIONS_RESOURCE_ID, url: process.env.CDSS_VIOLATIONS_URL, base: process.env.CDSS_BASE },
    { q: county || city || '', limit: limit || 2000 }
  );
  const byLicense = {};
  for (const row of rows) {
    const v = mapViolation(row);
    if (!v) continue;
    (byLicense[v.license] = byLicense[v.license] || []).push(v);
  }
  return byLicense;
}

async function fetchFacilities({ county, city, limit } = {}) {
  if (!enabled()) throw new CdssUnavailable('CDSS import is not configured. Set CDSS_RESOURCE_ID or CDSS_DATA_URL.');
  const rows = await fetchRowsFrom(
    { resourceId: process.env.CDSS_RESOURCE_ID, url: process.env.CDSS_DATA_URL, base: process.env.CDSS_BASE },
    { q: county || city || '', limit }
  );

  let violMap = {};
  if (violationsEnabled()) {
    try { violMap = await fetchViolationsMap({ county, city }); } catch { violMap = {}; } // violations are optional
  }

  const c = String(county || '').toLowerCase();
  const ci = String(city || '').toLowerCase();
  const out = [];
  for (const row of rows) {
    const f = mapRow(row);
    if (!f) continue;
    if (c && !(String(f.county).toLowerCase().includes(c))) continue;
    if (ci && !(String(f.city).toLowerCase().includes(ci))) continue;
    if (violMap[f.ca_license_number]) f.known_violations = summarizeViolations(violMap[f.ca_license_number]);
    out.push(f);
  }
  return out;
}

module.exports = { CdssUnavailable, enabled, violationsEnabled, mapRow, mapViolation, summarizeViolations, fetchFacilities };
