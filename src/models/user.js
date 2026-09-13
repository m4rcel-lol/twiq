'use strict';

const db = require('../config/db');
const password = require('../services/password');
const { conflict } = require('../utils/errors');

const PUBLIC_COLUMNS = `
  u.id, u.username, u.display_name, u.bio, u.location, u.website,
  u.avatar_path, u.header_path, u.role, u.is_protected, u.is_verified,
  u.is_suspended, u.is_official, u.tweet_count, u.follower_count, u.following_count,
  u.favorite_count, u.list_count, u.created_at,
  u.automated_by_user_id,
  (SELECT au.username FROM users au WHERE au.id = u.automated_by_user_id) AS automated_by_username
`;

async function findById(id) {
  if (!id) return null;
  return db.one(`SELECT ${PUBLIC_COLUMNS}, u.email, u.email_verified_at FROM users u WHERE u.id = $1`, [id]);
}

async function findByUsername(username) {
  if (!username) return null;
  return db.one(`SELECT ${PUBLIC_COLUMNS} FROM users u WHERE u.username = $1`, [String(username)]);
}

async function findByEmail(email) {
  if (!email) return null;
  return db.one(`SELECT ${PUBLIC_COLUMNS}, u.email FROM users u WHERE u.email = $1`, [String(email)]);
}

/** Used by the login form, which accepts either a username or an e-mail. */
async function findForAuth(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  return db.one(
    `SELECT u.id, u.username, u.display_name, u.email, u.password_hash, u.role,
            u.is_suspended, u.suspended_reason, u.email_verified_at
       FROM users u
      WHERE u.username = $1 OR u.email = $1
      LIMIT 1`,
    [value]
  );
}

async function usernameTaken(username) {
  const row = await db.one('SELECT 1 FROM users WHERE username = $1', [String(username)]);
  return Boolean(row);
}

async function emailTaken(email) {
  const row = await db.one('SELECT 1 FROM users WHERE email = $1', [String(email)]);
  return Boolean(row);
}

/** Create a user plus its settings rows in a single transaction. */
async function create({ username, displayName, email, plainPassword, role = 'user', isVerified = false }) {
  const passwordHash = await password.hash(plainPassword);
  return db.transaction(async (client) => {
    let inserted;
    try {
      const result = await client.query(
        `INSERT INTO users (username, display_name, email, password_hash, role, is_verified)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, display_name, email, role, created_at`,
        [username, displayName, email, passwordHash, role, isVerified]
      );
      inserted = result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw conflict(
          err.constraint === 'users_email_key'
            ? 'That email address is already registered.'
            : 'That username is already taken.'
        );
      }
      throw err;
    }
    await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [inserted.id]);
    await client.query('INSERT INTO profile_settings (user_id) VALUES ($1)', [inserted.id]);
    return inserted;
  });
}

async function updateProfile(userId, fields) {
  const allowed = ['display_name', 'bio', 'location', 'website', 'is_protected'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(userId);
  values.push(userId);
  await db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
    values
  );
  return findById(userId);
}

/**
 * Record - or clear - the person who runs an automated account.
 *
 * The caller is responsible for having proved that the named account
 * consents; see the automation controller, which will not accept a name
 * without that account's own password.
 */
async function setOfficial(userId, isOfficial) {
  await db.query(
    'UPDATE users SET is_official = $2, updated_at = now() WHERE id = $1',
    [userId, Boolean(isOfficial)]
  );
}

async function setAutomatedBy(userId, operatorId) {
  await db.query(
    `UPDATE users
        SET automated_by_user_id = $2,
            automated_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id = $1`,
    [userId, operatorId]
  );
}

async function setAvatar(userId, storageKey) {
  const previous = await db.one('SELECT avatar_path FROM users WHERE id = $1', [userId]);
  await db.query('UPDATE users SET avatar_path = $2, updated_at = now() WHERE id = $1', [userId, storageKey]);
  return previous && previous.avatar_path;
}

async function setHeader(userId, storageKey) {
  const previous = await db.one('SELECT header_path FROM users WHERE id = $1', [userId]);
  await db.query('UPDATE users SET header_path = $2, updated_at = now() WHERE id = $1', [userId, storageKey]);
  return previous && previous.header_path;
}

async function updateEmail(userId, email) {
  try {
    await db.query(
      'UPDATE users SET email = $2, email_verified_at = NULL, updated_at = now() WHERE id = $1',
      [userId, email]
    );
  } catch (err) {
    if (err.code === '23505') throw conflict('That email address is already registered.');
    throw err;
  }
}

async function changePassword(userId, plainPassword) {
  const hash = await password.hash(plainPassword);
  await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, hash]);
}

async function getPasswordHash(userId) {
  const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return row && row.password_hash;
}

async function markLogin(userId) {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

async function getSettings(userId) {
  return db.one('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
}

async function updateSettings(userId, fields) {
  const allowed = [
    'dm_policy', 'discoverable_by_email', 'show_sensitive_media', 'notify_follows',
    'notify_mentions', 'notify_replies', 'notify_retweets', 'notify_favorites',
    'notify_messages', 'language', 'timezone', 'trend_scope_type', 'trend_scope_name',
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) return getSettings(userId);
  values.push(userId);
  await db.query(
    `UPDATE user_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${values.length}`,
    values
  );
  return getSettings(userId);
}

async function getProfileSettings(userId) {
  if (!userId) return null;
  return db.one('SELECT * FROM profile_settings WHERE user_id = $1', [userId]);
}

async function updateProfileSettings(userId, fields) {
  const allowed = ['accent_color', 'background_color', 'background_path', 'background_tile', 'theme'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) return getProfileSettings(userId);
  values.push(userId);
  await db.query(
    `UPDATE profile_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${values.length}`,
    values
  );
  return getProfileSettings(userId);
}

/** People search: prefix matches first, then trigram similarity. */
async function search(term, { viewerId = null, limit = 20, offset = 0 } = {}) {
  const q = String(term || '').replace(/^@/, '').trim();
  if (!q) return [];
  return db.many(
    `SELECT ${PUBLIC_COLUMNS},
            (f.follower_id IS NOT NULL) AS viewer_follows
       FROM users u
       LEFT JOIN follows f ON f.followee_id = u.id AND f.follower_id = $2
      WHERE u.is_suspended = false
        AND (u.username ILIKE $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
             OR u.username::text % $1 OR u.display_name % $1)
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = u.id AND b.blocked_id = $2)
                            OR (b.blocker_id = $2 AND b.blocked_id = u.id))
      ORDER BY (u.username ILIKE $1 || '%') DESC, u.follower_count DESC, u.id
      LIMIT $3 OFFSET $4`,
    [q, viewerId, limit, offset]
  );
}

async function listForAdmin({ term = '', limit = 50, offset = 0 } = {}) {
  const q = String(term || '').trim();
  if (q) {
    return db.many(
      `SELECT u.id, u.username, u.display_name, u.email, u.role, u.is_suspended,
              u.is_verified, u.tweet_count, u.follower_count, u.created_at, u.last_login_at
         FROM users u
        WHERE u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
              OR u.email ILIKE '%' || $1 || '%'
        ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [q, limit, offset]
    );
  }
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.is_suspended,
            u.is_verified, u.tweet_count, u.follower_count, u.created_at, u.last_login_at
       FROM users u ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}

async function setSuspended(userId, suspended, reason = null) {
  await db.query(
    'UPDATE users SET is_suspended = $2, suspended_reason = $3, updated_at = now() WHERE id = $1',
    [userId, suspended, reason]
  );
}

async function setRole(userId, role) {
  await db.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [userId, role]);
}

async function setVerified(userId, verified) {
  await db.query('UPDATE users SET is_verified = $2, updated_at = now() WHERE id = $1', [userId, verified]);
}

async function remove(userId) {
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
}

async function recordLoginAttempt({ identifier, ip, succeeded }) {
  await db.query(
    'INSERT INTO login_attempts (identifier, ip_address, succeeded) VALUES ($1, $2, $3)',
    [String(identifier || '').slice(0, 255), ip || null, succeeded]
  );
}

/** Recent consecutive failures, used to lock out credential stuffing. */
async function recentFailures(identifier, windowMinutes = 15) {
  const row = await db.one(
    `SELECT count(*)::int AS failures
       FROM login_attempts
      WHERE identifier = $1 AND succeeded = false
        AND created_at > now() - ($2 || ' minutes')::interval`,
    [String(identifier || '').slice(0, 255), String(windowMinutes)]
  );
  return row ? row.failures : 0;
}

async function stats() {
  return db.one(`
    SELECT (SELECT count(*) FROM users)::int AS users,
           (SELECT count(*) FROM users WHERE is_suspended)::int AS suspended,
           (SELECT count(*) FROM tweets WHERE is_deleted = false)::int AS tweets,
           (SELECT count(*) FROM reports WHERE status = 'open')::int AS open_reports,
           (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_users
  `);
}

module.exports = {
  PUBLIC_COLUMNS,
  findById,
  findByUsername,
  findByEmail,
  findForAuth,
  usernameTaken,
  emailTaken,
  create,
  updateProfile,
  setAutomatedBy,
  setOfficial,
  setAvatar,
  setHeader,
  updateEmail,
  changePassword,
  getPasswordHash,
  markLogin,
  getSettings,
  updateSettings,
  getProfileSettings,
  updateProfileSettings,
  search,
  listForAdmin,
  setSuspended,
  setRole,
  setVerified,
  remove,
  recordLoginAttempt,
  recentFailures,
  stats,
};
