'use strict';

const db = require('../config/db');
const password = require('../services/password');

/**
 * One-time tokens for password resets and e-mail verification.
 * Only the SHA-256 of a token is stored, so a database leak cannot be
 * replayed against the reset endpoint.
 */

const RESET_TTL_MINUTES = 60;
const VERIFY_TTL_HOURS = 48;

async function createPasswordReset(userId) {
  const token = password.randomToken(32);
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [userId, password.hashToken(token), String(RESET_TTL_MINUTES)]
  );
  return token;
}

async function consumePasswordReset(token) {
  const row = await db.one(
    `UPDATE password_resets SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [password.hashToken(token)]
  );
  return row ? Number(row.user_id) : null;
}

async function createEmailVerification(userId, email) {
  const token = password.randomToken(32);
  await db.query(
    `INSERT INTO email_verifications (user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)`,
    [userId, email, password.hashToken(token), String(VERIFY_TTL_HOURS)]
  );
  return token;
}

async function consumeEmailVerification(token) {
  const row = await db.one(
    `UPDATE email_verifications SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, email`,
    [password.hashToken(token)]
  );
  if (!row) return null;
  await db.query(
    'UPDATE users SET email_verified_at = now() WHERE id = $1 AND email = $2',
    [row.user_id, row.email]
  );
  return { userId: Number(row.user_id), email: row.email };
}

module.exports = {
  RESET_TTL_MINUTES,
  VERIFY_TTL_HOURS,
  createPasswordReset,
  consumePasswordReset,
  createEmailVerification,
  consumeEmailVerification,
};
