// Pricing widget — plan ladder, credit balance, top-ups. Pulled out of the
// workspace into its own sidebar option. Reuses the existing billing endpoints
// (/api/pricing, /api/account, /api/checkout/*, /api/plan, /api/topup).
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

export default {
  title: 'Pricing',
  requiresAuth: true,
  async mount(el, ctx) {
    el.innerHTML = `
      <div class="panel">
        <div class="plan-head"><h1>Pricing &amp; credits</h1>
          <label class="annual-toggle"><input type="checkbox" id="annual"/> Annual <span class="muted">(save more)</span></label>
        </div>
        <div id="balance" class="balance"></div>
        <p id="status" class="plan-status" aria-live="polite"></p>
        <div id="ladder" class="tier-ladder"></div>
        <h3>Top-ups</h3>
        <div id="topups" class="topups"></div>
        <h3>How credits work</h3>
        <div id="faq" class="faq-body"></div>
      </div>`;
    const ctrl = new AbortController();
    const $ = (id) => el.querySelector('#' + id);
    let MODEL = null; let account = null;

    function renderBalance() {
      if (!account) { $('balance').innerHTML = ''; return; }
      if (account.admin) { $('balance').innerHTML = '<span class="bal-credits">Unlimited</span><span class="bal-plan">Admin · no billing</span>'; return; }
      const over = account.overageUsd > 0 ? ` · <span class="over">${money(account.overageUsd)} overage</span>` : '';
      const due = account.pastDue ? ' · <span class="over">payment past due</span>' : '';
      $('balance').innerHTML =
        `<span class="bal-credits">${Number(account.totalCredits || 0).toLocaleString()} credits</span>` +
        `<span class="bal-plan">${esc(account.planName)}${account.annual ? ' · annual' : ''}${over}${due}</span>`;
    }

    function renderLadder() {
      const annual = $('annual').checked;
      $('ladder').innerHTML = MODEL.plans.map((p) => {
        let priceLine;
        if (p.custom) priceLine = '<div class="tier-price">Custom</div>';
        else if (p.monthly === 0) priceLine = '<div class="tier-price">$0</div>';
        else {
          const m = annual ? p.annualMonthly : p.monthly;
          priceLine = `<div class="tier-price">${money(m)}<span class="per">/mo</span></div>` + (annual ? '<div class="tier-sub muted">billed annually</div>' : '');
        }
        const eff = p.effPerDeck != null ? `${money(p.effPerDeck)}/deck` : '';
        const credits = p.credits != null ? `${p.credits.toLocaleString()} credits${p.oneTime ? ' (one-time)' : '/mo'}` : 'Custom credits';
        const isCurrent = account && account.planId === p.id;
        const btn = p.custom
          ? '<button type="button" class="tier-btn" disabled>Contact sales</button>'
          : isCurrent ? '<button type="button" class="tier-btn" disabled>Current plan</button>'
            : `<button type="button" class="tier-btn primary-btn" data-plan="${esc(p.id)}">Choose ${esc(p.name)}</button>`;
        return `<div class="tier-card ${isCurrent ? 'current' : ''}">
          <div class="tier-name">${esc(p.name)}</div>${priceLine}
          <div class="tier-credits">${esc(credits)}</div>
          <ul class="tier-feats">${p.includedDecks ? `<li>~${p.includedDecks} decks</li>` : ''}${eff ? `<li>${eff} effective</li>` : ''}</ul>
          ${btn}</div>`;
      }).join('');
      $('ladder').querySelectorAll('.tier-btn[data-plan]:not([disabled])').forEach((b) => b.addEventListener('click', () => choosePlan(b.dataset.plan)));
    }

    function renderTopups() {
      $('topups').innerHTML = '';
      for (const t of MODEL.topupPacks) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'topup-btn';
        b.innerHTML = `+${t.credits.toLocaleString()} cr<span class="muted">${money(t.price)}</span>`;
        b.addEventListener('click', () => buyTopup(t.credits));
        $('topups').appendChild(b);
      }
    }

    function renderFaq() {
      const a = MODEL.actions.map((x) => `<li><strong>${esc(x.label)}</strong>: ${x.inPlanCredits} cr (${money(x.inPlanUsd)}) in-plan · ${x.overageCredits} cr (${money(x.overageUsd)}) overage</li>`).join('');
      $('faq').innerHTML = `<p>1 credit = ${money(MODEL.creditValueUsd)}. Each AI deliverable costs credits:</p><ul class="bullet">${a}</ul>
        <p>${esc(MODEL.rolloverPolicy)} Annual plans save ${MODEL.annualDiscountPct}%. On paid plans, work beyond your monthly credits is billed at the overage rate (${esc(MODEL.overageMode)}); the Free plan stops when credits run out.</p>`;
    }

    const stripeOn = () => MODEL && MODEL.stripeEnabled;

    async function choosePlan(planId) {
      if (stripeOn() && planId !== 'free') {
        $('status').textContent = 'Redirecting to secure checkout…';
        const r = await fetch('/api/checkout/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: planId, annual: $('annual').checked }) });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.url) { window.location.href = d.url; return; }
        $('status').textContent = d.error || 'Could not start checkout.'; return;
      }
      $('status').textContent = 'Updating plan…';
      const r = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: planId, annual: $('annual').checked }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { $('status').textContent = d.error || 'Could not change plan.'; return; }
      account = d.account; renderBalance(); renderLadder();
      $('status').textContent = `You're on ${account.planName}${account.annual ? ' (annual)' : ''}.`;
    }

    async function buyTopup(credits) {
      if (stripeOn()) {
        $('status').textContent = 'Redirecting to secure checkout…';
        const r = await fetch('/api/checkout/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credits }) });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.url) { window.location.href = d.url; return; }
        $('status').textContent = d.error || 'Could not start checkout.'; return;
      }
      $('status').textContent = 'Adding credits…';
      const r = await fetch('/api/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credits }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { $('status').textContent = d.error || 'Could not add credits.'; return; }
      account = d.account; renderBalance();
      $('status').textContent = `Added ${credits.toLocaleString()} credits.`;
    }

    try {
      MODEL = await (await fetch('/api/pricing', { signal: ctrl.signal })).json();
      const accR = await fetch('/api/account', { signal: ctrl.signal });
      account = accR.ok ? (await accR.json()).account : null;
      renderBalance(); renderLadder(); renderTopups(); renderFaq();
      $('annual').addEventListener('change', renderLadder);
    } catch (e) {
      if (e.name !== 'AbortError') $('status').innerHTML = `<span class="panel-error">${esc(e.message)}</span>`;
    }
    return () => ctrl.abort();
  },
};
