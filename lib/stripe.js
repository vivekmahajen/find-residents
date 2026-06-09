'use strict';

/*
 * Stripe Checkout integration (hosted checkout + webhooks). Lazy-loaded so the
 * app runs without Stripe; when STRIPE_SECRET_KEY is unset the rest of the app
 * falls back to instant (no-charge) plan changes.
 *
 * Required env to enable real billing:
 *   STRIPE_SECRET_KEY       - sk_test_... / sk_live_...
 *   STRIPE_WEBHOOK_SECRET   - whsec_... (for /api/stripe/webhook signature check)
 *   BASE_URL                - optional; success/cancel URLs (else derived from request)
 */

const pricing = require('./pricing');

class StripeUnavailable extends Error {}

function enabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new StripeUnavailable('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  }
  let mod;
  try {
    mod = require('stripe');
  } catch {
    throw new StripeUnavailable('Stripe SDK not installed. Run: npm install stripe');
  }
  const Stripe = mod.default || mod;
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Subscription Checkout for a paid plan. Uses inline price_data so no Stripe
// dashboard Price objects need to be pre-created.
async function createPlanCheckout({ user, plan, annual, baseUrl }) {
  const stripe = getStripe();
  const billing = pricing.planBilling(plan, annual);
  if (!billing) throw new StripeUnavailable('That plan is not purchasable.');

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: `${plan.name} plan${annual ? ' (annual)' : ''}` },
          unit_amount: billing.unitAmount,
          recurring: { interval: billing.interval },
        },
        quantity: 1,
      },
    ],
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: { kind: 'plan', userId: user.id, planId: plan.id, annual: annual ? '1' : '0' },
    subscription_data: {
      metadata: { userId: user.id, planId: plan.id, annual: annual ? '1' : '0' },
    },
    success_url: `${baseUrl}/app?checkout=success`,
    cancel_url: `${baseUrl}/app?checkout=cancel`,
  });
  return session.url;
}

// One-time Checkout for a top-up credit pack.
async function createTopupCheckout({ user, pack, baseUrl }) {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: `${pack.credits.toLocaleString()} credit top-up` },
          unit_amount: pack.price * 100,
        },
        quantity: 1,
      },
    ],
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: { kind: 'topup', userId: user.id, credits: String(pack.credits) },
    success_url: `${baseUrl}/app?checkout=success`,
    cancel_url: `${baseUrl}/app?checkout=cancel`,
  });
  return session.url;
}

function constructEvent(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new StripeUnavailable('STRIPE_WEBHOOK_SECRET is not set.');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  StripeUnavailable,
  enabled,
  createPlanCheckout,
  createTopupCheckout,
  constructEvent,
};
