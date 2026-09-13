'use strict';

const db = require('../config/db');

async function create({ userId, kind, storageKey, mimeType, byteSize, altText = '' }) {
  return db.one(
    `INSERT INTO media (user_id, kind, storage_key, mime_type, byte_size, alt_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, kind, storage_key, mime_type, byte_size`,
    [userId, kind, storageKey, mimeType, byteSize, String(altText || '').slice(0, 420)]
  );
}

async function findById(id) {
  return db.one('SELECT * FROM media WHERE id = $1', [id]);
}

async function findOwned(id, userId) {
  return db.one('SELECT * FROM media WHERE id = $1 AND user_id = $2', [id, userId]);
}

/** Uploads that were never attached to a Tweet or message. */
async function orphans(olderThanHours = 24, limit = 500) {
  return db.many(
    `SELECT m.id, m.storage_key FROM media m
      WHERE m.created_at < now() - ($1 || ' hours')::interval
        AND NOT EXISTS (SELECT 1 FROM tweet_media tm WHERE tm.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM messages ms WHERE ms.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_path = m.storage_key
                                                OR u.header_path = m.storage_key)
      LIMIT $2`,
    [String(olderThanHours), limit]
  );
}

async function remove(id) {
  await db.query('DELETE FROM media WHERE id = $1', [id]);
}

module.exports = { create, findById, findOwned, orphans, remove };
