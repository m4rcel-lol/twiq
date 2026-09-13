'use strict';

const db = require('../config/db');

/** Reports and the administrative audit trail. */

async function createReport({ reporterId, targetUserId = null, targetTweetId = null, category, details = '' }) {
  return db.one(
    `INSERT INTO reports (reporter_id, target_user_id, target_tweet_id, category, details)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [reporterId, targetUserId, targetTweetId, category, String(details || '').slice(0, 1000)]
  );
}

async function listReports({ status = 'open', limit = 50, offset = 0 } = {}) {
  return db.many(
    `SELECT r.*,
            rep.username AS reporter_username,
            tu.username  AS target_username,
            t.body       AS target_body,
            tw.username  AS target_tweet_username
       FROM reports r
       LEFT JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users tu  ON tu.id = r.target_user_id
       LEFT JOIN tweets t  ON t.id = r.target_tweet_id
       LEFT JOIN users tw  ON tw.id = t.user_id
      WHERE ($1 = 'all' OR r.status = $1)
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
}

async function resolveReport(reportId, moderatorId, status) {
  await db.query(
    `UPDATE reports SET status = $3, resolved_by = $2, resolved_at = now() WHERE id = $1`,
    [reportId, moderatorId, status]
  );
}

async function audit({ actorId, action, targetType = null, targetId = null, metadata = {}, ip = null }) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [actorId || null, action, targetType, targetId ? String(targetId) : null, JSON.stringify(metadata || {}), ip]
  );
}

async function auditLogs({ limit = 100, offset = 0 } = {}) {
  return db.many(
    `SELECT a.*, u.username AS actor_username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}

async function getSystemSetting(key, fallback = null) {
  const row = await db.one('SELECT value FROM system_settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

async function setSystemSetting(key, value, actorId = null) {
  await db.query(
    `INSERT INTO system_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                                     updated_by = EXCLUDED.updated_by,
                                     updated_at = now()`,
    [key, JSON.stringify(value), actorId]
  );
}

async function allSystemSettings() {
  return db.many('SELECT key, value, updated_at FROM system_settings ORDER BY key');
}

module.exports = {
  createReport,
  listReports,
  resolveReport,
  audit,
  auditLogs,
  getSystemSetting,
  setSystemSetting,
  allSystemSettings,
};
