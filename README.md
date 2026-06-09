# Senior Placement Agency — Client-Sourcing Strategy & Operator Prompt (California)

A playbook for building a repeatable pipeline of residents/clients, plus a comprehensive, reusable AI prompt to run the function. Built around the legal reality that the durable pipeline is **referral relationships**, not direct patient acquisition.

---

## 🏥 Hospital Finder app (included in this repo)

A small web app that turns a **city or ZIP code** into a list of nearby **hospitals** — your Tier 1 referral sources (see §2). Useful for fast Source Discovery.

**Run it:**

```bash
npm start          # or: node server.js
# then open http://localhost:3000
```

- **No dependencies, no build step, no API key.** Requires Node 18+.
- **Data source:** the free federal **NPI Registry (NPPES)** API. Live, nationwide.
- **How it works:** a tiny Node server (`server.js`) proxies the NPPES API (which has no CORS headers), filters to hospital taxonomies, de-duplicates, caches for 10 min, and serves the frontend in `public/`.
- **Search by:** city (with a state selector, default CA) or a 5-digit ZIP. County input is not yet supported.
- **Returns only public organizational data** — hospital name, address, phone, type, NPI, and a map link. **No patient data / PHI is ever requested or stored.** Approach hospitals through their *Case Management / Discharge Planning* department, and verify every contact detail on the hospital's official site before outreach.

> Note: outbound calls to the NPI Registry require normal internet access. If the API is unreachable the app shows a clear error.

### 🤖 AI pain-point analysis & outreach strategy (two agents)

For any hospital in the results, pick the **role you're contacting** (Case Manager, Discharge Planner, Medical Social Worker, Director of Case Management) and click **"Pain points & approach"**. Two chained Claude agents run:

1. **Agent 1 — Pain Point Analyst:** identifies that role's real operational pain points (length of stay, throughput, readmissions, hard-to-place patients), ranked by severity.
2. **Agent 2 — Outreach Strategist:** takes those pain points + your agency profile and produces a tailored, compliant approach — value-prop mapping, talking points, a CAN-SPAM-compliant draft email, and compliance reminders.

**Setup (only needed for this feature):**

```bash
npm install @anthropic-ai/sdk      # the hospital search itself needs no install
export ANTHROPIC_API_KEY=sk-ant-...
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
