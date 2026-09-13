'use strict';

const db = require('../config/db');
const { forbidden, notFound, badRequest } = require('../utils/errors');

/**
 * Direct Messages.
 *
 * A conversation is a row plus two participant rows. The default policy is
 * the 2014 one: you may only message somebody who follows you (mutual
 * follow), unless they have opted into messages from everyone.
 */

const MAX_BODY = 1000;

async function canMessage(senderId, recipientId) {
  if (Number(senderId) === Number(recipientId)) {
    return { allowed: false, reason: 'You cannot send a message to yourself.' };
  }
  const row = await db.one(
    `SELECT u.is_suspended,
            COALESCE(s.dm_policy, 'followers') AS dm_policy,
            EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1) AS recipient_follows_sender,
            EXISTS (SELECT 1 FROM blocks
                     WHERE (blocker_id = $1 AND blocked_id = $2)
                        OR (blocker_id = $2 AND blocked_id = $1)) AS blocked
       FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
      WHERE u.id = $2`,
    [senderId, recipientId]
  );
  if (!row) return { allowed: false, reason: 'That account does not exist.' };
  if (row.is_suspended) return { allowed: false, reason: 'That account is suspended.' };
  if (row.blocked) return { allowed: false, reason: 'You cannot message that account.' };
  if (row.dm_policy === 'nobody') {
    return { allowed: false, reason: 'That account is not accepting Direct Messages.' };
  }
  if (row.dm_policy === 'everyone') return { allowed: true };
  if (row.recipient_follows_sender) return { allowed: true };
  return {
    allowed: false,
    reason: 'You can only send Direct Messages to people who follow you.',
  };
}

/** Find the one-to-one conversation between two users, creating it if needed. */
async function findOrCreateConversation(userA, userB) {
  const existing = await db.one(
    `SELECT c.id
       FROM conversations c
       JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = $1
       JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = $2
      WHERE (SELECT count(*) FROM conversation_participants p WHERE p.conversation_id = c.id) = 2
      LIMIT 1`,
    [userA, userB]
  );
  if (existing) return existing.id;

  return db.transaction(async (client) => {
    const created = await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
    const id = created.rows[0].id;
    await client.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [id, userA, userB]
    );
    return id;
  });
}

async function isParticipant(conversationId, userId) {
  const row = await db.one(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return Boolean(row);
}

/** Conversation list for the inbox, newest activity first. */
async function conversations(userId, { limit = 30 } = {}) {
  return db.many(
    `SELECT c.id, c.last_message_at,
            o.id AS other_id, o.username AS other_username,
            o.display_name AS other_display_name, o.avatar_path AS other_avatar_path,
            o.is_verified AS other_is_verified, (o.role = 'admin') AS other_is_admin,
            o.is_official AS other_is_official,
            lm.body AS last_body, lm.sender_id AS last_sender_id,
            (lm.media_id IS NOT NULL) AS last_has_media,
            (SELECT count(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.is_deleted = false
                AND m.sender_id <> $1
                AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at))::int AS unread_count
       FROM conversation_participants p
       JOIN conversations c ON c.id = p.conversation_id
       JOIN conversation_participants op ON op.conversation_id = c.id AND op.user_id <> $1
       JOIN users o ON o.id = op.user_id
       LEFT JOIN LATERAL (
         SELECT m.body, m.sender_id, m.media_id FROM messages m
          WHERE m.conversation_id = c.id AND m.is_deleted = false
          ORDER BY m.created_at DESC LIMIT 1
       ) lm ON true
      WHERE p.user_id = $1 AND p.left_at IS NULL AND o.is_suspended = false
      ORDER BY c.last_message_at DESC
      LIMIT $2`,
    [userId, limit]
  );
}

async function totalUnread(userId) {
  if (!userId) return 0;
  const row = await db.one(
    `SELECT count(*)::int AS n
       FROM conversation_participants p
       JOIN messages m ON m.conversation_id = p.conversation_id
      WHERE p.user_id = $1 AND p.left_at IS NULL AND m.sender_id <> $1
        AND m.is_deleted = false
        AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)`,
    [userId]
  );
  return row ? row.n : 0;
}

async function messages(conversationId, { limit = 50, before = null } = {}) {
  const params = [conversationId, limit];
  let where = '';
  if (before) {
    params.push(before);
    where = 'AND m.id < $3';
  }
  const rows = await db.many(
    `SELECT m.id, m.body, m.created_at, m.sender_id, m.shared_tweet_id,
            md.id AS media_id, md.kind AS media_kind, md.storage_key AS media_key,
            u.username AS sender_username, u.display_name AS sender_display_name,
            u.avatar_path AS sender_avatar_path
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN media md ON md.id = m.media_id
      WHERE m.conversation_id = $1 AND m.is_deleted = false ${where}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
    params
  );
  return rows.reverse();
}

async function send({ conversationId, senderId, body = '', mediaId = null, sharedTweetId = null }) {
  const trimmed = String(body || '').trim();
  if (!trimmed && !mediaId && !sharedTweetId) throw badRequest('Your message is empty.');
  if (trimmed.length > MAX_BODY) throw badRequest(`Messages are limited to ${MAX_BODY} characters.`);
  if (!(await isParticipant(conversationId, senderId))) {
    throw forbidden('You are not part of that conversation.');
  }
  return db.transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, body, media_id, shared_tweet_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [conversationId, senderId, trimmed, mediaId, sharedTweetId]
    );
    await client.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
    await client.query(
      'UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, senderId]
    );
    // Re-open the conversation for anyone who had removed it.
    await client.query(
      'UPDATE conversation_participants SET left_at = NULL WHERE conversation_id = $1',
      [conversationId]
    );
    return inserted.rows[0];
  });
}

async function markRead(conversationId, userId) {
  await db.query(
    'UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
}

async function otherParticipant(conversationId, userId) {
  return db.one(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.is_verified, u.bio
       FROM conversation_participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = $1 AND p.user_id <> $2 LIMIT 1`,
    [conversationId, userId]
  );
}

/** Remove the conversation from one participant's inbox only. */
async function leaveConversation(conversationId, userId) {
  const result = await db.query(
    'UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  if (result.rowCount === 0) throw notFound('That conversation does not exist.');
}

/** Delete one of your own messages. */
async function deleteMessage(messageId, userId) {
  const result = await db.query(
    `UPDATE messages SET is_deleted = true, body = '' WHERE id = $1 AND sender_id = $2`,
    [messageId, userId]
  );
  if (result.rowCount === 0) throw forbidden('You can only delete your own messages.');
}

module.exports = {
  MAX_BODY,
  canMessage,
  findOrCreateConversation,
  isParticipant,
  conversations,
  totalUnread,
  messages,
  send,
  markRead,
  otherParticipant,
  leaveConversation,
  deleteMessage,
};
