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
    }

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
    const link = `http://${req.headers.host || 'localhost'}/?token=${token}`;
    await mailer.sendPasswordReset(user.email, link);
    if (!IS_PROD) devResetLink = link; // surfaced only in dev for testing
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
    const user = md.userId ? await store.findById(md.userId) : null;
    if (user && user.account) {
      pricing.setPlan(user.account, 'free', false);
      await store.updateUser(user.id, { account: user.account });
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

  const patch = {};
  if (body.status && LEAD_STATUSES.includes(body.status)) patch.status = body.status;
  if ('sourceHospital' in body) patch.source = body.sourceHospital ? String(body.sourceHospital).slice(0, 200) : null;
  if (body.record) {
    const { record } = redact.toStorableRecord(body.record);
    patch.data = cryptoLib.encryptJson(record);
  }
  const updated = await store.updateLead(id, patch);
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
    if (!(await currentUser(req))) return sendJson(res, 401, { error: 'Please log in.' });
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

// Start a listener only when run directly (not when imported on Vercel).
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Referral Source Finder running at http://localhost:${PORT}`);
  });
}
