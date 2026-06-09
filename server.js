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

const AGENCY = require('./agency.config');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Claude model for the pain-point + outreach agents. Override with CLAUDE_MODEL.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

const ROLES = [
  'Case Manager',
  'Discharge Planner',
  'Medical Social Worker',
  'Director of Case Management / Care Coordination',
];

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

// ---------------------------------------------------------------------------
// Strategy feature: two chained Claude agents.
//   Agent 1 (Pain Point Analyst)  → role's real operational pain points
//   Agent 2 (Outreach Strategist) → how our agency makes its case against them
// The Anthropic SDK is loaded lazily so the hospital search keeps working with
// zero dependencies and no API key.
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('Request body too large')); // ~1MB guard
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Thrown when the AI feature isn't configured — handled as a 503 with guidance.
class StrategyUnavailable extends Error {}

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new StrategyUnavailable(
      'Set the ANTHROPIC_API_KEY environment variable to enable pain-point analysis.'
    );
  }
  let mod;
  try {
    mod = require('@anthropic-ai/sdk');
  } catch {
    throw new StrategyUnavailable(
      'The Anthropic SDK is not installed. Run: npm install @anthropic-ai/sdk'
    );
  }
  const Anthropic = mod.default || mod;
  return new Anthropic();
}

// One structured-output Claude call. Returns the parsed JSON object.
async function callClaude(client, { system, user, schema, maxTokens = 2048 }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema },
    },
  });
  const text = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return JSON.parse(text);
}

const COMPLIANCE_RULES = `Compliance rules you must honor:
- Never request, infer, or include any patient's protected health information (PHI). Referrals come only from consenting families or via signed releases the source holds.
- Outreach to hospital staff is professional B2B relationship-building, not consumer marketing. Any consumer-facing copy must disclose that facilities pay the agency, the fee model, services provided, and known facility violations (California RCFE referral-source law).
- Email drafts must be CAN-SPAM compliant: honest subject line, clear sender identity, no deceptive claims.
- Be truthful. Do not fabricate facility data, statistics, outcomes, or credentials. Frame statistics as general industry dynamics, not verified facts about this hospital.`;

const PAIN_POINTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    painPoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'description', 'severity'],
      },
    },
  },
  required: ['painPoints'],
};

const STRATEGY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    valueProps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          painPoint: { type: 'string' },
          howWeHelp: { type: 'string' },
        },
        required: ['painPoint', 'howWeHelp'],
      },
    },
    talkingPoints: { type: 'array', items: { type: 'string' } },
    suggestedFirstStep: { type: 'string' },
    emailDraft: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['subject', 'body'],
    },
    complianceNotes: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'valueProps',
    'talkingPoints',
    'suggestedFirstStep',
    'emailDraft',
    'complianceNotes',
  ],
};

async function runPainPointAnalyst(client, hospital, role) {
  const system = `You are an expert in U.S. hospital case management and discharge-planning operations. You understand the daily pressures these teams face — length of stay, throughput metrics, readmission penalties, hard-to-place patients, and payor complexity. Identify the genuine, role-specific operational pain points that a senior-placement referral agency could realistically help relieve. ${COMPLIANCE_RULES}`;
  const user = `Hospital: ${hospital.name} (${[hospital.city, hospital.state].filter(Boolean).join(', ')})
Hospital type: ${hospital.type || 'Hospital'}
Role we are contacting: ${role}

List 4-6 concrete pain points this role faces that are relevant to placing patients into assisted living / board-and-care / memory care. Rank by severity. Keep each description to 1-2 sentences and specific to this role's workflow.`;
  return callClaude(client, { system, user, schema: PAIN_POINTS_SCHEMA, maxTokens: 1500 });
}

async function runOutreachStrategist(client, hospital, role, painPoints) {
  const system = `You are a business-development strategist for a licensed-compliant California senior-placement / RCFE referral agency. You craft honest, value-first outreach to referral SOURCES (hospital staff). You map the agency's real capabilities to the contact's pain points and never overpromise. ${COMPLIANCE_RULES}`;
  const agency = `Our agency profile:
- Name: ${AGENCY.agencyName}
- Service area: ${AGENCY.serviceArea}
- Levels of care we place: ${AGENCY.levelsOfCare.join('; ')}
- Payors we handle: ${AGENCY.payors.join('; ')}
- Differentiators: ${AGENCY.differentiators.join('; ')}
- Fee model (disclose this): ${AGENCY.feeModel}`;
  const user = `${agency}

Contact: ${role} at ${hospital.name} (${[hospital.city, hospital.state].filter(Boolean).join(', ')}).

Pain points identified for this contact:
${painPoints.map((p, i) => `${i + 1}. [${p.severity}] ${p.title} — ${p.description}`).join('\n')}

Produce the best approach to make a case for our services:
- summary: 1-2 sentence overall angle for this contact.
- valueProps: map each major pain point to specifically how we help (use our differentiators honestly).
- talkingPoints: 4-6 crisp points for a first meeting or call, framed around THEIR metrics (length of stay, safe/timely discharge, readmissions).
- suggestedFirstStep: the single best opening move (e.g., warm intro, a lunch-and-learn offer, capabilities sheet drop) and why.
- emailDraft: a short, CAN-SPAM-compliant first-contact email (subject + body) from our agency to this contact. Identify the sender, be specific to their pains, offer value, no hard sell.
- complianceNotes: reminders specific to this outreach (PHI, vendor registration, required disclosures).`;
  return callClaude(client, { system, user, schema: STRATEGY_SCHEMA, maxTokens: 2600 });
}

async function handleStrategy(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }

  const hospital = body.hospital;
  const role = body.role;
  if (!hospital || !hospital.name) {
    return sendJson(res, 400, { error: 'Missing hospital details.' });
  }
  if (!role) {
    return sendJson(res, 400, { error: 'Choose a role to approach.' });
  }

  try {
    const client = getAnthropicClient();
    // Agent 1 → pain points, then Agent 2 → approach built on them.
    const { painPoints } = await runPainPointAnalyst(client, hospital, role);
    const strategy = await runOutreachStrategist(client, hospital, role, painPoints || []);
    return sendJson(res, 200, { hospital: hospital.name, role, painPoints, strategy });
  } catch (err) {
    if (err instanceof StrategyUnavailable) {
      return sendJson(res, 503, { error: err.message, needsSetup: true });
    }
    return sendJson(res, 502, {
      error: 'The analysis service failed. Check your API key and network, then retry.',
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
  if (urlObj.pathname === '/api/roles') {
    return sendJson(res, 200, { roles: ROLES });
  }
  if (urlObj.pathname === '/api/strategy' && req.method === 'POST') {
    return handleStrategy(req, res);
  }
  return serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, () => {
  console.log(`Hospital Finder running at http://localhost:${PORT}`);
});
