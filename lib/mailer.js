'use strict';

/*
 * Provider-agnostic transactional/marketing email. Configure with:
 *   EMAIL_PROVIDER = resend | postmark | sendgrid
 *   EMAIL_API_KEY  = provider API key
 *   EMAIL_FROM     = verified sender (e.g. "Agency <no-reply@yourdomain.com>")
 *   EMAIL_PHYSICAL_ADDRESS = postal address (required in marketing footers, CAN-SPAM)
 *
 * Degrades gracefully: with no key it logs to the console and returns a dev
 * result, so password reset etc. still work locally. Marketing email gets a
 * CAN-SPAM footer (physical address + unsubscribe); transactional does not.
 */

const PROVIDER = String(process.env.EMAIL_PROVIDER || '').toLowerCase();
const API_KEY = process.env.EMAIL_API_KEY;
const FROM = process.env.EMAIL_FROM;
const PHYSICAL = process.env.EMAIL_PHYSICAL_ADDRESS || '';

function enabled() {
  return !!(API_KEY && FROM);
}

async function dispatch({ to, subject, html, text }) {
  if (PROVIDER === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
    return r.json();
  }
  if (PROVIDER === 'postmark') {
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'X-Postmark-Server-Token': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ From: FROM, To: to, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: 'outbound' }),
    });
    if (!r.ok) throw new Error(`Postmark ${r.status}: ${await r.text()}`);
    return r.json();
  }
  if (PROVIDER === 'sendgrid') {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM },
        subject,
        content: [{ type: 'text/plain', value: text || '' }, { type: 'text/html', value: html || '' }],
      }),
    });
    if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`);
    return { ok: true };
  }
  throw new Error(`Unknown EMAIL_PROVIDER "${PROVIDER}" (use resend | postmark | sendgrid).`);
}

// category: 'transactional' (default) | 'marketing'. Marketing adds CAN-SPAM footer.
async function send({ to, subject, html, text, category = 'transactional', unsubscribeUrl }) {
  let finalHtml = html;
  let finalText = text;
  if (category === 'marketing') {
    const addr = PHYSICAL || '[set EMAIL_PHYSICAL_ADDRESS]';
    const unsub = unsubscribeUrl ? `<a href="${unsubscribeUrl}">Unsubscribe</a>` : 'To unsubscribe, reply STOP.';
    finalHtml = `${html || ''}<hr><p style="font-size:12px;color:#888">${addr}<br>${unsub}</p>`;
    finalText = `${text || ''}\n\n${addr}\n${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : 'To unsubscribe, reply STOP.'}`;
  }
  if (!enabled()) {
    // eslint-disable-next-line no-console
    console.log(`[email:${category}] to=${to} | ${subject}${unsubscribeUrl ? ` | unsubscribe=${unsubscribeUrl}` : ''}`);
    return { ok: true, dev: true };
  }
  try {
    await dispatch({ to, subject, html: finalHtml, text: finalText });
    return { ok: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[email] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

async function sendPasswordReset(email, link) {
  return send({
    to: email,
    subject: 'Reset your password',
    category: 'transactional',
    html: `<p>We received a request to reset your password.</p><p><a href="${link}">Reset your password</a> — valid for 1 hour.</p><p>If you didn't request this, you can ignore this email.</p>`,
    text: `Reset your password (valid 1 hour): ${link}\nIf you didn't request this, ignore this email.`,
  });
}

async function sendReceipt(email, { description, amountUsd }) {
  const amt = amountUsd != null ? ` — $${Number(amountUsd).toFixed(2)}` : '';
  return send({
    to: email,
    subject: 'Your receipt',
    category: 'transactional',
    html: `<p>Thanks — your payment was received.</p><p>${description}${amt}</p>`,
    text: `Payment received. ${description}${amt}`,
  });
}

async function sendDunning(email) {
  return send({
    to: email,
    subject: 'Payment failed — action needed',
    category: 'transactional',
    html: `<p>Your most recent payment failed, so paid features are paused. Please update your payment method to restore access. Your Free-tier features remain available.</p>`,
    text: `Your most recent payment failed; paid features are paused. Update your payment method to restore access. Free-tier features remain available.`,
  });
}

module.exports = { enabled, send, sendPasswordReset, sendReceipt, sendDunning };
