'use strict';

/*
 * Email sending. No SMTP/provider is wired up in this build, so the reset link
 * is logged to the server console. For production, replace the body of
 * sendPasswordReset() with a real provider (e.g. SendGrid, SES, Postmark) and
 * stop returning the link to the client (see server.js handleForgot).
 */

const EMAIL_ENABLED = Boolean(process.env.SMTP_URL || process.env.EMAIL_PROVIDER);

async function sendPasswordReset(email, link) {
  // eslint-disable-next-line no-console
  console.log(`[password-reset] To: ${email}\n[password-reset] Link: ${link}`);
  // TODO: integrate a real email provider here when EMAIL_ENABLED.
}

module.exports = { sendPasswordReset, EMAIL_ENABLED };
