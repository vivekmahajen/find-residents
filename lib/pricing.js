'use strict';

/*
 * Credit-based pricing model (Operator Prompt v2). Encodes the competitive
 * credit ladder, action catalog, top-up packs, and the account math
 * (allotment, monthly cycle reset, in-plan vs metered overage).
 *
 * Edit the constants/tables here to re-tune pricing; everything else derives
 * from them. Confirm against your real cost-to-serve before publishing.
 */

const CREDIT_VALUE_USD = 0.1; // $ per credit at top-up / overage rack rate
const ANNUAL_DISCOUNT_PCT = 20;
const OVERAGE_MODE = 'metered'; // 'metered' (auto-bill $) | 'topup'
const ROLLOVER_POLICY =
  'Plan credits do not roll over; purchased top-up credits carry over while subscribed.';
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

// action key : label : in-plan credits : overage credits (~1.5x in-plan)
const ACTIONS = {
  deck: { label: 'PowerPoint deck', inPlan: 30, overage: 45 },
  document: { label: 'Document / tailored case', inPlan: 10, overage: 15 },
  spreadsheet: { label: 'Spreadsheet / model', inPlan: 15, overage: 23 },
  research: { label: 'Deep research report', inPlan: 60, overage: 90 },
};

// id : name : monthly USD : included credits
const PLANS = [
  { id: 'free', name: 'Free', monthly: 0, credits: 30, oneTime: true },
  { id: 'starter', name: 'Starter', monthly: 25, credits: 300 },
  { id: 'pro', name: 'Pro', monthly: 59, credits: 750 },
  { id: 'business', name: 'Business', monthly: 149, credits: 2000 },
  { id: 'scale', name: 'Scale', monthly: 299, credits: 4200 },
  { id: 'enterprise', name: 'Enterprise', monthly: null, credits: null, custom: true },
];

const TOPUP_PACKS = [
  { credits: 250, price: 25 },
  { credits: 1000, price: 90 },
  { credits: 5000, price: 400 },
];

function planById(id) {
  return PLANS.find((p) => p.id === id) || null;
}
function creditsToUsd(c) {
  return Math.round(c * CREDIT_VALUE_USD * 100) / 100;
}
function annualMonthly(monthly) {
  if (monthly == null) return null;
  return Math.round(monthly * (1 - ANNUAL_DISCOUNT_PCT / 100) * 100) / 100;
}
function effPerCredit(plan) {
  if (!plan.credits || plan.monthly == null || plan.monthly === 0) return null;
  return Math.round((plan.monthly / plan.credits) * 1000) / 1000;
}
function effPerDeck(plan) {
  if (!plan.credits || plan.monthly == null || plan.monthly === 0) return null;
  return Math.round((plan.monthly / plan.credits) * ACTIONS.deck.inPlan * 100) / 100;
}
function includedDecks(plan) {
  return plan.credits ? Math.floor(plan.credits / ACTIONS.deck.inPlan) : 0;
}

// Public model for the pricing UI / EXPLAIN copy.
function publicModel() {
  return {
    creditValueUsd: CREDIT_VALUE_USD,
    annualDiscountPct: ANNUAL_DISCOUNT_PCT,
    overageMode: OVERAGE_MODE,
    rolloverPolicy: ROLLOVER_POLICY,
    actions: Object.entries(ACTIONS).map(([key, a]) => ({
      key,
      label: a.label,
      inPlanCredits: a.inPlan,
      overageCredits: a.overage,
      inPlanUsd: creditsToUsd(a.inPlan),
      overageUsd: creditsToUsd(a.overage),
    })),
    plans: PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      custom: !!p.custom,
      oneTime: !!p.oneTime,
      monthly: p.monthly,
      annualMonthly: annualMonthly(p.monthly),
      credits: p.credits,
      effPerCredit: effPerCredit(p),
      effPerDeck: effPerDeck(p),
      includedDecks: includedDecks(p),
      includedByAction: p.credits
        ? Object.fromEntries(
            Object.entries(ACTIONS).map(([k, a]) => [k, Math.floor(p.credits / a.inPlan)])
          )
        : null,
    })),
    topupPacks: TOPUP_PACKS.map((t) => ({
      credits: t.credits,
      price: t.price,
      perCredit: Math.round((t.price / t.credits) * 1000) / 1000,
    })),
  };
}

// ---- Account state (per user) ---------------------------------------------

function defaultAccount() {
  const p = planById('free');
  return {
    planId: 'free',
    annual: false,
    planCredits: p.credits,
    topupCredits: 0,
    overageUsd: 0,
    cycleStart: Date.now(),
  };
}

// Reset plan allotment when a billing cycle elapses (paid plans only).
// Returns true if the account changed.
function refreshCycle(acct) {
  const p = planById(acct.planId);
  if (!p || p.oneTime || p.custom || !p.monthly) return false;
  if (Date.now() - acct.cycleStart >= CYCLE_MS) {
    acct.planCredits = p.credits;
    acct.cycleStart = Date.now();
    return true;
  }
  return false;
}

function setPlan(acct, planId, annual) {
  const p = planById(planId);
  acct.planId = planId;
  acct.annual = !!annual;
  acct.planCredits = p.credits || 0;
  acct.cycleStart = Date.now();
  return acct;
}

function addTopup(acct, credits) {
  acct.topupCredits += credits;
  return acct;
}

// Can this account perform the action? (Free plans must have the credits;
// paid plans always can, via metered overage.)
function canAfford(acct, key) {
  const a = ACTIONS[key];
  if (!a) return false;
  if (acct.planId === 'free') return acct.planCredits + acct.topupCredits >= a.inPlan;
  return true;
}

// Charge for a completed action. Deduct in-plan credits (plan first, then
// top-up); if depleted on a paid plan, meter the overage as $ owed.
function charge(acct, key) {
  const a = ACTIONS[key];
  if (!a) return { ok: false, reason: 'unknown_action' };
  const available = acct.planCredits + acct.topupCredits;
  if (available >= a.inPlan) {
    let need = a.inPlan;
    const fromPlan = Math.min(acct.planCredits, need);
    acct.planCredits -= fromPlan;
    need -= fromPlan;
    acct.topupCredits -= need;
    return { ok: true, mode: 'in-plan', creditsCharged: a.inPlan };
  }
  if (acct.planId === 'free') return { ok: false, reason: 'out_of_credits' };
  const usd = creditsToUsd(a.overage);
  acct.overageUsd = Math.round((acct.overageUsd + usd) * 100) / 100;
  return { ok: true, mode: 'overage', creditsCharged: 0, overageUsd: usd };
}

function accountView(acct) {
  const p = planById(acct.planId) || planById('free');
  return {
    planId: acct.planId,
    planName: p.name,
    custom: !!p.custom,
    annual: !!acct.annual,
    listMonthly: p.monthly,
    monthly: p.monthly == null ? null : acct.annual ? annualMonthly(p.monthly) : p.monthly,
    planCredits: acct.planCredits,
    topupCredits: acct.topupCredits,
    totalCredits: acct.planCredits + acct.topupCredits,
    overageUsd: acct.overageUsd,
    includedDecks: includedDecks(p),
    effPerDeck: effPerDeck(p),
  };
}

module.exports = {
  ACTIONS,
  PLANS,
  TOPUP_PACKS,
  CREDIT_VALUE_USD,
  planById,
  creditsToUsd,
  publicModel,
  defaultAccount,
  refreshCycle,
  setPlan,
  addTopup,
  canAfford,
  charge,
  accountView,
};
