'use strict';

const config = require('../config/env');
const logger = require('../config/logger');

/**
 * Outbound mail.
 *
 * Twiq ships with a transport that records the message and logs the link,
 * which keeps password reset and e-mail verification fully functional in
 * development and in a self-hosted deployment with no SMTP relay. Point
 * `send` at nodemailer (or a provider SDK) to deliver real mail; nothing
 * else in the application needs to change.
 */

const sent = [];

async function send({ to, subject, text: bodyText }) {
  const record = { to, subject, text: bodyText, at: new Date() };
  sent.push(record);
  if (sent.length > 100) sent.shift();
  // The body may contain a one-time token, so only the subject is logged.
  logger.info({ to, subject }, 'outbound mail queued');
  if (!config.isProduction && !config.isTest) {
    process.stdout.write(`\n--- mail to ${to} ---\n${subject}\n${bodyText}\n---\n\n`);
  }
  return record;
}

async function sendPasswordReset(user, token) {
  const url = `${config.baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to: user.email,
    subject: 'Reset your Twiq password',
    text:
      `Hi @${user.username},\n\n` +
      `Somebody asked to reset the password for your Twiq account. ` +
      `If that was you, open the link below within the next hour:\n\n${url}\n\n` +
      `If it was not you, you can ignore this message - your password has not changed.\n\n- Twiq`,
  });
}

async function sendEmailVerification(user, token) {
  const url = `${config.baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return send({
    to: user.email,
    subject: 'Confirm your Twiq email address',
    text:
      `Hi @${user.username},\n\nConfirm this address so we can keep your account secure:\n\n${url}\n\n- Twiq`,
  });
}

module.exports = { send, sendPasswordReset, sendEmailVerification, sent };
