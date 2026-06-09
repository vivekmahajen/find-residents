'use strict';

/*
 * Hospital Finder — backend proxy + static server.
 *
 * Why a backend at all? The federal NPI Registry (NPPES) API does not send
 * CORS headers, so a browser cannot call it directly. This tiny Node server
 * proxies the request, filters to hospital taxonomies, de-duplicates, caches,
 * and serves the frontend. Zero npm dependencies — runs on Node 18+.
 *
 * Compliance note: this tool returns only public ORGANIZATIONAL data
 * (hospital name, address, phone, type). It never requests or stores any
 * patient data / PHI.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const NPI_BASE = 'https://npiregistry.cms.hhs.gov/api/';

// Hospital taxonomies most relevant as senior-placement referral sources
// (where discharge planners / case managers send patients needing placement).
const HOSPITAL_TAXONOMIES = [
  'General Acute Care Hospital',
  'Critical Access Hospital',
  'Long Term Care Hospital',
  'Rehabilitation Hospital',
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { t, data }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function queryNpi(params) {
  const url = new URL(NPI_BASE);
  url.searchParams.set('version', '2.1');
  url.searchParams.set('enumeration_type', 'NPI-2'); // organizations only
  url.searchParams.set('limit', '200');
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`NPI API returned ${resp.status}`);
  return resp.json();
}

function mapRecord(rec, fallbackType) {
  const addresses = rec.addresses || [];
  const loc = addresses.find((a) => a.address_purpose === 'LOCATION') || addresses[0] || {};
  const taxonomies = rec.taxonomies || [];
  const primaryTax = taxonomies.find((t) => t.primary) || taxonomies[0] || {};
  const zip = (loc.postal_code || '').slice(0, 5);
  const name = (rec.basic && rec.basic.organization_name) || 'Unknown organization';
  const fullAddress = [
    loc.address_1,
    loc.address_2,
    [loc.city, loc.state].filter(Boolean).join(', '),
    zip,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    npi: rec.number,
    name,
    type: primaryTax.desc || fallbackType,
    city: loc.city || '',
    state: loc.state || '',
    zip,
    phone: loc.telephone_number || '',
    fullAddress,
    mapsUrl:
      'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(`${name} ${fullAddress}`),
  };
}

async function findHospitals({ city, state, zip }) {
  const key = JSON.stringify({ city, state, zip });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;

  const base = zip ? { postal_code: zip } : { city, state };

  // One request per hospital taxonomy, run in parallel, then merge + de-dupe.
  const settled = await Promise.allSettled(
    HOSPITAL_TAXONOMIES.map((tax) =>
      queryNpi({ ...base, taxonomy_description: tax }).then((d) =>
        (d.results || []).map((r) => mapRecord(r, tax))
      )
    )
  );

  // If EVERY request failed, the upstream API is unreachable — surface an error
  // rather than a misleading "no hospitals found".
  if (settled.every((s) => s.status === 'rejected')) {
    const reason = settled[0] && settled[0].reason;
    throw new Error((reason && reason.message) || 'NPI Registry unreachable');
  }

  const byNpi = new Map();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue; // one taxonomy failing is tolerable
    for (const h of s.value) {
      if (!byNpi.has(h.npi)) byNpi.set(h.npi, h);
    }
  }
  const hospitals = [...byNpi.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, { t: Date.now(), data: hospitals });
  return hospitals;
}

async function handleApi(req, res, urlObj) {
  const raw = (urlObj.searchParams.get('location') || '').trim();
  const state = (urlObj.searchParams.get('state') || 'CA').trim().toUpperCase();

  if (!raw) {
    return sendJson(res, 400, { error: 'Enter a city or 5-digit ZIP code.' });
  }

  const zipMatch = raw.match(/^\d{5}/);
  const query = zipMatch
    ? { zip: zipMatch[0] }
    : { city: raw, state };

  try {
    const hospitals = await findHospitals(query);
    return sendJson(res, 200, {
      query: { location: raw, state: zipMatch ? null : state, mode: zipMatch ? 'zip' : 'city' },
      count: hospitals.length,
      hospitals,
    });
  } catch (err) {
    return sendJson(res, 502, {
      error:
        'Could not reach the NPI Registry. Check your network connection and try again.',
      detail: String(err.message || err),
    });
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Prevent path traversal.
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (urlObj.pathname === '/api/hospitals') {
    return handleApi(req, res, urlObj);
  }
  return serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, () => {
  console.log(`Hospital Finder running at http://localhost:${PORT}`);
});
