# Live smoke-test checklist

Run this once after the first deploy (and after any major change) to confirm every
subsystem works in production. Most steps are UI clicks; a few use `curl`. Replace
`APP` with your deployed URL (e.g. `https://your-app.vercel.app`).

## 0. Environment & build
- [ ] **Env vars set** (Vercel → Settings → Environment Variables), redeployed after changes:
  - [ ] `DATABASE_URL` (required on Vercel)
  - [ ] `NODE_ENV=production` (Secure cookies)
  - [ ] `BASE_URL=https://APP`
  - [ ] `DATA_ENCRYPTION_KEY` (client/contact encryption)
  - [ ] `CRON_SECRET` (cron auth)
  - [ ] `ANTHROPIC_API_KEY` (+ optional `CLAUDE_MODEL`)
  - [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - [ ] Email: `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_PHYSICAL_ADDRESS`
  - [ ] Optional CDSS: `CDSS_RESOURCE_ID` or `CDSS_DATA_URL` (+ `CDSS_VIOLATIONS_RESOURCE_ID`/`CDSS_VIOLATIONS_URL`)
  - [ ] `ADMIN_EMAILS` (defaults to the owner email)
- [ ] **Build/deploy succeeded**; `npm install` pulled `pg`, `@anthropic-ai/sdk`, `pptxgenjs`, `stripe`.
- [ ] `GET APP/` returns the **login page** (200). `GET APP/app` while logged out **redirects** (302).

## 1. Database
- [ ] First request after deploy succeeds (tables auto-create). If you see 500s, check `DATABASE_URL` and SSL.
- [ ] After signing up below, the user **persists across a redeploy** (proves Postgres, not the ephemeral file store).

## 2. Auth
- [ ] **Sign up** with a User ID + valid email + password (≥8 chars, letter+number) → lands on the dashboard.
- [ ] **Log out**, then **log in** by both User ID and email.
- [ ] **Forgot password** → you receive a real **reset email** (proves the email provider). Reset works; old password no longer logs in; the link is single-use.
- [ ] Cookies are `HttpOnly` and `Secure` (DevTools → Application → Cookies; the `sid` cookie should show both).

## 3. Onboarding
- [ ] A new account shows the **Getting started** checklist; items tick off as you complete them; it hides when done.

## 4. AI deliverables (credits)
- [ ] Search a referral source (city/ZIP) → results appear (proves NPI Registry reachability).
- [ ] On a saved client, **"Pain points & approach"** generates a tailored case (proves `ANTHROPIC_API_KEY`) and the **credit balance drops by 10**.
- [ ] **Build PowerPoint** downloads a `.pptx` (proves `pptxgenjs`) and the balance drops by **30**.
- [ ] On the **Free** plan, exhausting credits returns a clear "out of credits" message (402), not a crash.

## 5. Client privacy
- [ ] In **Client profile**, enter a record with an SSN/MRN/DOB in the notes → the rendered profile shows `[redacted]` and an **age** (never the DOB); the withheld footer lists the categories.
- [ ] **Save to my clients**, then inspect the DB (or trust the design): stored data is **encrypted** (`enc:` prefix) and contains **no SSN/MRN/DOB**.
- [ ] **Cross-agency check:** from a second account, you cannot see the first account's clients/leads/facilities.

## 6. Facilities + matcher
- [ ] **Load CA demo data** → facilities appear; change an availability and it persists.
- [ ] **CSV import** a couple of rows → they appear.
- [ ] **CDSS import** (if configured): run **Preview** first — confirm the count and that the column mapping looks right — then **Import**. Imported facilities carry license #/status and, if the violations dataset is configured, a **known-violations** summary.
- [ ] **Match** a saved client → ranked shortlist with Strong/Partial/Gap fit, **CA disclosures** on each, and **unlicensed facilities flagged & not recommended**.

## 7. CRM + sequences + cron
- [ ] Add a **contact** to a source (consent = opted_in), **log an activity**, create a **task** with a past due date.
- [ ] Create a 2–3 step **email sequence**; **enroll** the consented contact (non-consented → blocked).
- [ ] Trigger the cron manually and confirm it works:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" -X POST APP/api/cron/run
  ```
  → returns counts; the overdue task emails you a **reminder**; the sequence sends its first **email**.
- [ ] Click the **unsubscribe** link in a sequence email → confirmation page; the enrollment shows **stopped (unsubscribed)** and no further emails send.
- [ ] **Vercel Cron** is scheduled (Project → Cron Jobs shows `/api/cron/run` every 15 min) and recent runs are 200.

## 8. Billing (Stripe)
- [ ] **Webhook endpoint** added in Stripe (Developers → Webhooks → `APP/api/stripe/webhook`) subscribed to `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`; signing secret matches `STRIPE_WEBHOOK_SECRET`.
- [ ] **Subscribe** to a paid plan via Checkout (test card `4242 4242 4242 4242`) → after redirect, the plan/credits update (webhook fulfilled).
- [ ] **Top-up** purchase adds credits.
- [ ] In Stripe test mode, **trigger a renewal** (`stripe trigger invoice.paid` or advance the test clock) → monthly credits **refill**.
- [ ] **Fail a payment** (`stripe trigger invoice.payment_failed`) → account shows **past due**, paid features pause (Free still works), dunning email sent.
- [ ] Accrued **overage** appears on the next invoice (invoice item) after a renewal.
- [ ] Stripe Dashboard → recent webhook deliveries are **200** (signature verified — confirms the raw-body path on Vercel).

## 9. Reporting + admin
- [ ] **Reports** panel shows the funnel (sources → leads → tours → applications → placements), conversion %, time-to-placement, and the source leaderboard after you move a lead to **placed** (optionally with a revenue value).
- [ ] As an **admin** (email in `ADMIN_EMAILS`), the **Founder usage** panel shows weekly-active agencies; a non-admin gets 403 on `/api/admin/usage`.
- [ ] Admin account shows **"Unlimited · Admin · no billing"** and AI actions don't deduct credits.

## 10. Failure-mode sanity (graceful degradation)
- [ ] Temporarily unset a key (e.g. `ANTHROPIC_API_KEY`) → the feature shows a clear "not configured" message instead of a 500. Restore it.

---

If every box is checked, the full loop is live: **search a source → add a contact →
enroll a sequence → log a returned lead → run a facility match → produce a compliant
shortlist → move the lead to placed → see it in reporting.**

*Not legal advice — have California counsel review your referral agreement,
disclosures, and privacy policy before onboarding real agencies and real client data.*
