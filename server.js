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
const store = require('./lib/store');
const authlib = require('./lib/auth');
const plans = require('./lib/plans');
const mailer = require('./lib/mailer');
const profileLib = require('./lib/profile');
const deckLib = require('./lib/deck');
const pricing = require('./lib/pricing');
const stripeLib = require('./lib/stripe');
const adminLib = require('./lib/admin');
const redact = require('./lib/redact');
const cryptoLib = require('./lib/crypto');
const matcher = require('./lib/matcher');
const csvLib = require('./lib/csv');
const crm = require('./lib/crm');
const reports = require('./lib/reports');
const cdss = require('./lib/cdss');

const IS_PROD = process.env.NODE_ENV === 'production';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Claude model for the pain-point + outreach agents. Override with CLAUDE_MODEL.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

const NPI_BASE = 'https://npiregistry.cms.hhs.gov/api/';

// Tier 1 referral-source categories. Each maps to the NPI/NUCC taxonomy
// descriptions used to find them, the staff roles you'd approach, and whether
// the relationship is reciprocal (we can also refer families TO them).
const FACILITY_TYPES = {
  hospital: {
    label: 'Hospitals',
    reciprocal: false,
    taxonomies: [
      'General Acute Care Hospital',
      'Critical Access Hospital',
      'Long Term Care Hospital',
      'Rehabilitation Hospital',
    ],
    roles: [
      'Case Manager',
      'Discharge Planner',
      'Medical Social Worker',
      'Director of Case Management / Care Coordination',
    ],
  },
  snf: {
    label: 'Skilled Nursing (SNF)',
    reciprocal: true,
    taxonomies: [
      'Skilled Nursing Facility',
      'Nursing Facility/Intermediate Care Facility',
    ],
    roles: [
      'Social Worker',
      'Discharge Coordinator',
      'Admissions / Marketing Director',
      'Director of Nursing',
    ],
  },
  hospice: {
    label: 'Hospice & Home Health',
    reciprocal: true,
    taxonomies: [
      'Hospice Care, Community Based',
      'Home Health',
    ],
    roles: [
      'Community Liaison',
      'Social Worker',
      'RN Case Manager',
      'Director of Clinical Services',
    ],
  },
};

const DEFAULT_TYPE = 'hospital';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { t, data }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
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

async function findFacilities({ city, state, zip, taxonomies, typeId }) {
  const key = JSON.stringify({ city, state, zip, typeId });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;

  const base = zip ? { postal_code: zip } : { city, state };

  // One request per taxonomy, run in parallel, then merge + de-dupe.
  const settled = await Promise.allSettled(
    taxonomies.map((tax) =>
      queryNpi({ ...base, taxonomy_description: tax }).then((d) =>
        (d.results || []).map((r) => mapRecord(r, tax))
      )
    )
  );

  // If EVERY request failed, the upstream API is unreachable — surface an error
  // rather than a misleading "no facilities found".
  if (settled.every((s) => s.status === 'rejected')) {
    const reason = settled[0] && settled[0].reason;
    throw new Error((reason && reason.message) || 'NPI Registry unreachable');
  }

  const byNpi = new Map();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue; // one taxonomy failing is tolerable
    for (const f of s.value) {
      if (!byNpi.has(f.npi)) byNpi.set(f.npi, f);
    }
  }
  const facilities = [...byNpi.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, { t: Date.now(), data: facilities });
  return facilities;
}

async function handleApi(req, res, urlObj) {
  const raw = (urlObj.searchParams.get('location') || '').trim();
  const state = (urlObj.searchParams.get('state') || 'CA').trim().toUpperCase();
  const typeId = (urlObj.searchParams.get('type') || DEFAULT_TYPE).trim();

  const facilityType = FACILITY_TYPES[typeId];
  if (!facilityType) {
    return sendJson(res, 400, { error: `Unknown facility type "${typeId}".` });
  }
  if (!raw) {
    return sendJson(res, 400, { error: 'Enter a city or 5-digit ZIP code.' });
  }

  const zipMatch = raw.match(/^\d{5}/);
  const query = zipMatch
    ? { zip: zipMatch[0], typeId, taxonomies: facilityType.taxonomies }
    : { city: raw, state, typeId, taxonomies: facilityType.taxonomies };

  try {
    const facilities = await findFacilities(query);
    return sendJson(res, 200, {
      query: {
        location: raw,
        state: zipMatch ? null : state,
        mode: zipMatch ? 'zip' : 'city',
        type: typeId,
        typeLabel: facilityType.label,
      },
      count: facilities.length,
      facilities,
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
- Outreach to facility staff is professional B2B relationship-building, not consumer marketing. Any consumer-facing copy must disclose that facilities pay the agency, the fee model, services provided, and known facility violations (California RCFE referral-source law).
- Email drafts must be CAN-SPAM compliant: honest subject line, clear sender identity, no deceptive claims.
- Be truthful. Do not fabricate facility data, statistics, outcomes, or credentials. Frame statistics as general industry dynamics, not verified facts about this organization.`;

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
    headline: { type: 'string' },
    summary: { type: 'string' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          painPoint: { type: 'string' },
          howWeHelp: { type: 'string' },
          strength: { type: 'string', enum: ['Strong', 'Partial', 'Gap'] },
          proof: { type: 'string' },
        },
        required: ['painPoint', 'howWeHelp', 'strength', 'proof'],
      },
    },
    biggestStrength: { type: 'string' },
    biggestGap: { type: 'string' },
    talkingPoints: { type: 'array', items: { type: 'string' } },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objection: { type: 'string' },
          response: { type: 'string' },
        },
        required: ['objection', 'response'],
      },
    },
    suggestedFirstStep: { type: 'string' },
    savings: {
      type: 'object',
      additionalProperties: false,
      properties: {
        driver: { type: 'string' },
        avoidedDaysPerCase: { type: 'number' },
        casesPerMonth: { type: 'number' },
        costPerDay: { type: 'number' },
        disclaimer: { type: 'string' },
      },
      required: ['driver', 'avoidedDaysPerCase', 'casesPerMonth', 'costPerDay', 'disclaimer'],
    },
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
    'headline',
    'summary',
    'matches',
    'biggestStrength',
    'biggestGap',
    'talkingPoints',
    'objections',
    'suggestedFirstStep',
    'savings',
    'emailDraft',
    'complianceNotes',
  ],
};

// Compute savings totals deterministically from the model's benchmark inputs,
// so the math is always internally consistent (the model supplies the
// industry-estimate inputs; code does the arithmetic).
function computeSavings(s) {
  if (!s) return null;
  const days = Number(s.avoidedDaysPerCase);
  const cases = Number(s.casesPerMonth);
  const cost = Number(s.costPerDay);
  if (![days, cases, cost].every((n) => Number.isFinite(n) && n > 0)) return null;
  const monthly = Math.round(days * cases * cost);
  return {
    driver: String(s.driver || ''),
    avoidedDaysPerCase: days,
    casesPerMonth: cases,
    costPerDay: cost,
    estimatedMonthly: monthly,
    estimatedAnnual: monthly * 12,
    disclaimer: String(s.disclaimer || ''),
  };
}

// Fallback agency context when an agency hasn't built its profile yet.
function fallbackAgencyContext() {
  return [
    `- Service area: ${AGENCY.serviceArea}`,
    `- Levels of care placed: ${AGENCY.levelsOfCare.join('; ')}`,
    `- Payors handled: ${AGENCY.payors.join('; ')}`,
    `- Differentiators: ${AGENCY.differentiators.join('; ')}`,
    `- Fee model (disclose this): ${AGENCY.feeModel}`,
    `- NOTE: This agency has not completed its full profile yet — keep claims conservative and flag where more detail is needed.`,
  ].join('\n');
}

async function runPainPointAnalyst(client, facility, role, facilityType) {
  const system = `You are an expert in U.S. post-acute and senior care operations — hospitals, skilled nursing facilities (SNFs), and hospice/home-health agencies — and the discharge, step-down, and placement workflows their staff face daily (length of stay, throughput, readmission penalties, census pressure, hard-to-place and complex-payor patients). Identify the genuine, role-specific operational pain points that a senior-placement referral agency could realistically help relieve. ${COMPLIANCE_RULES}`;
  const user = `Organization type: ${facilityType.label}
Organization: ${facility.name} (${[facility.city, facility.state].filter(Boolean).join(', ')})
NPI taxonomy: ${facility.type || facilityType.label}
Role we are contacting: ${role}

List 4-6 concrete pain points this specific role faces that are relevant to moving residents/patients into assisted living / board-and-care / memory care. Rank by severity. Keep each description to 1-2 sentences and specific to this role's real workflow at this kind of organization.`;
  return callClaude(client, { system, user, schema: PAIN_POINTS_SCHEMA, maxTokens: 1500 });
}

async function runCaseGenerator(client, facility, role, painPoints, facilityType, agencyContext) {
  const reciprocity = facilityType.reciprocal
    ? `This is a RECIPROCAL relationship: the agency can also refer families TO them when a senior needs skilled-nursing care or hospice. Lead with two-way partnership, not just taking referrals.`
    : `Frame value around their throughput metrics (length of stay, safe and timely discharge, avoidable days, readmissions).`;
  const system = `You are a healthcare business-development strategist for a licensed-compliant California senior-placement / RCFE referral agency. You match the agency's REAL capabilities (from its profile below) to a target organization's discharge/placement pain points and produce a truthful, evidence-based case. ${reciprocity}
TRUTH ONLY: use only capabilities present in the agency profile. Never invent statistics, certifications, facility counts, partners, or outcomes. Where a profile field says "[not provided — verify]", do not claim it. Where the agency cannot address a pain, rate it a Gap honestly — do not stretch a weak capability into Strong. Credibility is the product. ${COMPLIANCE_RULES}`;
  const user = `AGENCY PROFILE (agency name: ${AGENCY.agencyName}):
${agencyContext}

TARGET CONTACT: ${role} at ${facility.name} — a ${facilityType.label} organization (${[facility.city, facility.state].filter(Boolean).join(', ')}).

PAIN POINTS identified for this contact:
${painPoints.map((p, i) => `${i + 1}. [${p.severity}] ${p.title} — ${p.description}`).join('\n')}

Produce a tailored, truthful case:
- headline: one line tying the agency's #1 REAL strength to this contact's #1 pain.
- summary: a 3-4 sentence executive summary — who we are, the specific problems we take off their plate, why us over the status quo.
- matches: for EACH pain point, an object {painPoint, howWeHelp (cite the specific profile capability), strength ("Strong" | "Partial" | "Gap"), proof (the concrete profile evidence, or note what's missing)}. Rate Strong only when a real, provided capability directly resolves the pain; mark Gap honestly when the profile doesn't cover it.
- biggestStrength: one line — the agency's single strongest match.
- biggestGap: one line — the most important pain the agency cannot yet address (or "[none material]" if fully covered).
- talkingPoints: 4-6 crisp points for a first meeting, framed around what THIS role cares about${facilityType.reciprocal ? ' (including reciprocal referrals we can send them)' : ''}.
- objections: the 3 likeliest objections this contact would raise (e.g., "we already use a national referral site", "how are you paid / is this unbiased", "can you really place our hardest cases?") with honest {objection, response} — include the fee disclosure.
- suggestedFirstStep: the single best low-friction next step (e.g., free in-service / lunch-and-learn, sign a referral agreement, pilot on the next few hard-to-place discharges) and why.
- savings: an ILLUSTRATIVE cost-savings estimate for the organization, framed as an industry estimate to validate — never as guaranteed. Provide conservative, clearly-labeled benchmark INPUTS only: {driver (what we reduce, e.g. "avoidable bed-days from hard-to-place Medi-Cal discharges"), avoidedDaysPerCase (avoidable inpatient days removed per hard placement we accelerate — a realistic single number), casesPerMonth (hard-to-place discharges/month we could take — realistic for this org's size), costPerDay (a commonly-cited cost per avoidable inpatient day, typically ~$2,000-$3,000 — pick one conservative value), disclaimer (one sentence stating this is an illustrative industry estimate to validate against their own data, not a guaranteed result)}. Do not compute totals; the system computes them from your inputs.
- emailDraft: a short, CAN-SPAM-compliant first-contact email (subject + body) to this contact. Identify the sender, be specific to their pains, offer value, no hard sell.
- complianceNotes: reminders specific to this outreach (PHI/consent, vendor registration, California referral-source disclosures).`;
  return callClaude(client, { system, user, schema: STRATEGY_SCHEMA, maxTokens: 3500 });
}

async function handleStrategy(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }

  const facility = body.hospital || body.facility;
  const role = body.role;
  const facilityType = FACILITY_TYPES[body.facilityType] || FACILITY_TYPES[DEFAULT_TYPE];
  if (!facility || !facility.name) {
    return sendJson(res, 400, { error: 'Missing facility details.' });
  }
  if (!role) {
    return sendJson(res, 400, { error: 'Choose a role to approach.' });
  }

  // Use the agency's own profile if they've built one; otherwise fall back.
  const user = await currentUser(req);
  const usedProfile = !!(user && user.profile && !profileLib.isEmpty(user.profile));
  const agencyContext = usedProfile ? profileLib.toContext(user.profile) : fallbackAgencyContext();

  // Credit pre-check (a tailored case is a "document"). Admins bypass billing.
  // Free plans must have the credits; paid plans meter overage.
  const admin = adminLib.isAdmin(user);
  const acct = await ensureAccount(user);
  pricing.refreshCycle(acct);
  if (!admin && !pricing.canAfford(acct, 'document')) {
    return sendJson(res, 402, {
      error: 'Out of credits — upgrade your plan or add a top-up to generate a tailored case.',
      account: accountViewFor(user, acct),
    });
  }

  try {
    const client = getAnthropicClient();
    // Agent 1 → pain points, then Agent 2 → profile-matched case built on them.
    const { painPoints } = await runPainPointAnalyst(client, facility, role, facilityType);
    const strategy = await runCaseGenerator(client, facility, role, painPoints || [], facilityType, agencyContext);
    strategy.savingsComputed = computeSavings(strategy.savings);
    const charged = admin ? { mode: 'admin', creditsCharged: 0 } : pricing.charge(acct, 'document');
    if (!admin) await store.updateUser(user.id, { account: acct });
    await emitEvent(user.id, 'case_generated', facility.name, { role });
    if (charged && charged.creditsCharged) await emitEvent(user.id, 'credits_charged', null, { action: 'document', credits: charged.creditsCharged });
    return sendJson(res, 200, {
      facility: facility.name, role, painPoints, strategy, usedProfile,
      charged, account: accountViewFor(user, acct),
    });
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

// Build a PowerPoint pitch deck from an already-generated case (no model call).
async function handleDeck(req, res) {
  const user = await currentUser(req);
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  const facility = body.hospital || body.facility;
  const role = body.role;
  const facilityType = FACILITY_TYPES[body.facilityType] || FACILITY_TYPES[DEFAULT_TYPE];
  const strategy = body.strategy || {};
  const painPoints = body.painPoints || [];
  if (!facility || !facility.name) return sendJson(res, 400, { error: 'Missing facility details.' });
  if (!role) return sendJson(res, 400, { error: 'Missing role.' });

  // Credit pre-check (a deck costs deck credits). Admins bypass billing.
  const admin = adminLib.isAdmin(user);
  const acct = await ensureAccount(user);
  pricing.refreshCycle(acct);
  if (!admin && !pricing.canAfford(acct, 'deck')) {
    return sendJson(res, 402, {
      error: 'Out of credits — upgrade your plan or add a top-up to export a PowerPoint.',
      account: accountViewFor(user, acct),
    });
  }

  // Recompute savings server-side from the model's inputs (don't trust client math).
  const savings = computeSavings(strategy.savings);

  try {
    const buffer = await deckLib.buildDeck({
      agency: AGENCY.agencyName,
      contact: user ? user.email : '',
      hospital: facility,
      role,
      facilityLabel: facilityType.label,
      painPoints,
      strategy,
      savings,
    });
    // Deck built successfully — charge the deck credit now (admins are free).
    if (!admin) {
      pricing.charge(acct, 'deck');
      await store.updateUser(user.id, { account: acct });
      await emitEvent(user.id, 'credits_charged', null, { action: 'deck', credits: 30 });
    }
    await emitEvent(user.id, 'deck_built', facility.name, { role });

    const safeName = String(facility.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck';
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="proposal-${safeName}.pptx"`,
      'Content-Length': buffer.length,
    });
    return res.end(buffer);
  } catch (err) {
    if (err instanceof deckLib.DeckUnavailable) {
      return sendJson(res, 503, { error: err.message, needsSetup: true });
    }
    return sendJson(res, 500, { error: 'Could not build the deck.', detail: String(err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Authentication: signup, login, logout, forgot/reset password.
// Sessions are HttpOnly cookies backed by the JSON store.
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const session = await store.getSession(sid);
  if (!session) return null;
  return store.findById(session.userId);
}

function setSessionCookie(res, token) {
  const secure = IS_PROD ? ' Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${7 * 24 * 60 * 60}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, subscription: u.subscription || null };
}

async function handleSignup(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');

  const uErr = authlib.usernameIssue(username);
  if (uErr) return sendJson(res, 400, { error: uErr });
  if (!authlib.isValidEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
  const pErr = authlib.passwordIssue(password);
  if (pErr) return sendJson(res, 400, { error: pErr });

  if (await store.findByUsername(username)) return sendJson(res, 409, { error: 'That User ID is already taken.' });
  if (await store.findByEmail(email)) return sendJson(res, 409, { error: 'An account with that email already exists.' });

  const user = await store.createUser({ username, email, passwordHash: authlib.hashPassword(password) });
  await ensureAccount(user); // start everyone on the Free plan (30 credits)
  setSessionCookie(res, await store.createSession(user.id));
  return sendJson(res, 201, { user: publicUser(user) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  const identifier = String(body.identifier || '').trim();
  const password = String(body.password || '');
  if (!identifier || !password) return sendJson(res, 400, { error: 'Enter your User ID / email and password.' });

  const user = authlib.isValidEmail(identifier)
    ? await store.findByEmail(identifier)
    : await store.findByUsername(identifier);

  // Generic message — don't reveal whether the account exists.
  if (!user || !authlib.verifyPassword(password, user.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid credentials.' });
  }
  setSessionCookie(res, await store.createSession(user.id));
  return sendJson(res, 200, { user: publicUser(user) });
}

async function handleLogout(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) await store.deleteSession(sid);
  clearSessionCookie(res);
  return sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  return sendJson(res, 200, { user: publicUser(user) });
}

async function handleForgot(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const email = String(body.email || '').trim();

  const user = authlib.isValidEmail(email) ? await store.findByEmail(email) : null;
  let devResetLink;
  if (user) {
    const token = await store.createReset(user.id);
    const link = `${baseUrlFrom(req)}/?token=${token}`;
    await mailer.sendPasswordReset(user.email, link);
    // Surface the link only when no email provider is configured (dev convenience).
    if (!mailer.enabled() && !IS_PROD) devResetLink = link;
  }
  // Always return success — never reveal whether the email is registered.
  return sendJson(res, 200, { ok: true, devResetLink });
}

async function handleReset(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const token = String(body.token || '');
  const password = String(body.password || '');

  const pErr = authlib.passwordIssue(password);
  if (pErr) return sendJson(res, 400, { error: pErr });

  const reset = await store.getReset(token);
  if (!reset) return sendJson(res, 400, { error: 'This reset link is invalid or has expired.' });

  await store.updateUser(reset.userId, { passwordHash: authlib.hashPassword(password) });
  await store.deleteReset(token);
  await store.deleteSessionsForUser(reset.userId); // force re-login everywhere
  return sendJson(res, 200, { ok: true });
}

// ---- Plans & subscription -------------------------------------------------

function handlePlans(req, res) {
  return sendJson(res, 200, {
    states: plans.STATES.map((s) => ({ code: s.code, name: s.name, counties: s.counties })),
    tiers: plans.TIERS,
    maxCounties: plans.MAX_COUNTIES,
  });
}

async function handleGetSubscription(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  return sendJson(res, 200, { subscription: user.subscription || null });
}

async function handleSetSubscription(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });

  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  const stateCode = String(body.state || '').trim().toUpperCase();
  const stateDef = plans.STATES.find((s) => s.code === stateCode);
  if (!stateDef) return sendJson(res, 400, { error: 'Only California (CA) is available right now.' });

  const requested = Array.isArray(body.counties) ? body.counties.map((c) => String(c).trim()) : [];
  const valid = stateDef.counties;
  const selected = [...new Set(requested)].filter((c) => valid.includes(c));

  if (selected.length < 1) return sendJson(res, 400, { error: 'Select at least one county.' });
  if (selected.length > plans.MAX_COUNTIES) {
    return sendJson(res, 400, { error: `Select at most ${plans.MAX_COUNTIES} counties.` });
  }
  const priceMonthly = plans.priceFor(selected.length);
  if (priceMonthly == null) return sendJson(res, 400, { error: 'No plan for that number of counties.' });

  const subscription = {
    state: stateCode,
    counties: selected.sort(),
    priceMonthly,
    updatedAt: new Date().toISOString(),
  };
  await store.updateUser(user.id, { subscription });
  return sendJson(res, 200, { subscription });
}

// ---- Agency profile -------------------------------------------------------

async function handleGetProfile(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  return sendJson(res, 200, { profile: user.profile || null, options: profileLib.OPTIONS });
}

async function handleSetProfile(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const profile = profileLib.sanitize(body);
  await store.updateUser(user.id, { profile });
  return sendJson(res, 200, { profile });
}

// ---- Credit plan & account ------------------------------------------------

async function ensureAccount(user) {
  if (!user.account) {
    user.account = pricing.defaultAccount();
    await store.updateUser(user.id, { account: user.account });
  }
  return user.account;
}

// Account view + admin flag (admins are unlimited / not billed).
function accountViewFor(user, acct) {
  const view = pricing.accountView(acct);
  if (adminLib.isAdmin(user)) {
    view.admin = true;
    view.unlimited = true;
  }
  return view;
}

function handlePricing(req, res) {
  return sendJson(res, 200, { ...pricing.publicModel(), stripeEnabled: stripeLib.enabled() });
}

function baseUrlFrom(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || (IS_PROD ? 'https' : 'http');
  return `${proto}://${req.headers.host || 'localhost'}`;
}

async function handleGetAccount(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const acct = await ensureAccount(user);
  if (pricing.refreshCycle(acct)) await store.updateUser(user.id, { account: acct });
  return sendJson(res, 200, { account: accountViewFor(user, acct) });
}

async function handleSetPlan(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const plan = pricing.planById(String(body.plan || ''));
  if (!plan) return sendJson(res, 400, { error: 'Unknown plan.' });
  if (plan.custom) return sendJson(res, 400, { error: 'Contact sales to set up an Enterprise plan.' });
  // With Stripe live, paid plans must go through checkout; Free is a free downgrade.
  if (stripeLib.enabled() && plan.monthly > 0) {
    return sendJson(res, 400, { error: 'Use secure checkout to subscribe to a paid plan.' });
  }
  const acct = await ensureAccount(user);
  pricing.setPlan(acct, plan.id, !!body.annual);
  await store.updateUser(user.id, { account: acct });
  return sendJson(res, 200, { account: pricing.accountView(acct) });
}

async function handleTopup(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const credits = Number(body.credits);
  const pack = pricing.TOPUP_PACKS.find((t) => t.credits === credits);
  if (!pack) return sendJson(res, 400, { error: 'Unknown top-up pack.' });
  if (stripeLib.enabled()) {
    return sendJson(res, 400, { error: 'Use secure checkout to buy credits.' });
  }
  const acct = await ensureAccount(user);
  pricing.addTopup(acct, pack.credits);
  await store.updateUser(user.id, { account: acct });
  return sendJson(res, 200, { account: pricing.accountView(acct), purchased: pack });
}

// ---- Stripe checkout & webhook --------------------------------------------

async function handleCheckoutPlan(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const plan = pricing.planById(String(body.plan || ''));
  if (!plan || plan.custom || !(plan.monthly > 0)) {
    return sendJson(res, 400, { error: 'Choose a paid plan to check out.' });
  }
  await ensureAccount(user);
  try {
    const url = await stripeLib.createPlanCheckout({
      user, plan, annual: !!body.annual, baseUrl: baseUrlFrom(req),
    });
    return sendJson(res, 200, { url });
  } catch (err) {
    if (err instanceof stripeLib.StripeUnavailable) {
      return sendJson(res, 503, { error: err.message, needsSetup: true });
    }
    return sendJson(res, 502, { error: 'Could not start checkout.', detail: String(err.message || err) });
  }
}

async function handleCheckoutTopup(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const pack = pricing.TOPUP_PACKS.find((t) => t.credits === Number(body.credits));
  if (!pack) return sendJson(res, 400, { error: 'Unknown top-up pack.' });
  await ensureAccount(user);
  try {
    const url = await stripeLib.createTopupCheckout({ user, pack, baseUrl: baseUrlFrom(req) });
    return sendJson(res, 200, { url });
  } catch (err) {
    if (err instanceof stripeLib.StripeUnavailable) {
      return sendJson(res, 503, { error: err.message, needsSetup: true });
    }
    return sendJson(res, 502, { error: 'Could not start checkout.', detail: String(err.message || err) });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function findUserByStripe(predicate) {
  const users = await store.listUsers();
  return users.find((u) => u.account && predicate(u.account)) || null;
}

// Bill accrued usage overage onto the customer's next invoice, then reset it.
async function settleOverage(user) {
  const acct = user.account;
  if (!acct || !(acct.overageUsd > 0)) return;
  if (stripeLib.enabled() && acct.stripeCustomerId) {
    try {
      await stripeLib.addOverageInvoiceItem({ customerId: acct.stripeCustomerId, amountUsd: acct.overageUsd, description: 'Usage overage' });
      acct.overageUsd = 0;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('overage invoicing failed:', e.message);
    }
  }
}

// Grant entitlements after Stripe confirms payment. Idempotent enough for MVP.
async function fulfillStripeEvent(event) {
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    const md = obj.metadata || {};
    const user = md.userId ? await store.findById(md.userId) : null;
    if (!user) return;
    const acct = user.account || pricing.defaultAccount();
    user.account = acct;
    if (md.kind === 'plan') {
      const plan = pricing.planById(md.planId);
      if (plan) {
        pricing.setPlan(acct, plan.id, md.annual === '1');
        acct.pastDue = false;
        acct.stripeCustomerId = obj.customer || acct.stripeCustomerId;
        acct.stripeSubscriptionId = obj.subscription || acct.stripeSubscriptionId;
      }
    } else if (md.kind === 'topup') {
      const credits = Number(md.credits);
      if (credits > 0) pricing.addTopup(acct, credits);
    }
    await store.updateUser(user.id, { account: acct });
  } else if (event.type === 'customer.subscription.deleted') {
    const md = obj.metadata || {};
    let user = md.userId ? await store.findById(md.userId) : null;
    if (!user) user = await findUserByStripe((a) => a.stripeSubscriptionId === obj.id);
    if (user && user.account) {
      pricing.setPlan(user.account, 'free', false);
      user.account.stripeSubscriptionId = null;
      await store.updateUser(user.id, { account: user.account });
    }
  } else if (event.type === 'invoice.paid') {
    // Subscription renewal: bill last cycle's overage, refill credits, clear past-due.
    const user = (await findUserByStripe((a) => a.stripeCustomerId === obj.customer))
      || (obj.subscription ? await findUserByStripe((a) => a.stripeSubscriptionId === obj.subscription) : null);
    if (user && user.account) {
      await settleOverage(user);
      pricing.refillPlan(user.account);
      await store.updateUser(user.id, { account: user.account });
      mailer.sendReceipt(user.email, {
        description: 'Subscription renewal',
        amountUsd: obj.amount_paid != null ? obj.amount_paid / 100 : undefined,
      }).catch(() => {});
    }
  } else if (event.type === 'invoice.payment_failed') {
    const user = (await findUserByStripe((a) => a.stripeCustomerId === obj.customer))
      || (obj.subscription ? await findUserByStripe((a) => a.stripeSubscriptionId === obj.subscription) : null);
    if (user && user.account) {
      user.account.pastDue = true;
      await store.updateUser(user.id, { account: user.account });
      mailer.sendDunning(user.email).catch(() => {});
    }
  }
}

async function handleStripeWebhook(req, res) {
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripeLib.constructEvent(raw, req.headers['stripe-signature']);
  } catch (err) {
    res.writeHead(400);
    return res.end(`Webhook error: ${err.message}`);
  }
  try {
    await fulfillStripeEvent(event);
  } catch {
    // Never fail the webhook on a fulfillment hiccup; Stripe will retry on non-2xx.
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"received":true}');
}

// ---- Privacy-safe client profile renderer (stateless; nothing persisted) ----

async function handleClientProfile(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const result = redact.renderProfile(body.record || {}, body.viewerRole, body.outputMode);
  return sendJson(res, 200, result);
}

// ---- Client / lead tracker (per-agency; redact-on-store + encrypted) -------

const LEAD_STATUSES = ['new', 'contacted', 'touring', 'application', 'placed', 'closed'];

// A short, safe summary for the list view (always matching-masked).
function leadSummary(lead) {
  let record = {};
  try {
    record = cryptoLib.decryptJson(lead.data) || {};
  } catch {
    record = {};
  }
  const view = redact.renderProfile(record, 'matching_only', 'profile').profile;
  return {
    id: lead.id,
    status: lead.status,
    source: lead.source || null,
    createdAt: lead.createdAt,
    reference: record.reference || view.reference,
    name: view.name,
    location: view.location,
    carePreference: view.carePreference.type,
    age: view.age,
  };
}

async function handleCreateLead(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  const { record, withheld } = redact.toStorableRecord(body.record || {});
  const status = LEAD_STATUSES.includes(body.status) ? body.status : 'new';
  const source = body.sourceHospital ? String(body.sourceHospital).slice(0, 200) : null;
  const lead = await store.createLead({
    userId: user.id,
    status,
    source,
    data: cryptoLib.encryptJson(record),
  });
  await emitEvent(user.id, 'lead_created', lead.id, { source });
  return sendJson(res, 201, { lead: leadSummary(lead), withheld, encrypted: cryptoLib.enabled() });
}

async function handleListLeads(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const leads = await store.listLeads(user.id);
  return sendJson(res, 200, {
    leads: leads.map(leadSummary),
    encrypted: cryptoLib.enabled(),
    statuses: LEAD_STATUSES,
  });
}

async function handleGetLead(req, res, id, urlObj) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const lead = await store.getLead(id);
  if (!lead || lead.userId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  const record = cryptoLib.decryptJson(lead.data) || {};
  const rendered = redact.renderProfile(
    record,
    urlObj.searchParams.get('viewerRole'),
    urlObj.searchParams.get('outputMode')
  );
  return sendJson(res, 200, {
    lead: { id: lead.id, status: lead.status, source: lead.source, createdAt: lead.createdAt },
    rendered,
  });
}

async function handleUpdateLead(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const lead = await store.getLead(id);
  if (!lead || lead.userId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  const prevStatus = lead.status; // capture before update (file store aliases the object)
  const patch = {};
  if (body.status && LEAD_STATUSES.includes(body.status)) patch.status = body.status;
  if ('sourceHospital' in body) patch.source = body.sourceHospital ? String(body.sourceHospital).slice(0, 200) : null;
  if (body.record) {
    const { record } = redact.toStorableRecord(body.record);
    patch.data = cryptoLib.encryptJson(record);
  }
  const updated = await store.updateLead(id, patch);

  // Funnel events on a stage change.
  if (patch.status && patch.status !== prevStatus) {
    const src = updated.source || null;
    await emitEvent(user.id, 'lead_stage_changed', id, { to: patch.status, source: src });
    if (patch.status === 'touring') await emitEvent(user.id, 'tour_scheduled', id, { source: src });
    if (patch.status === 'application') await emitEvent(user.id, 'application', id, { source: src });
    if (patch.status === 'placed') await emitEvent(user.id, 'placement_made', id, { source: src, revenue: Number(body.revenue) || 0 });
  }
  return sendJson(res, 200, { lead: leadSummary(updated) });
}

async function handleDeleteLead(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const lead = await store.getLead(id);
  if (!lead || lead.userId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  await store.deleteLead(id);
  return sendJson(res, 200, { ok: true });
}

// ---- Facility inventory + resident matcher (Workstream 1) ------------------

const FACILITY_TYPES_LIST = ['board_and_care_RCFE', 'assisted_living', 'memory_care', 'independent_living', 'SNF'];

function arrField(x) {
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean);
  return String(x || '').split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
}
function numField(x) {
  if (x == null || x === '') return null;
  const n = Number(String(x).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function normalizeFacility(b, agencyId) {
  return {
    agencyId,
    name: String(b.name || '').trim(),
    type: String(b.type || '').trim(),
    street: String(b.street || '').trim(),
    city: String(b.city || '').trim(),
    county: String(b.county || '').trim(),
    zip: String(b.zip || '').trim(),
    lat: numField(b.lat),
    lng: numField(b.lng),
    ca_license_number: String(b.ca_license_number || b.license || '').trim(),
    license_status: String(b.license_status || '').trim(),
    known_violations: String(b.known_violations || '').trim(),
    capacity: numField(b.capacity),
    availability_status: String(b.availability_status || 'unknown').trim().toLowerCase(),
    availability_as_of: b.availability_as_of || null,
    levels_of_care: arrField(b.levels_of_care),
    payors_accepted: arrField(b.payors_accepted),
    price_min: numField(b.price_min),
    price_max: numField(b.price_max),
    room_types: arrField(b.room_types),
    languages: arrField(b.languages),
    capabilities: arrField(b.capabilities),
    amenities: arrField(b.amenities),
    contact_name: String(b.contact_name || '').trim(),
    contact_phone: String(b.contact_phone || '').trim(),
    contact_email: String(b.contact_email || '').trim(),
    fee_paid_by_facility: b.fee_paid_by_facility != null && b.fee_paid_by_facility !== '' ? b.fee_paid_by_facility : null,
    notes: String(b.notes || '').trim(),
    data_source: String(b.data_source || 'manual').trim(),
    last_verified_at: b.last_verified_at || null,
  };
}

async function handleListFacilities(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const facilities = await store.listFacilities(user.id);
  return sendJson(res, 200, { facilities, types: FACILITY_TYPES_LIST });
}

async function handleCreateFacility(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  const fac = normalizeFacility(body, user.id);
  if (!fac.name || !fac.type) return sendJson(res, 400, { error: 'Facility name and type are required.' });
  const created = await store.createFacility(fac);
  return sendJson(res, 201, { facility: created });
}

async function handleGetFacility(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const fac = await store.getFacility(id);
  if (!fac || (fac.agencyId != null && fac.agencyId !== user.id)) return sendJson(res, 404, { error: 'Not found.' });
  return sendJson(res, 200, { facility: fac });
}

async function handleUpdateFacility(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const fac = await store.getFacility(id);
  if (!fac || fac.agencyId !== user.id) return sendJson(res, 404, { error: 'Not found.' }); // shared seed is read-only
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  // Quick availability-only updates are allowed without re-sending everything.
  const patch = Object.keys(body).length <= 2 && (body.availability_status || body.availability_as_of)
    ? { availability_status: String(body.availability_status || fac.availability_status).toLowerCase(), availability_as_of: body.availability_as_of || Date.now() }
    : { ...normalizeFacility(body, user.id) };
  const updated = await store.updateFacility(id, patch);
  return sendJson(res, 200, { facility: updated });
}

async function handleDeleteFacility(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const fac = await store.getFacility(id);
  if (!fac || fac.agencyId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  await store.deleteFacility(id);
  return sendJson(res, 200, { ok: true });
}

async function handleImportFacilities(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body || !body.csv) return sendJson(res, 400, { error: 'Provide CSV text in { "csv": "..." }.' });
  const rows = csvLib.csvToObjects(body.csv);
  // Detect a CHHS/CDSS-style export (e.g. "Facility Name" / "Facility Number"
  // columns) pasted directly. Those won't match our facility column names, so
  // route each row through the CDSS mapper first. This lets a user who can't be
  // reached by a server-side CHHS fetch just download the file in their browser
  // and paste it here.
  const first = rows[0] || {};
  const looksCdss = ['Facility Name', 'FACILITY_NAME', 'facility_name', 'Facility Number', 'FACILITY_NUMBER'].some((k) => k in first);
  let created = 0;
  const errors = [];
  for (const row of rows) {
    const src = looksCdss ? cdss.mapRow(row) : row;
    if (!src) { errors.push(`Skipped row (missing facility name/number): ${row['Facility Name'] || row.name || '(blank)'}`); continue; }
    const fac = normalizeFacility(src, user.id);
    if (!fac.name || !fac.type) { errors.push(`Skipped row (missing name/type): ${src.name || row.name || '(blank)'}`); continue; }
    await store.createFacility(fac);
    created += 1;
  }
  return sendJson(res, 200, { created, errors, format: looksCdss ? 'cdss' : 'facility' });
}

const SAMPLE_FACILITIES = [
  { name: 'Sample Care Home — Sacramento (demo)', type: 'board_and_care_RCFE', city: 'Sacramento', county: 'Sacramento', zip: '95823', ca_license_number: 'DEMO-000001', license_status: 'licensed', availability_status: 'open', levels_of_care: ['board_and_care_RCFE', 'memory_care'], payors_accepted: ['private', 'Medi-Cal'], price_min: 3000, price_max: 4500, room_types: ['private', 'shared'], languages: ['english', 'spanish'], capabilities: ['memory_care', 'two_person_transfer'], fee_paid_by_facility: 'one month rent', data_source: 'sample', notes: 'DEMO DATA — replace with verified facility.' },
  { name: 'Sample Assisted Living — Roseville (demo)', type: 'assisted_living', city: 'Roseville', county: 'Placer', zip: '95661', ca_license_number: 'DEMO-000002', license_status: 'licensed', availability_status: 'limited', levels_of_care: ['assisted_living'], payors_accepted: ['private', 'LTC_insurance'], price_min: 4500, price_max: 6500, room_types: ['studio', 'one_bedroom'], languages: ['english'], capabilities: ['oxygen', 'pet_friendly'], fee_paid_by_facility: 'one month rent', data_source: 'sample', notes: 'DEMO DATA — replace with verified facility.' },
  { name: 'Sample Memory Care — Elk Grove (demo)', type: 'memory_care', city: 'Elk Grove', county: 'Sacramento', zip: '95624', ca_license_number: 'DEMO-000003', license_status: 'licensed', availability_status: 'open', levels_of_care: ['memory_care'], payors_accepted: ['private', 'Medi-Cal', 'ALW'], price_min: 4000, price_max: 5500, room_types: ['private'], languages: ['english'], capabilities: ['memory_care', 'behavioral'], fee_paid_by_facility: 'one month rent', data_source: 'sample', notes: 'DEMO DATA — replace with verified facility.' },
];

async function handleCdssImport(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => ({}));
  if (!cdss.enabled()) {
    return sendJson(res, 503, { error: 'CDSS import is not configured. Set CDSS_RESOURCE_ID or CDSS_DATA_URL (public CHHS licensing dataset).', needsSetup: true });
  }
  try {
    const limit = Math.min(Number(body.limit) || 200, 1000);
    if (body.dryRun) {
      const d = await cdss.probeSource({ county: body.county, city: body.city, limit });
      return sendJson(res, 200, {
        count: d.countyMatched,
        preview: d.facilities.slice(0, 10),
        diagnostic: { sourceType: d.sourceType, fetchedRows: d.fetchedRows, columns: d.columns, mappedRows: d.mappedRows, countyMatched: d.countyMatched, countiesSeen: d.countiesSeen, sampleRaw: d.sampleRaw },
      });
    }
    const facs = await cdss.fetchFacilities({ county: body.county, city: body.city, limit });
    let created = 0;
    for (const f of facs) {
      await store.createFacility(normalizeFacility(f, user.id));
      created += 1;
    }
    // Imported nothing? Attach the same diagnostic the dry-run gives, so the
    // reason (HTML page vs wrong columns vs county typo) is visible without
    // making the user re-run Preview separately.
    if (created === 0) {
      let diagnostic = null;
      try {
        const d = await cdss.probeSource({ county: body.county, city: body.city, limit });
        diagnostic = { sourceType: d.sourceType, fetchedRows: d.fetchedRows, columns: d.columns, mappedRows: d.mappedRows, countyMatched: d.countyMatched, countiesSeen: d.countiesSeen, sampleRaw: d.sampleRaw };
      } catch { /* leave null */ }
      return sendJson(res, 200, { created, diagnostic });
    }
    return sendJson(res, 200, { created });
  } catch (err) {
    if (err instanceof cdss.CdssUnavailable) return sendJson(res, 503, { error: err.message, needsSetup: true });
    return sendJson(res, 502, { error: 'CDSS fetch failed. Verify the dataset URL/resource id and column mapping.', detail: String(err.message || err) });
  }
}

// Read-only config diagnostic: reports whether the running deployment can see
// the CDSS env vars. Returns booleans only — never the values themselves.
async function handleCdssStatus(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  return sendJson(res, 200, {
    configured: cdss.enabled(),
    hasResourceId: !!process.env.CDSS_RESOURCE_ID,
    hasDataUrl: !!process.env.CDSS_DATA_URL,
    violationsConfigured: cdss.violationsEnabled(),
    hasViolationsUrl: !!process.env.CDSS_VIOLATIONS_URL,
    hasViolationsResourceId: !!process.env.CDSS_VIOLATIONS_RESOURCE_ID,
  });
}

async function handleSampleFacilities(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  let created = 0;
  for (const s of SAMPLE_FACILITIES) {
    await store.createFacility(normalizeFacility(s, user.id));
    created += 1;
  }
  return sendJson(res, 200, { created });
}

async function handleMatch(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  let lead = null;
  let profile;
  if (body.leadId) {
    lead = await store.getLead(body.leadId);
    if (!lead || lead.userId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
    const rec = cryptoLib.decryptJson(lead.data) || {};
    profile = matcher.profileFromRecord(rec);
  } else {
    profile = matcher.profileFromRecord(body.profile || {});
  }

  const facilities = await store.listFacilities(user.id);
  const results = matcher.matchFacilities(profile, facilities);
  await emitEvent(user.id, 'match_run', lead ? lead.id : null, { count: results.length });

  // Optionally attach the shortlist (ids + scores only — no PII) onto the lead.
  if (body.save && lead) {
    const rec = cryptoLib.decryptJson(lead.data) || {};
    rec.matchShortlist = results.slice(0, 10).map((r) => ({ facilityId: r.facilityId, name: r.name, score: r.score, recommended: r.recommended }));
    await store.updateLead(lead.id, { data: cryptoLib.encryptJson(rec) });
  }

  return sendJson(res, 200, { profile, count: results.length, results });
}

// ---- Event instrumentation + reporting (Workstream 4) ----------------------

// Lightweight, guarded event write. Awaited (a single insert) so it persists on
// serverless, but a failure never breaks the request.
async function emitEvent(agencyId, type, entityRef, metadata) {
  try {
    await store.createRecord({ agencyId, kind: 'event', data: { type, entityRef: entityRef || null, metadata: metadata || {} } });
  } catch {
    // never block the request on analytics
  }
}

async function handleReports(req, res, urlObj) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const days = Number(urlObj.searchParams.get('days'));
  const events = await store.listRecords(user.id, 'event');
  return sendJson(res, 200, reports.buildReport(events, { now: Date.now(), days: Number.isFinite(days) ? days : 30 }));
}

async function handleOnboarding(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const [facilities, leads, events, contacts] = await Promise.all([
    store.listFacilities(user.id),
    store.listLeads(user.id),
    store.listRecords(user.id, 'event'),
    store.listRecords(user.id, 'contact'),
  ]);
  const hasEvent = (t) => events.some((e) => e.data.type === t);
  const steps = [
    { key: 'profile', label: 'Build your agency profile', done: !!(user.profile && !profileLib.isEmpty(user.profile)), hint: 'Agency profile panel' },
    { key: 'facilities', label: 'Add or load care-home inventory', done: facilities.length > 0, hint: 'Care-home inventory → “Load CA demo data”' },
    { key: 'source', label: 'Search a referral source', done: hasEvent('source_searched'), hint: 'Find referral sources' },
    { key: 'contact', label: 'Add a decision-maker contact', done: contacts.length > 0, hint: 'Outreach CRM → Contacts' },
    { key: 'lead', label: 'Save a client / lead', done: leads.length > 0, hint: 'Client profile → “Save to my clients”' },
    { key: 'match', label: 'Run a care-home match', done: hasEvent('match_run'), hint: 'Click “Match” on a saved client' },
  ];
  return sendJson(res, 200, { steps, complete: steps.every((s) => s.done) });
}

async function handleAdminUsage(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  if (!adminLib.isAdmin(user)) return sendJson(res, 403, { error: 'Admins only.' });
  const events = await store.listAllRecords('event');
  const users = await store.listUsers();
  return sendJson(res, 200, reports.buildAdminUsage(events, users, Date.now()));
}

// ---- Lightweight CRM: contacts, tasks, activities, sequences (Workstream 3) -

const DAY_MS = 24 * 60 * 60 * 1000;

function contactPublic(rec) {
  let pii = {};
  try { pii = cryptoLib.decryptJson(rec.data.enc) || {}; } catch { pii = {}; }
  return {
    id: rec.id,
    sourceRef: rec.data.sourceRef,
    consentStatus: rec.data.consentStatus || 'unknown',
    createdAt: rec.createdAt,
    name: pii.name || '',
    title: pii.title || '',
    email: pii.email || '',
    phone: pii.phone || '',
    notes: pii.notes || '',
  };
}

// --- Contacts (PII: redact-on-store + encrypted) ---
async function handleListContacts(req, res, sourceRef) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const recs = await store.listRecords(user.id, 'contact');
  const contacts = recs.filter((r) => !sourceRef || r.data.sourceRef === sourceRef).map(contactPublic);
  return sendJson(res, 200, { contacts });
}
async function handleCreateContact(req, res, sourceRef) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
  if (!String(body.name || '').trim()) return sendJson(res, 400, { error: 'Contact name is required.' });
  const pii = {
    name: String(body.name || '').trim(),
    title: String(body.title || '').trim(),
    email: String(body.email || '').trim(),
    phone: String(body.phone || '').trim(),
    notes: redact.scrub(body.notes || '').text,
  };
  const rec = await store.createRecord({
    agencyId: user.id,
    kind: 'contact',
    data: {
      sourceRef: String(sourceRef || body.sourceRef || '').trim(),
      contactEmail: pii.email.toLowerCase(),
      consentStatus: String(body.consentStatus || 'unknown'),
      enc: cryptoLib.encryptJson(pii),
    },
  });
  await emitEvent(user.id, 'contact_added', rec.data.sourceRef, {});
  return sendJson(res, 201, { contact: contactPublic(rec) });
}
async function handleDeleteContact(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const rec = await store.getRecord(id);
  if (!rec || rec.kind !== 'contact' || rec.agencyId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  await store.deleteRecord(id);
  return sendJson(res, 200, { ok: true });
}

// --- Tasks ---
async function handleListTasks(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const recs = await store.listRecords(user.id, 'task');
  const tasks = recs.map((r) => ({ id: r.id, ...r.data, createdAt: r.createdAt }));
  return sendJson(res, 200, { tasks, buckets: crm.bucketTasks(recs, Date.now()) });
}
async function handleCreateTask(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body || !String(body.title || '').trim()) return sendJson(res, 400, { error: 'Task title is required.' });
  const dueAt = body.dueAt ? new Date(body.dueAt).getTime() : null;
  const rec = await store.createRecord({
    agencyId: user.id,
    kind: 'task',
    data: {
      title: String(body.title).trim(),
      dueAt: Number.isFinite(dueAt) ? dueAt : null,
      linkedType: body.linkedType || null,
      linkedRef: body.linkedRef || null,
      notes: redact.scrub(body.notes || '').text,
      status: 'open',
      reminderSentAt: null,
    },
  });
  return sendJson(res, 201, { task: { id: rec.id, ...rec.data } });
}
async function handleUpdateTask(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const rec = await store.getRecord(id);
  if (!rec || rec.kind !== 'task' || rec.agencyId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  const body = await readJsonBody(req).catch(() => ({}));
  const data = { ...rec.data };
  if (body.status === 'done' || body.status === 'open') data.status = body.status;
  if (body.title) data.title = String(body.title).trim();
  if ('dueAt' in body) { const t = body.dueAt ? new Date(body.dueAt).getTime() : null; data.dueAt = Number.isFinite(t) ? t : null; }
  const updated = await store.updateRecord(id, { data });
  return sendJson(res, 200, { task: { id, ...updated.data } });
}
async function handleDeleteTask(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const rec = await store.getRecord(id);
  if (!rec || rec.kind !== 'task' || rec.agencyId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  await store.deleteRecord(id);
  return sendJson(res, 200, { ok: true });
}

// --- Activities (append-only timeline) ---
async function handleCreateActivity(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body || !body.entityRef) return sendJson(res, 400, { error: 'entityRef required.' });
  const rec = await store.createRecord({
    agencyId: user.id,
    kind: 'activity',
    data: {
      entityType: body.entityType || 'source',
      entityRef: String(body.entityRef),
      type: ['call', 'email', 'meeting', 'note'].includes(body.type) ? body.type : 'note',
      note: redact.scrub(body.note || '').text,
      author: user.username,
    },
  });
  await emitEvent(user.id, 'activity_logged', String(body.entityRef), { type: rec.data.type });
  return sendJson(res, 201, { activity: { id: rec.id, ...rec.data, createdAt: rec.createdAt } });
}
async function handleListActivities(req, res, urlObj) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const entityRef = urlObj.searchParams.get('entityRef');
  const recs = await store.listRecords(user.id, 'activity');
  const activities = recs
    .filter((r) => !entityRef || r.data.entityRef === entityRef)
    .map((r) => ({ id: r.id, ...r.data, createdAt: r.createdAt }));
  return sendJson(res, 200, { activities });
}

// --- Sequences + enrollments ---
async function handleListSequences(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const recs = await store.listRecords(user.id, 'sequence');
  return sendJson(res, 200, { sequences: recs.map((r) => ({ id: r.id, ...r.data })) });
}
async function handleCreateSequence(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => null);
  if (!body || !String(body.name || '').trim() || !Array.isArray(body.steps) || !body.steps.length) {
    return sendJson(res, 400, { error: 'Provide a name and at least one step.' });
  }
  const steps = body.steps.slice(0, 10).map((s) => ({
    channel: s.channel === 'manual_task' ? 'manual_task' : 'email',
    subject: String(s.subject || '').slice(0, 200),
    body: String(s.body || '').slice(0, 4000),
    delayDays: Math.max(0, Number(s.delayDays) || 0),
  }));
  const rec = await store.createRecord({ agencyId: user.id, kind: 'sequence', data: { name: String(body.name).trim(), steps } });
  return sendJson(res, 201, { sequence: { id: rec.id, ...rec.data } });
}
async function handleEnroll(req, res, seqId) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const body = await readJsonBody(req).catch(() => ({}));
  const seq = await store.getRecord(seqId);
  if (!seq || seq.kind !== 'sequence' || seq.agencyId !== user.id) return sendJson(res, 404, { error: 'Sequence not found.' });
  const contact = await store.getRecord(body.contactId);
  if (!contact || contact.kind !== 'contact' || contact.agencyId !== user.id) return sendJson(res, 404, { error: 'Contact not found.' });
  if (contact.data.consentStatus !== 'opted_in') {
    return sendJson(res, 400, { error: 'Contact must have consent (consentStatus = opted_in) before enrolling in an email sequence.' });
  }
  const email = contact.data.contactEmail;
  if (!email) return sendJson(res, 400, { error: 'Contact has no email.' });
  const firstDelay = (seq.data.steps[0] && seq.data.steps[0].delayDays) || 0;
  const rec = await store.createRecord({
    agencyId: user.id,
    kind: 'enrollment',
    data: { sequenceId: seqId, sequenceName: seq.data.name, contactId: contact.id, contactEmail: email, status: 'active', currentStep: 0, nextRunAt: Date.now() + firstDelay * DAY_MS, enrolledAt: Date.now() },
  });
  await emitEvent(user.id, 'sequence_enrolled', contact.id, { sequence: seq.data.name });
  return sendJson(res, 201, { enrollment: { id: rec.id, ...rec.data } });
}
async function handleListEnrollments(req, res) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const recs = await store.listRecords(user.id, 'enrollment');
  return sendJson(res, 200, { enrollments: recs.map((r) => ({ id: r.id, ...r.data })) });
}
async function handleStopEnrollment(req, res, id) {
  const user = await currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
  const rec = await store.getRecord(id);
  if (!rec || rec.kind !== 'enrollment' || rec.agencyId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
  await store.updateRecord(id, { data: { ...rec.data, status: 'stopped', stoppedReason: 'manual' } });
  return sendJson(res, 200, { ok: true });
}

// --- Unsubscribe (public; signed link) ---
async function handleUnsubscribe(req, res, urlObj) {
  const email = String(urlObj.searchParams.get('e') || '').trim().toLowerCase();
  const agencyId = urlObj.searchParams.get('a') || '';
  const token = urlObj.searchParams.get('t') || '';
  const ok = email && crm.verifyUnsub(email, agencyId, token);
  if (ok) {
    const existing = (await store.listRecords(agencyId, 'unsubscribe')).find((r) => r.data.email === email);
    if (!existing) await store.createRecord({ agencyId, kind: 'unsubscribe', data: { email } });
    // Stop any active enrollments for this email.
    for (const e of await store.listRecords(agencyId, 'enrollment')) {
      if (e.data.status === 'active' && String(e.data.contactEmail).toLowerCase() === email) {
        await store.updateRecord(e.id, { data: { ...e.data, status: 'stopped', stoppedReason: 'unsubscribed' } });
      }
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:480px;margin:4rem auto;text-align:center"><h2>${ok ? 'You have been unsubscribed.' : 'Invalid unsubscribe link.'}</h2><p>${ok ? 'You will no longer receive sequence emails.' : 'Please contact the sender.'}</p></body>`);
}

// --- Cron engine (due reminders + sequence steps) ---
async function runDueReminders(now) {
  let sent = 0;
  for (const t of await store.listAllRecords('task')) {
    if (t.data.status === 'done' || t.data.reminderSentAt || !t.data.dueAt || t.data.dueAt > now) continue;
    const owner = await store.findById(t.agencyId);
    if (owner) {
      mailer.send({ to: owner.email, subject: `Task due: ${t.data.title}`, category: 'transactional', text: `Reminder: "${t.data.title}" is due. Open your dashboard to complete it.`, html: `<p>Reminder: <strong>${t.data.title}</strong> is due.</p>` }).catch(() => {});
    }
    await store.updateRecord(t.id, { data: { ...t.data, reminderSentAt: now } });
    sent += 1;
  }
  return sent;
}

async function runDueSequences(now) {
  let steps = 0;
  let stopped = 0;
  const unsub = new Set((await store.listAllRecords('unsubscribe')).map((u) => `${u.agencyId}|${String(u.data.email).toLowerCase()}`));
  const base = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') : 'http://localhost:3000';

  for (const e of await store.listAllRecords('enrollment')) {
    const d = e.data;
    if (d.status !== 'active' || d.nextRunAt > now) continue;
    const email = String(d.contactEmail || '').toLowerCase();
    if (unsub.has(`${e.agencyId}|${email}`)) {
      await store.updateRecord(e.id, { data: { ...d, status: 'stopped', stoppedReason: 'unsubscribed' } });
      stopped += 1;
      continue;
    }
    const seq = await store.getRecord(d.sequenceId);
    if (!seq) { await store.updateRecord(e.id, { data: { ...d, status: 'stopped', stoppedReason: 'sequence_deleted' } }); continue; }
    const step = seq.data.steps[d.currentStep];
    if (!step) { await store.updateRecord(e.id, { data: { ...d, status: 'completed' } }); continue; }

    if (step.channel === 'manual_task') {
      await store.createRecord({ agencyId: e.agencyId, kind: 'task', data: { title: `[Sequence] ${step.subject || 'Call/SMS step'}`, dueAt: now, linkedType: 'contact', linkedRef: d.contactId, notes: step.body, status: 'open', reminderSentAt: null } });
    } else {
      const t = crm.unsubToken(email, e.agencyId);
      const unsubscribeUrl = `${base}/api/unsubscribe?e=${encodeURIComponent(email)}&a=${encodeURIComponent(e.agencyId)}&t=${t}`;
      mailer.send({ to: d.contactEmail, subject: step.subject || 'Following up', category: 'marketing', text: step.body, html: `<p>${String(step.body || '').replace(/\n/g, '<br>')}</p>`, unsubscribeUrl }).catch(() => {});
      await emitEvent(e.agencyId, 'email_sent', d.contactId, { sequence: d.sequenceName });
    }
    const next = d.currentStep + 1;
    const done = next >= seq.data.steps.length;
    const nextDelay = done ? 0 : (seq.data.steps[next].delayDays || 0);
    await store.updateRecord(e.id, { data: { ...d, currentStep: next, status: done ? 'completed' : 'active', nextRunAt: now + nextDelay * DAY_MS } });
    steps += 1;
  }
  return { steps, stopped };
}

async function runCron(now = Date.now()) {
  const reminders = await runDueReminders(now);
  const seq = await runDueSequences(now);
  return { reminders, sequenceSteps: seq.steps, sequencesStopped: seq.stopped };
}

function cronAuthorized(req, urlObj) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev: no secret configured
  if ((req.headers.authorization || '') === `Bearer ${secret}`) return true;
  return urlObj.searchParams.get('key') === secret;
}

async function handleCron(req, res, urlObj) {
  if (!cronAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'Unauthorized.' });
  const result = await runCron();
  return sendJson(res, 200, { ok: true, ...result });
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

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function route(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = urlObj;
  const method = req.method;

  // --- Page routing: login is the landing page ---
  if (pathname === '/') {
    return (await currentUser(req)) ? redirect(res, '/app') : serveStatic(req, res, '/index.html');
  }
  if (pathname === '/app') {
    return (await currentUser(req)) ? serveStatic(req, res, '/app.html') : redirect(res, '/');
  }
  // New SPA app shell (beta). Served for the shell root and all deep links; the
  // client router + auth guard handle the rest (APIs remain server-enforced).
  if (pathname === '/shell' || pathname.startsWith('/shell/')) {
    return serveStatic(req, res, '/shell.html');
  }

  // --- Auth API (public) ---
  if (pathname === '/api/auth/signup' && method === 'POST') return handleSignup(req, res);
  if (pathname === '/api/auth/login' && method === 'POST') return handleLogin(req, res);
  if (pathname === '/api/auth/logout' && method === 'POST') return handleLogout(req, res);
  if (pathname === '/api/auth/me') return handleMe(req, res);
  if (pathname === '/api/auth/forgot' && method === 'POST') return handleForgot(req, res);
  if (pathname === '/api/auth/reset' && method === 'POST') return handleReset(req, res);

  // --- Plans (public) and subscription (auth) ---
  if (pathname === '/api/plans') return handlePlans(req, res);
  if (pathname === '/api/subscription' && method === 'GET') return handleGetSubscription(req, res);
  if (pathname === '/api/subscription' && method === 'POST') return handleSetSubscription(req, res);

  // --- Agency profile (auth) ---
  if (pathname === '/api/profile' && method === 'GET') return handleGetProfile(req, res);
  if (pathname === '/api/profile' && method === 'POST') return handleSetProfile(req, res);

  // --- Privacy-safe client profile renderer (auth, free, stateless) ---
  if (pathname === '/api/client-profile' && method === 'POST') {
    if (!(await currentUser(req))) return sendJson(res, 401, { error: 'Please log in.' });
    return handleClientProfile(req, res);
  }

  // --- Facility inventory + matcher (auth) ---
  if (pathname === '/api/facilities' && method === 'GET') return handleListFacilities(req, res);
  if (pathname === '/api/facilities' && method === 'POST') return handleCreateFacility(req, res);
  if (pathname === '/api/facilities/import' && method === 'POST') return handleImportFacilities(req, res);
  if (pathname === '/api/facilities/sample' && method === 'POST') return handleSampleFacilities(req, res);
  if (pathname === '/api/facilities/cdss-import' && method === 'POST') return handleCdssImport(req, res);
  if (pathname === '/api/cdss-status' && method === 'GET') return handleCdssStatus(req, res);
  if (pathname.startsWith('/api/facilities/')) {
    const id = decodeURIComponent(pathname.slice('/api/facilities/'.length));
    if (method === 'GET') return handleGetFacility(req, res, id);
    if (method === 'POST' || method === 'PUT') return handleUpdateFacility(req, res, id);
    if (method === 'DELETE') return handleDeleteFacility(req, res, id);
  }
  if (pathname === '/api/match' && method === 'POST') return handleMatch(req, res);

  // --- CRM: contacts, tasks, activities, sequences (auth) ---
  const contactsMatch = pathname.match(/^\/api\/sources\/([^/]+)\/contacts$/);
  if (contactsMatch) {
    const ref = decodeURIComponent(contactsMatch[1]);
    if (method === 'GET') return handleListContacts(req, res, ref);
    if (method === 'POST') return handleCreateContact(req, res, ref);
  }
  if (pathname.startsWith('/api/contacts/')) {
    const id = decodeURIComponent(pathname.slice('/api/contacts/'.length));
    if (method === 'DELETE') return handleDeleteContact(req, res, id);
  }
  if (pathname === '/api/tasks' && method === 'GET') return handleListTasks(req, res);
  if (pathname === '/api/tasks' && method === 'POST') return handleCreateTask(req, res);
  if (pathname.startsWith('/api/tasks/')) {
    const id = decodeURIComponent(pathname.slice('/api/tasks/'.length));
    if (method === 'POST' || method === 'PUT') return handleUpdateTask(req, res, id);
    if (method === 'DELETE') return handleDeleteTask(req, res, id);
  }
  if (pathname === '/api/activities' && method === 'POST') return handleCreateActivity(req, res);
  if (pathname === '/api/activities' && method === 'GET') return handleListActivities(req, res, urlObj);
  if (pathname === '/api/sequences' && method === 'GET') return handleListSequences(req, res);
  if (pathname === '/api/sequences' && method === 'POST') return handleCreateSequence(req, res);
  const enrollMatch = pathname.match(/^\/api\/sequences\/([^/]+)\/enroll$/);
  if (enrollMatch && method === 'POST') return handleEnroll(req, res, decodeURIComponent(enrollMatch[1]));
  if (pathname === '/api/enrollments' && method === 'GET') return handleListEnrollments(req, res);
  const stopMatch = pathname.match(/^\/api\/enrollments\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') return handleStopEnrollment(req, res, decodeURIComponent(stopMatch[1]));
  if (pathname === '/api/unsubscribe' && method === 'GET') return handleUnsubscribe(req, res, urlObj); // public
  if (pathname === '/api/cron/run') return handleCron(req, res, urlObj);

  // --- Reporting (auth) + admin usage (admin) + onboarding ---
  if (pathname === '/api/reports' && method === 'GET') return handleReports(req, res, urlObj);
  if (pathname === '/api/admin/usage' && method === 'GET') return handleAdminUsage(req, res);
  if (pathname === '/api/onboarding' && method === 'GET') return handleOnboarding(req, res);

  // --- Client / lead tracker (auth) ---
  if (pathname === '/api/leads' && method === 'GET') return handleListLeads(req, res);
  if (pathname === '/api/leads' && method === 'POST') return handleCreateLead(req, res);
  if (pathname.startsWith('/api/leads/')) {
    const id = decodeURIComponent(pathname.slice('/api/leads/'.length));
    if (method === 'GET') return handleGetLead(req, res, id, urlObj);
    if (method === 'POST') return handleUpdateLead(req, res, id);
    if (method === 'DELETE') return handleDeleteLead(req, res, id);
  }

  // --- Credit pricing & account ---
  if (pathname === '/api/pricing') return handlePricing(req, res); // public
  if (pathname === '/api/account' && method === 'GET') return handleGetAccount(req, res);
  if (pathname === '/api/plan' && method === 'POST') return handleSetPlan(req, res);
  if (pathname === '/api/topup' && method === 'POST') return handleTopup(req, res);

  // --- Stripe ---
  if (pathname === '/api/stripe/webhook' && method === 'POST') return handleStripeWebhook(req, res);
  if (pathname === '/api/checkout/plan' && method === 'POST') return handleCheckoutPlan(req, res);
  if (pathname === '/api/checkout/topup' && method === 'POST') return handleCheckoutTopup(req, res);

  // --- Data API (requires login; AI deliverables consume credits) ---
  if (pathname === '/api/facility-types') {
    if (!(await currentUser(req))) return sendJson(res, 401, { error: 'Please log in.' });
    const types = Object.entries(FACILITY_TYPES).map(([id, t]) => ({
      id,
      label: t.label,
      roles: t.roles,
      reciprocal: t.reciprocal,
    }));
    return sendJson(res, 200, { types, default: DEFAULT_TYPE });
  }
  if (pathname === '/api/hospitals') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Please log in.' });
    emitEvent(u.id, 'source_searched', null, { location: urlObj.searchParams.get('location'), type: urlObj.searchParams.get('type') }); // fire-and-forget
    return handleApi(req, res, urlObj); // search is free
  }
  if (pathname === '/api/strategy' && method === 'POST') {
    if (!(await currentUser(req))) return sendJson(res, 401, { error: 'Please log in.' });
    return handleStrategy(req, res);
  }
  if (pathname === '/api/deck' && method === 'POST') {
    if (!(await currentUser(req))) return sendJson(res, 401, { error: 'Please log in.' });
    return handleDeck(req, res);
  }

  return serveStatic(req, res, pathname);
}

// Create the admin account from env (ADMIN_EMAIL + ADMIN_PASSWORD) if it
// doesn't exist yet. Runs once after the store is ready. The password is never
// reset on subsequent boots; use scripts/create-admin.js to rotate it.
async function seedAdminFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (await store.findByEmail(email)) return;
  let username = (email.split('@')[0] || 'admin').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
  if (username.length < 3) username = 'admin';
  let candidate = username;
  let n = 1;
  while (await store.findByUsername(candidate)) candidate = `${username.slice(0, 28)}${n++}`.slice(0, 32);
  await store.createUser({ username: candidate, email, passwordHash: authlib.hashPassword(password) });
  // eslint-disable-next-line no-console
  console.log(`Seeded admin account for ${email}`);
}

// Exported request handler — used by server.listen (local / persistent host)
// and by the Vercel serverless entrypoint (api/index.js).
let storeReady = null;
async function handler(req, res) {
  try {
    if (!storeReady) storeReady = store.init().then(seedAdminFromEnv);
    await storeReady;
    await route(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    }
    // eslint-disable-next-line no-console
    console.error('Unhandled request error:', err);
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports.fulfillStripeEvent = fulfillStripeEvent; // exported for tests
module.exports.runCron = runCron; // exported for tests + manual invocation

// Start a listener only when run directly (not when imported on Vercel).
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Referral Source Finder running at http://localhost:${PORT}`);
  });
}
