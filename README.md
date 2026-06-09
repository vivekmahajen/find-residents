# Senior Placement Agency — Client-Sourcing Strategy & Operator Prompt (California)

A playbook for building a repeatable pipeline of residents/clients, plus a comprehensive, reusable AI prompt to run the function. Built around the legal reality that the durable pipeline is **referral relationships**, not direct patient acquisition.

---

## 🏥 Referral Source Finder app (included in this repo)

A web app with **accounts and credit-based pricing**, where logged-in agencies search **Tier 1 referral sources** — **hospitals**, **skilled nursing facilities (SNFs)**, and **hospice & home-health agencies** (see §2–§3) — and spend credits on AI deliverables.

## ☁️ Deploying to Vercel

The app runs as a standalone Node server locally *and* as a Vercel serverless function (`api/index.js` reuses the same exported request handler via `vercel.json`). For Vercel you must use the **Postgres store** (the serverless filesystem is ephemeral).

**Steps:**
1. **Create a database.** Vercel Dashboard → **Storage → Create → Postgres** (or use Neon/Supabase). This sets `DATABASE_URL` (or `POSTGRES_URL` — set `DATABASE_URL` to the same value). Tables are auto-created on first request.
2. **Add environment variables** (Project → Settings → Environment Variables):

   | Key | Required | Value |
   |---|---|---|
   | `DATABASE_URL` | **Yes (on Vercel)** | Postgres connection string from step 1 |
   | `ANTHROPIC_API_KEY` | For AI | `sk-ant-...` |
   | `CLAUDE_MODEL` | Optional | defaults to `claude-opus-4-8` |
   | `STRIPE_SECRET_KEY` | For billing | `sk_live_...` / `sk_test_...` |
   | `STRIPE_WEBHOOK_SECRET` | For billing | `whsec_...` (from step 4) |
   | `BASE_URL` | Recommended | `https://your-app.vercel.app` (Stripe redirects) |
   | `NODE_ENV` | Recommended | `production` (Secure cookies) |
   | `DATA_ENCRYPTION_KEY` | Recommended | any strong secret — encrypts saved client/lead records at rest |
   | `PGSSL` | Optional | `disable` only for a non-TLS local Postgres |

3. **Deploy** (`git push` to the connected repo, or `vercel`). `npm install` pulls `pg`, `@anthropic-ai/sdk`, `pptxgenjs`, `stripe`.
4. **Stripe webhook:** Stripe Dashboard → Webhooks → add endpoint `https://your-app.vercel.app/api/stripe/webhook`, subscribe to `checkout.session.completed` and `customer.subscription.deleted`, and copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**Notes / to verify on a live deploy:**
- The single function serves both pages and static assets from `public/` (bundled via `includeFiles` in `vercel.json`).
- The Stripe webhook reads the **raw request body** for signature verification. The handler reads the stream directly; if verification ever fails on Vercel, ensure no upstream body parsing is consuming it first.
- Without `DATABASE_URL` the app uses the JSON file store (`data/db.json`) — fine for local dev or a persistent-disk host (Railway/Render/Fly with `DATA_DIR` on a mounted volume), but **not** for Vercel.

**Run it locally:**

```bash
npm install        # pulls pg, @anthropic-ai/sdk, pptxgenjs, stripe
npm start          # or: node server.js  → http://localhost:3000 (login page)
```

- Locally (no `DATABASE_URL`) it uses the JSON file store and works without any cloud setup. The AI, deck, and billing features activate when their keys are set (see below). Requires Node 18+.

### 🔑 Accounts & login

- **Login is the landing page.** New users create an account with a **User ID**, a valid **email**, and a **password** (min 8 chars, letter + number). Standard flows included: log in (by User ID *or* email), log out, and **forgot/reset password**. Everyone starts on the **Free** plan.
- **How it's built:** passwords are hashed with Node's `crypto` **scrypt** (salted, constant-time compare); sessions are **HttpOnly cookies** backed by a small **JSON file store** (`data/db.json`, gitignored, atomic writes — swap for SQLite/Postgres later). Set `NODE_ENV=production` to add the `Secure` cookie flag.
- **Forgot-password email:** no email provider is wired up, so the reset link is **logged to the server console** (and shown on-screen in dev for testing). For production, implement `lib/mailer.js → sendPasswordReset()` with a real provider and remove the dev link.

### 💳 Credit-based pricing (plans + credits)

Billing is a **credit model** (`lib/pricing.js`). A plan grants monthly credits; the AI **deliverables consume credits** (searching is free):

| Plan | Monthly | Annual (−20%) | Credits | ~Decks | Eff. $/deck |
|---|---|---|---|---|---|
| Free | $0 | — | 100 (one-time) | ~3 | — |
| Starter | $25 | $20/mo | 300 | ~10 | $2.50 |
| Pro | $59 | $47/mo | 750 | ~25 | $2.36 |
| Business | $149 | $119/mo | 2,000 | ~66 | $2.24 |
| Scale | $299 | $239/mo | 4,200 | ~140 | $2.14 |
| Enterprise | custom | — | custom | — | — |

- **Per-action cost** (at $0.10/credit): tailored case (a *Document*) **10 cr** in-plan / 15 overage; PowerPoint deck **30 cr** / 45; (Spreadsheet 15/23, Deep research 60/90 are in the catalog for future actions).
- **Overage:** on paid plans, work past your monthly credits is metered (`$ = overage credits × $0.10`, accrued as owed); the **Free plan stops** when credits run out (HTTP 402 → upgrade/top-up).
- **Top-up packs** (250/$25, 1,000/$90, 5,000/$400) carry over while subscribed; plan credits reset each cycle.
- The dashboard shows your **balance**, the **tier ladder** (with an annual toggle and effective $/deck), top-ups, and a credits FAQ. Each AI button shows its credit cost and the balance updates after each action.
- **Endpoints:** `GET /api/pricing` (public model), `GET /api/account`, `POST /api/plan`, `POST /api/topup`. Credits are enforced and charged server-side in `/api/strategy` and `/api/deck`.
- **Payments — Stripe (optional).** When configured, paid plans and top-ups go through **Stripe Checkout** (hosted; no card data touches this app) and credits are granted only after Stripe confirms payment via webhook. When *not* configured, the app falls back to instant (no-charge) plan changes so it still runs locally.

  Enable it by setting:
  ```bash
  npm install stripe
  export STRIPE_SECRET_KEY=sk_test_...
  export STRIPE_WEBHOOK_SECRET=whsec_...        # from `stripe listen` or the dashboard
  export BASE_URL=https://your-app.example.com  # optional; else derived from the request
  ```
  - **Plans** → subscription Checkout (`/api/checkout/plan`); monthly or annual (−20%, billed yearly). **Top-ups** → one-time Checkout (`/api/checkout/topup`). Prices are built inline from `lib/pricing.js`, so no Stripe dashboard Price objects need pre-creating.
  - **Webhook** at `POST /api/stripe/webhook` (signature-verified) fulfills `checkout.session.completed` (activate plan / add credits) and downgrades to Free on `customer.subscription.deleted`. Point your Stripe webhook there. Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
  - With Stripe live, the instant `/api/plan` and `/api/topup` endpoints refuse paid changes (Free downgrade still works), so credits can't be granted without payment.
  - **Not yet wired:** charging the metered overage balance (`overageUsd`) back to the card — overage is tracked but not yet invoiced. Subscription **renewals** currently top up credits via the in-app 30-day cycle reset rather than the `invoice.paid` webhook.

### 👑 Admin accounts (no billing)

Admins bypass billing entirely — no credit checks, no charges, AI deliverables are unlimited. Admins are identified by **email** via `ADMIN_EMAILS` (comma-separated; defaults to `vmahajans@yahoo.com`).

**Create the admin account** (`vmahajans@yahoo.com`). The username can't contain `@`, so log in with the **email**. Two ways:

- **Auto-seed (recommended, works on Vercel):** set env vars and the account is created on first boot if it doesn't exist —
  ```bash
  ADMIN_EMAIL=vmahajans@yahoo.com
  ADMIN_PASSWORD=manisha2025
  ```
- **Script (local / persistent host / against a DB):**
  ```bash
  ADMIN_EMAIL=vmahajans@yahoo.com ADMIN_PASSWORD=manisha2025 npm run create-admin
  ```
  (Re-running updates the password.)

Then log in at `/` with **User ID/email = `vmahajans@yahoo.com`** and the password. The dashboard shows **"Unlimited · Admin · no billing"** and credits are never deducted. To rotate the password later, re-run the script; to revoke admin, remove the email from `ADMIN_EMAILS`.

### 🔒 Privacy-safe client profile renderer

Turn a raw client intake into a clean, **matching-ready** card with sensitive identifiers redacted. Enter/paste a record, pick a **viewer role** and **output mode**, and get a minimized profile (`POST /api/client-profile`).

- **Deterministic redaction (no LLM in the redaction path):** SSNs, financial data (cards/accounts/routing), government IDs (DL/passport/A-number), and medical IDs (MRN/Medi-Cal/Medicare/MBI/policy) are redacted — **including inside free-text notes** — and full **date of birth is reduced to age**. Over-redaction is the deliberate failure mode.
- **Role-gated contact** (`full` / `matching_only` / `partner_facility`): masks phone to last 2 digits and email local part for matching, and hides direct contact entirely for partner facilities ("via agency").
- **Data minimization:** only the placement-relevant schema fields are shown; special-category data (race, religion, etc.) is omitted unless stated as a care *preference* (e.g., "faith-based home") or functional need.
- **Transparency footer** lists every sensitive category that was present but withheld.
- **Stateless / no PHI stored:** the renderer (`/api/client-profile`) is stateless — nothing is persisted. To keep clients, use the tracker below.

### 👥 Client / lead tracker

Save the referrals you've received (data **you** enter — never pulled from a hospital) and track them through placement. Per-agency, scoped to your login.

- **Redact-on-store:** sensitive identifiers (SSN, financial, government, medical IDs) and full DOB are stripped **before anything is written** — the database never contains them (verified: the on-disk record holds no SSN/MRN/DOB).
- **Encryption at rest:** the stored record is AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY`. Without the key it still works (redacted plaintext) but logs that encryption is off — **set the key in production.**
- **Access control:** leads are scoped to the owning agency; another account gets a 404.
- **Status pipeline** (new → contacted → touring → application → placed → closed), optional "referred by" source, role-gated **View** (full / matching / partner), and delete. Endpoints: `GET/POST /api/leads`, `GET/POST/DELETE /api/leads/:id`.

### 🗺️ Data coverage (optional, free)

County selection is now a free **data-coverage preference** (which CA counties you focus on) — it no longer affects billing and doesn't gate the tools.
- **Data source:** the free federal **NPI Registry (NPPES)** API. Live, nationwide.
- **How it works:** a tiny Node server (`server.js`) handles auth + subscriptions and proxies the NPPES API (which has no CORS headers), filtering to the right NPI taxonomies for the chosen **source type**, de-duplicating, caching for 10 min, and serving the `public/` frontend (`index.html` = login, `app.html` = dashboard).
- **Source types:** Hospitals · Skilled Nursing (SNF) · Hospice & Home Health. Each maps to its own taxonomies and the staff roles you'd approach; SNF and hospice are flagged **reciprocal** (you can refer families to them too), which the strategist leans into.
- **Search by:** city (with a state selector, default CA) or a 5-digit ZIP. County input is not yet supported.
- **Returns only public organizational data** — hospital name, address, phone, type, NPI, and a map link. **No patient data / PHI is ever requested or stored.** Approach hospitals through their *Case Management / Discharge Planning* department, and verify every contact detail on the hospital's official site before outreach.

> Note: outbound calls to the NPI Registry require normal internet access. If the API is unreachable the app shows a clear error.

### 🪪 Agency profile (drives the tailored case)

After login, the dashboard has an **Agency profile** builder — a structured capability profile (identity, service area, languages, hours, levels of care, payors, complex/hard-to-place capabilities, facility network, responsiveness/SLAs, process & family services, credibility, integration, fee model). Build it once; it's saved to your account and fed to the case-generator agent. It's **truth-only** — leave a field blank rather than overclaim, and the agent surfaces blanks as `[not provided — verify]`.

### 🤖 AI pain-point analysis & tailored case (two agents)

For any source in the results, pick the **role you're contacting** (the dropdown adapts to the source type — e.g. SNF Social Worker, Hospice Community Liaison) and click **"Pain points & approach"**. Two chained Claude agents run:

1. **Agent 1 — Pain Point Analyst:** identifies that role's real operational pain points (length of stay, throughput, census, readmissions, hard-to-place patients), ranked by severity.
2. **Agent 2 — Case Generator:** matches **your saved agency profile** to those pain points and produces a tailored, truthful case:
   - a **capability match** for each pain rated **Strong / Partial / Gap** with the supporting proof,
   - the **biggest strength** and **biggest gap** (honest coverage call-out),
   - a headline + executive summary, talking points, **objection handling** (incl. the fee disclosure),
   - a best first step, and a CAN-SPAM-compliant **draft email** (with a copy button) + compliance reminders.

   It uses your profile when you've built one (badged *"using your profile"*) and falls back to conservative defaults otherwise. For reciprocal sources (SNF, hospice) it leads with two-way partnership.

   The case also includes an **illustrative savings estimate** — the agent supplies conservative, clearly-labeled industry-benchmark inputs (avoidable bed-days per hard placement × hard-to-place cases/month × cost per inpatient day) and the server computes the monthly/annual totals deterministically, always framed as an estimate to validate (never guaranteed).

### 📊 PowerPoint pitch deck

Below each generated case, **"Build PowerPoint"** downloads a tailored `.pptx` proposal for that hospital: title, executive summary, their pain points, the capability **match (Strong/Partial/Gap)**, the **estimated-savings** slide, why-us + objection handling, and the ask + compliance disclosures.

- Generated server-side with **`pptxgenjs`** (lazy-loaded — `npm install pptxgenjs`); the deck reuses the already-generated case, so it makes **no extra model call**.
- Like the AI feature, it degrades gracefully: if `pptxgenjs` isn't installed it returns a clear "run npm install" message instead of failing.

**Setup (only needed for this feature):**

```bash
npm install @anthropic-ai/sdk pptxgenjs   # SDK = AI case generator; pptxgenjs = PowerPoint export
export ANTHROPIC_API_KEY=sk-ant-...        # the source search itself needs neither
npm start
```

- Built on the official Anthropic SDK, model `claude-opus-4-8` (override with `CLAUDE_MODEL`), with structured JSON outputs.
- **Edit your agency profile in `agency.config.js`** (service area, levels of care, payors, differentiators, disclosed fee model) — it feeds directly into the strategist's case.
- The hospital search keeps working **without** the SDK or an API key; if the AI feature isn't configured, the app shows a clear, actionable message instead of failing.
- **Compliance is built into the prompts:** no PHI is requested or generated, statistics are framed as general industry dynamics (not fabricated facts), email drafts are CAN-SPAM-compliant, and California RCFE referral-source disclosures are surfaced. Always verify contacts and respect each hospital's vendor policy before outreach.

---

## 0. Ground rules — read these first (they protect your license, reputation, and revenue)

These are operating guardrails, not legal advice. Have a California elder-law / healthcare attorney review your referral agreements, disclosure forms, privacy policy, and outreach before you launch.

- **HIPAA (hospitals & SNFs).** You may not receive patient lists or any protected health information (PHI). Discharge planners and case managers refer *consenting families* to you, or share information only after the patient/representative signs a release. Never ask a referral source for patient data; ask them to connect interested families.
- **California RCFE referral-source law (Health & Safety Code §1569 et seq.; AB 2926, SB 648).** As a compensated referral source you must disclose, in writing/electronically/verbally: (a) any payment you receive from a facility you recommend, (b) any fee you charge the consumer, (c) the services you provide, (d) the date of your most recent visit/tour of a recommended facility, and (e) known regulatory violations from the facility's most recent state evaluation. You may **not** hold a client's power of attorney or property, may **not** refer to a facility you have an ownership interest in without a signed waiver, must **post a privacy policy** on your website/marketing, and must **report** facilities you reasonably believe are unlicensed to CDSS.
- **Anti-kickback.** Pure private-pay assisted living/RCFE placement generally sits outside the federal Anti-Kickback Statute, but never tie referral fees to any Medicare/Medi-Cal-reimbursed service, and keep all facility commissions transparent and disclosed.
- **Outreach laws.** Honor the Do-Not-Call registry and TCPA (no cold calls/texts to cell phones without prior express consent), CAN-SPAM (clear sender, opt-out, no deceptive subject lines on commercial email), and CCPA (California consumers' data rights). **Do not scrape personal contact data from forums/social posts and cold-blast it** — it is a legal and reputational landmine.
- **Honesty.** Disclose that facilities pay you (when they do). Trust is the entire product in this business; a family that feels steered toward whoever pays you most will never refer you again.

---

## 1. The channel map — where residents actually come from

Ranked by quality and repeatability. Build top-down.

| Tier | Channel | Who refers / source | What they send you | Approach |
|------|---------|--------------------|--------------------|----------|
| 1 | **Hospital discharge planning** | Case managers, discharge planners, medical social workers, transitional-care & ED care-coordination teams | Patients being discharged who can't go home safely | Relationship + in-services; be the go-to for hard/fast placements (§2) |
| 1 | **Skilled nursing facilities** | Social workers, discharge coordinators, admissions/marketing | Residents stepping down from SNF to assisted living / board & care | Same playbook as hospitals, plus reciprocal referrals |
| 1 | **Hospice & home health** | Liaisons, social workers, RNs | Families needing a higher or different level of care | Mutual-referral relationships |
| 2 | **Allied professionals** | Elder-law attorneys, fiduciaries/conservators, trust officers, financial advisors, geriatric care managers (GCMs), physicians/geriatricians, memory clinics | Clients/patients facing a placement decision | Lunch meetings, referral agreements, reciprocal value |
| 3 | **Aging network & community** | Area Agencies on Aging (AAA) / ADRC, senior centers, Alzheimer's Association support groups, faith communities, county Adult Protective Services (carefully) | Families actively seeking help | Be a listed/known local resource; speak at events |
| 4 | **Direct-to-family inbound** | Your own marketing | High-intent families searching now | Local SEO, Google Business Profile, ads, content (§4) |
| 5 | **Online communities & listing platforms** | Facebook caregiver groups, Nextdoor, Reddit, Caring.com, A Place for Mom | Inbound inquiries / opt-ins | Compliant engagement only (§5) |

A healthy book is roughly 60–70% Tier 1–2 (predictable, low-cost), 20–30% Tier 4 inbound, 10% community/online.

---

## 2. Hospital outreach strategy (the deep dive)

**Who to target, in order:** Director of Case Management / Care Coordination → individual case managers & discharge planners on med-surg, cardiac, ortho, and geriatric units → medical social workers → ED care-coordination / transitional-care nurses. Map each target hospital's team before you walk in.

**Your value proposition to them** (frame everything around *their* pain — length of stay and safe, timely discharge):
- You place the **hard cases** fast — Medi-Cal/board-and-care, behavioral complexity, low-income, short timelines — the ones that otherwise stall a discharge and rack up avoidable days.
- You're **responsive** (same-day callbacks, evening/weekend reachability) and you **own the legwork** — touring families, gathering facility options, handling paperwork.
- You help **prevent failed placements and readmissions** by matching the right level of care the first time.
- You make the discharge planner look good to their throughput metrics. That is the entire sale.

**The 90-day relationship playbook:**
1. **Research & map** each hospital's case-management structure and decision-makers.
2. **Warm intro** wherever possible (a shared SNF, attorney, or physician contact beats a cold visit).
3. **Offer value first:** a free "California placement options" in-service or lunch-and-learn for the case-management team; a clean one-page capabilities sheet (service area, levels of care, Medi-Cal/board-and-care capability, response-time SLA, your disclosures).
4. **Sign a referral agreement** and provide your required California disclosures up front.
5. **Win one hard placement** quickly and visibly — that single save is your best marketing.
6. **Close the loop:** report back on every referral's outcome; ask what would make their job easier.
7. **Stay top-of-mind:** brief, useful check-ins (not pestering), a monthly "open beds / capabilities" update, holiday/appreciation touches.

**Compliance inside hospital outreach:**
- Never request patient lists or PHI. The planner introduces the family, or shares details only after a signed release.
- You don't need a Business Associate Agreement if you never touch PHI — but if a hospital ever wants to share PHI directly, get counsel and a BAA first.
- Respect each facility's vendor/solicitation policy; some require you to register as an approved vendor before you can meet staff.

---

## 3. SNF, hospice & home-health outreach

Same engine as hospitals, with two twists: (1) **reciprocity** — you can refer families to *them* when a senior needs skilled care or hospice, which makes you a two-way partner, not just a taker; (2) SNF social workers handle step-down placements constantly and value a reliable RCFE/board-and-care partner who can take Medi-Cal and complex cases. Prioritize SNFs with high Medi-Cal census near your service area.

---

## 4. Direct-to-family inbound engine

- **Local SEO + Google Business Profile:** rank for "assisted living near me," "board and care [city]," "memory care [county]," "senior placement [city]." Collect reviews relentlessly.
- **Google Local Services Ads / PPC** for high-intent searches; these convert because the searcher needs care now.
- **Content & lead magnets:** a free, genuinely useful "California Senior Care & Placement Guide" (levels of care, costs, Medi-Cal/ALW, how to tour) gated behind an opt-in form (consent for follow-up).
- **Reviews & past-family referrals:** your highest-converting source over time — systematize asking happy families for reviews and introductions.
- **Local presence:** health fairs, caregiver support groups, senior expos, library/community talks.

---

## 5. Online communities & "people asking for care homes" — the compliant way

Where these conversations happen: Facebook caregiver/eldercare groups, Nextdoor, Reddit (r/AgingParents, r/CaregiverSupport, r/dementia), Alzheimer's Association forums, and aggregator sites (Caring.com, A Place for Mom, SeniorAdvisor).

**Do:** become a recognized, genuinely helpful local expert; answer questions publicly and transparently (disclose who you are); offer your free guide or a no-obligation consult so people **opt in** to contact you; ask group admins about allowed promotion; partner with or take inbound leads from listing platforms.

**Don't:** scrape names/phones/emails from posts and cold-call, cold-text, or cold-email them. That violates platform terms, TCPA/CAN-SPAM, and CCPA, and torches your reputation in tight-knit caregiver communities. The goal is to be the person they *choose* to reach out to.

---

## 6. Intake & conversion (so leads become placements)

Standardize this so nothing leaks:
- **Intake capture:** location/service area, level of care needed, payor (private pay / LTC insurance / Medi-Cal / ALW), monthly budget, timeline, medical & behavioral needs, decision-maker.
- **Disclosures:** deliver your California referral-source disclosures at first substantive contact, in writing.
- **Match → tour → place:** shortlist appropriate, currently-available, well-rated facilities; accompany tours; support the decision; confirm placement.
- **Follow-up:** check in post-move (satisfaction + catch problems early), then request a review and referrals.
- **CRM cadence:** track every lead and every referral source; nurture sources monthly.

---

## 7. Metrics that tell you it's working

- Referral sources activated (and # actively sending) per month
- Referrals per source per month
- Lead → tour → placement conversion rates
- Average time-to-placement
- Revenue per placement and per source
- Source mix (% Tier 1–2 vs. inbound vs. online)

---

## 8. The comprehensive operator prompt

Paste this into your AI assistant. Fill the `{{...}}` variables. It is scoped to find **referral sources and compliant channels** and to produce outreach + intake assets — never to harvest individuals' private data.

```
ROLE
You are the business-development and outreach operator for a licensed-compliant senior
placement / RCFE referral agency in California. Your job is to build and work a pipeline of
referral SOURCES and compliant inbound channels — not to obtain or contact patients' private
data. You produce research, prioritized target lists, outreach assets, and lead-qualification
support.

AGENCY CONTEXT (inputs)
- Service area / counties: {{counties_or_cities}}
- Levels of care we place: {{e.g., assisted living, board & care/RCFE, memory care}}
- Payors we handle: {{private pay / LTC insurance / Medi-Cal / Assisted Living Waiver}}
- Differentiators: {{e.g., Medi-Cal & board-and-care capable, same-day response, bilingual}}
- Facility partners we can place into: {{list or "discover"}}
- Our disclosed fee model: {{paid by facilities / consumer fee / both}}

HARD RULES (never violate; if a request conflicts, refuse and explain)
1. Never request, generate, store, or act on protected health information (PHI) or any
   individual patient's private data. Referrals come only from consenting families or via
   signed releases held by the referral source.
2. Never scrape personal contact info from forums/social posts for cold outreach. Online
   community engagement must be public, transparent, opt-in, and within platform terms.
3. All outreach must comply with TCPA (no cold calls/texts to cells without consent; honor
   Do-Not-Call), CAN-SPAM (identify sender, working opt-out, honest subject), and CCPA.
4. In any consumer-facing copy, include California referral-source disclosures: payment
   received from facilities, any consumer fee, services provided, most recent facility
   visit/tour, and known facility regulatory violations. Never imply we are unbiased if
   facilities pay us.
5. Never recommend holding a client's power of attorney or property; never steer toward an
   owned/affiliated facility without a written waiver; flag any apparently unlicensed
   facility for reporting to CDSS.
6. Be truthful. No fabricated facility data, reviews, outcomes, or credentials.

MODES (the user will pick one; ask which if unclear)

[SOURCE DISCOVERY] Given {{counties_or_cities}}, identify and prioritize referral-SOURCE
ORGANIZATIONS: hospitals (and their case-management/discharge-planning departments), skilled
nursing facilities, hospice & home-health agencies, elder-law attorneys, fiduciaries, geriatric
care managers, financial advisors, Area Agencies on Aging/ADRCs, senior centers, and caregiver
support groups. For each: name, type, why they're a fit, the role/title to approach, public
contact path (main line / public email / website form only), and a priority score (volume x
fit x ease). Output a ranked table. Use only publicly available organizational info.

[OUTREACH ASSETS] For a chosen source type, draft: (a) a warm intro request, (b) a first-contact
email (CAN-SPAM compliant), (c) a 30-second phone script, (d) a one-page capabilities sheet
outline, (e) a lunch-and-learn / in-service offer, and (f) a follow-up cadence (touch schedule,
non-pestering). Tailor the value proposition to that source's real pain (e.g., for hospitals:
reducing length of stay and enabling safe, timely discharge of hard-to-place patients). Include
required disclosures where consumer-facing.

[INBOUND & COMMUNITY] Produce: local-SEO keyword targets, a Google Business Profile plan, a
lead-magnet guide outline, opt-in form fields (with consent language), and a compliant
community-engagement playbook (how to be a transparent, helpful expert — never scrape/cold-DM).

[LEAD QUALIFICATION] Given an inbound family inquiry the family voluntarily provided, generate
intake questions and a qualification summary: location, level of care, payor, budget, timeline,
needs, decision-maker; then a shortlist approach (criteria for matching to appropriate,
available, well-rated facilities). Do not invent facility specifics; mark unknowns to verify.

OUTPUT STYLE
Concise, practical, ready to use. Tables for lists. Flag every compliance touchpoint inline.
State assumptions; mark anything that needs human/legal verification. Never present estimates
or facility details as confirmed facts.
```

---

*This document is operational guidance, not legal advice. California's RCFE referral-source
requirements, HIPAA, anti-kickback rules, and TCPA/CAN-SPAM/CCPA all carry real penalties —
have qualified California counsel review your agreements, disclosures, privacy policy, and
outreach program before launch.*
