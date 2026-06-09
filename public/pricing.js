'use strict';

(function () {
  const balanceEl = document.getElementById('balance');
  const ladderEl = document.getElementById('tier-ladder');
  const topupsEl = document.getElementById('topups');
  const annualToggle = document.getElementById('annual-toggle');
  const statusEl = document.getElementById('account-status');
  const faqEl = document.getElementById('faq-body');

  let MODEL = null;
  let account = null;

  function money(n) {
    return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // Expose action credit costs + a balance refresh for app.js.
  function publish() {
    window.PRICING = MODEL;
    window.ACCOUNT = account;
  }

  function renderBalance() {
    if (!account) return;
    const over = account.overageUsd > 0 ? ` · <span class="over">${money(account.overageUsd)} overage</span>` : '';
    balanceEl.innerHTML =
      `<span class="bal-credits">${account.totalCredits.toLocaleString()} credits</span>` +
      `<span class="bal-plan">${account.planName}${account.annual ? ' · annual' : ''}${over}</span>`;
  }

  function renderLadder() {
    const annual = annualToggle.checked;
    ladderEl.innerHTML = '';
    for (const p of MODEL.plans) {
      const card = document.createElement('div');
      card.className = 'tier-card' + (account && account.planId === p.id ? ' current' : '');
      let priceLine;
      if (p.custom) priceLine = '<div class="tier-price">Custom</div>';
      else if (p.monthly === 0) priceLine = '<div class="tier-price">$0</div>';
      else {
        const m = annual ? p.annualMonthly : p.monthly;
        priceLine = `<div class="tier-price">${money(m)}<span class="per">/mo</span></div>` +
          (annual ? `<div class="tier-sub muted">billed annually</div>` : '');
      }
      const decks = p.includedDecks ? `${p.includedDecks} decks` : (p.custom ? '—' : '');
      const eff = p.effPerDeck != null ? `${money(p.effPerDeck)}/deck` : '';
      const credits = p.credits != null ? `${p.credits.toLocaleString()} credits${p.oneTime ? ' (one-time)' : '/mo'}` : 'Custom credits';

      const isCurrent = account && account.planId === p.id;
      const btn = p.custom
        ? '<button type="button" class="tier-btn" data-plan="enterprise" disabled>Contact sales</button>'
        : isCurrent
          ? '<button type="button" class="tier-btn" disabled>Current plan</button>'
          : `<button type="button" class="tier-btn primary-btn" data-plan="${p.id}">Choose ${p.name}</button>`;

      card.innerHTML = `
        <div class="tier-name">${p.name}</div>
        ${priceLine}
        <div class="tier-credits">${credits}</div>
        <ul class="tier-feats">
          ${decks ? `<li>~${decks}</li>` : ''}
          ${eff ? `<li>${eff} effective</li>` : ''}
        </ul>
        ${btn}
      `;
      ladderEl.appendChild(card);
    }
    ladderEl.querySelectorAll('.tier-btn[data-plan]:not([disabled])').forEach((b) => {
      b.addEventListener('click', () => choosePlan(b.dataset.plan));
    });
  }

  function renderTopups() {
    topupsEl.innerHTML = '';
    for (const t of MODEL.topupPacks) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'topup-btn';
      b.innerHTML = `+${t.credits.toLocaleString()} cr<span class="muted">${money(t.price)}</span>`;
      b.addEventListener('click', () => buyTopup(t.credits));
      topupsEl.appendChild(b);
    }
  }

  function renderFaq() {
    const a = MODEL.actions.map((x) => `<li><strong>${x.label}</strong>: ${x.inPlanCredits} cr (${money(x.inPlanUsd)}) in-plan · ${x.overageCredits} cr (${money(x.overageUsd)}) overage</li>`).join('');
    faqEl.innerHTML = `
      <p>1 credit = ${money(MODEL.creditValueUsd)}. Each AI deliverable costs credits:</p>
      <ul class="bullet">${a}</ul>
      <p>${MODEL.rolloverPolicy} Annual plans save ${MODEL.annualDiscountPct}%. On paid plans, work beyond your monthly credits is billed at the overage rate (${MODEL.overageMode}); the Free plan stops when credits run out.</p>`;
  }

  const stripeOn = () => MODEL && MODEL.stripeEnabled;

  async function choosePlan(planId) {
    // Paid plans with Stripe live → hosted checkout. Free / no-Stripe → instant.
    if (stripeOn() && planId !== 'free') {
      statusEl.textContent = 'Redirecting to secure checkout…';
      const resp = await fetch('/api/checkout/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId, annual: annualToggle.checked }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.url) { window.location.href = data.url; return; }
      statusEl.textContent = data.error || 'Could not start checkout.';
      return;
    }
    statusEl.textContent = 'Updating plan…';
    const resp = await fetch('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: planId, annual: annualToggle.checked }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { statusEl.textContent = data.error || 'Could not change plan.'; return; }
    account = data.account; publish();
    renderBalance(); renderLadder();
    statusEl.textContent = `You're on ${account.planName}${account.annual ? ' (annual)' : ''}.`;
  }

  async function buyTopup(credits) {
    if (stripeOn()) {
      statusEl.textContent = 'Redirecting to secure checkout…';
      const resp = await fetch('/api/checkout/topup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credits }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.url) { window.location.href = data.url; return; }
      statusEl.textContent = data.error || 'Could not start checkout.';
      return;
    }
    statusEl.textContent = 'Adding credits…';
    const resp = await fetch('/api/topup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { statusEl.textContent = data.error || 'Could not add credits.'; return; }
    account = data.account; publish();
    renderBalance();
    statusEl.textContent = `Added ${credits.toLocaleString()} credits.`;
  }

  // After returning from Stripe Checkout, fulfillment happens via webhook
  // (a few seconds). Refresh the balance a few times so it reflects soon.
  function handleCheckoutReturn() {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('checkout');
    if (!r) return;
    history.replaceState({}, '', '/app'); // clean the URL
    if (r === 'cancel') { statusEl.textContent = 'Checkout canceled.'; return; }
    if (r === 'success') {
      statusEl.textContent = 'Payment received — updating your account…';
      let n = 0;
      const tick = () => {
        window.refreshAccount().then(() => {
          renderLadder();
          if (++n < 5) setTimeout(tick, 1500);
          else statusEl.textContent = 'Account updated.';
        });
      };
      setTimeout(tick, 1200);
    }
  }

  // Called by app.js after an action returns an updated account, or to refresh.
  window.setAccount = function (acct) {
    if (!acct) return;
    account = acct; publish(); renderBalance(); if (MODEL) renderLadder();
  };
  window.refreshAccount = async function () {
    try {
      const r = await fetch('/api/account');
      if (r.ok) window.setAccount((await r.json()).account);
    } catch { /* ignore */ }
  };

  annualToggle.addEventListener('change', renderLadder);

  (async function init() {
    try {
      MODEL = await (await fetch('/api/pricing')).json();
      const accResp = await fetch('/api/account');
      account = accResp.ok ? (await accResp.json()).account : null;
      publish();
      // Update the cost hints in the header.
      const dCost = MODEL.actions.find((a) => a.key === 'document');
      const kCost = MODEL.actions.find((a) => a.key === 'deck');
      if (dCost) document.getElementById('cost-document').textContent = dCost.inPlanCredits;
      if (kCost) document.getElementById('cost-deck').textContent = kCost.inPlanCredits;
      renderBalance();
      renderLadder();
      renderTopups();
      renderFaq();
      handleCheckoutReturn();
    } catch {
      if (balanceEl) balanceEl.textContent = '';
    }
  })();
})();
