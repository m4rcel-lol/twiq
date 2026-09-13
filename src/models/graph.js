'use strict';

const db = require('../config/db');
const userModel = require('./user');
const { forbidden, badRequest } = require('../utils/errors');

/**
 * The social graph: follows, follow requests for protected accounts,
 * blocks and mutes. Counter columns are maintained inside the same
 * transaction as the row they describe.
 */

async function isFollowing(followerId, followeeId) {
  if (!followerId || !followeeId) return false;
  const row = await db.one('SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2', [
    followerId,
    followeeId,
  ]);
  return Boolean(row);
}

async function hasRequested(requesterId, targetId) {
  if (!requesterId || !targetId) return false;
  const row = await db.one(
    'SELECT 1 FROM follow_requests WHERE requester_id = $1 AND target_id = $2',
    [requesterId, targetId]
  );
  return Boolean(row);
}

async function isBlocked(aId, bId) {
  if (!aId || !bId) return false;
  const row = await db.one(
    `SELECT 1 FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [aId, bId]
  );
  return Boolean(row);
}

async function blocking(blockerId, blockedId) {
  if (!blockerId || !blockedId) return false;
  const row = await db.one('SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
    blockerId,
    blockedId,
  ]);
  return Boolean(row);
}

async function isMuted(muterId, mutedId) {
  if (!muterId || !mutedId) return false;
  const row = await db.one('SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2', [muterId, mutedId]);
  return Boolean(row);
}

/**
 * Follow a user. Protected accounts receive a follow request instead.
 * Returns { state: 'following' | 'requested' | 'unchanged' }.
 */
async function follow(followerId, target) {
  if (Number(followerId) === Number(target.id)) throw badRequest('You cannot follow yourself.');
  if (await isBlocked(followerId, target.id)) throw forbidden('You cannot follow that account.');
  if (target.is_suspended) throw forbidden('That account is suspended.');

  if (target.is_protected) {
    if (await isFollowing(followerId, target.id)) return { state: 'following' };
    const inserted = await db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO follow_requests (requester_id, target_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING requester_id`,
        [followerId, target.id]
      );
      if (result.rowCount > 0) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, 'follow_request')`,
          [target.id, followerId]
        );
      }
      return result.rowCount > 0;
    });
    return { state: 'requested', created: inserted };
  }

  const created = await db.transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING follower_id`,
      [followerId, target.id]
    );
    if (result.rowCount === 0) return false;
    await client.query('UPDATE users SET following_count = following_count + 1 WHERE id = $1', [followerId]);
    await client.query('UPDATE users SET follower_count = follower_count + 1 WHERE id = $1', [target.id]);
    await client.query(
      `INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, 'follow')`,
      [target.id, followerId]
    );
    return true;
  });
  return { state: 'following', created };
}

async function unfollow(followerId, followeeId) {
  return db.transaction(async (client) => {
    const result = await client.query(
      'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 RETURNING follower_id',
      [followerId, followeeId]
    );
    if (result.rowCount > 0) {
      await client.query(
        'UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1',
        [followerId]
      );
      await client.query(
        'UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1',
        [followeeId]
      );
    }
    await client.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [
      followerId,
      followeeId,
    ]);
    return { state: 'not_following' };
  });
}

async function cancelRequest(requesterId, targetId) {
  await db.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [
    requesterId,
    targetId,
  ]);
}

async function pendingRequests(targetId, limit = 50) {
  return db.many(
    `SELECT ${userModel.PUBLIC_COLUMNS}, fr.created_at AS requested_at
       FROM follow_requests fr JOIN users u ON u.id = fr.requester_id
      WHERE fr.target_id = $1 ORDER BY fr.created_at DESC LIMIT $2`,
    [targetId, limit]
  );
}

async function pendingRequestCount(targetId) {
  const row = await db.one('SELECT count(*)::int AS n FROM follow_requests WHERE target_id = $1', [targetId]);
  return row ? row.n : 0;
}

async function approveRequest(targetId, requesterId) {
  return db.transaction(async (client) => {
    const removed = await client.query(
      'DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2 RETURNING requester_id',
      [requesterId, targetId]
    );
    if (removed.rowCount === 0) return false;
    const inserted = await client.query(
      `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING follower_id`,
      [requesterId, targetId]
    );
    if (inserted.rowCount > 0) {
      await client.query('UPDATE users SET following_count = following_count + 1 WHERE id = $1', [requesterId]);
      await client.query('UPDATE users SET follower_count = follower_count + 1 WHERE id = $1', [targetId]);
      await client.query(
        `INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, 'follow')`,
        [requesterId, targetId]
      );
    }
    await client.query(
      `DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'follow_request'`,
      [targetId, requesterId]
    );
    return true;
  });
}

async function denyRequest(targetId, requesterId) {
  await db.transaction(async (client) => {
    await client.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [
      requesterId,
      targetId,
    ]);
    await client.query(
      `DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'follow_request'`,
      [targetId, requesterId]
    );
  });
}

/** Followers of `userId`, newest first, with the viewer's relationship. */
async function followers(userId, { viewerId = null, limit = 20, offset = 0 } = {}) {
  return db.many(
    `SELECT ${userModel.PUBLIC_COLUMNS},
            (vf.follower_id IS NOT NULL) AS viewer_follows,
            (vb.follower_id IS NOT NULL) AS follows_viewer
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       LEFT JOIN follows vf ON vf.follower_id = $2 AND vf.followee_id = u.id
       LEFT JOIN follows vb ON vb.follower_id = u.id AND vb.followee_id = $2
      WHERE f.followee_id = $1 AND u.is_suspended = false
      ORDER BY f.created_at DESC
      LIMIT $3 OFFSET $4`,
    [userId, viewerId, limit, offset]
  );
}

async function following(userId, { viewerId = null, limit = 20, offset = 0 } = {}) {
  return db.many(
    `SELECT ${userModel.PUBLIC_COLUMNS},
            (vf.follower_id IS NOT NULL) AS viewer_follows,
            (vb.follower_id IS NOT NULL) AS follows_viewer
       FROM follows f
       JOIN users u ON u.id = f.followee_id
       LEFT JOIN follows vf ON vf.follower_id = $2 AND vf.followee_id = u.id
       LEFT JOIN follows vb ON vb.follower_id = u.id AND vb.followee_id = $2
      WHERE f.follower_id = $1 AND u.is_suspended = false
      ORDER BY f.created_at DESC
      LIMIT $3 OFFSET $4`,
    [userId, viewerId, limit, offset]
  );
}

/** "Followed by alice, bob and 3 others" on a profile. */
async function followedBy(targetId, viewerId, limit = 2) {
  if (!viewerId || Number(viewerId) === Number(targetId)) return { users: [], total: 0 };
  const rows = await db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path
       FROM follows mine
       JOIN follows theirs ON theirs.follower_id = mine.followee_id AND theirs.followee_id = $1
       JOIN users u ON u.id = mine.followee_id
      WHERE mine.follower_id = $2
      ORDER BY u.follower_count DESC
      LIMIT $3`,
    [targetId, viewerId, limit + 8]
  );
  return { users: rows.slice(0, limit), total: rows.length };
}

async function block(blockerId, blockedId) {
  if (Number(blockerId) === Number(blockedId)) throw badRequest('You cannot block yourself.');
  await db.transaction(async (client) => {
    await client.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [blockerId, blockedId]
    );
    // A block severs the relationship in both directions.
    for (const [a, b] of [[blockerId, blockedId], [blockedId, blockerId]]) {
      const removed = await client.query(
        'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 RETURNING follower_id',
        [a, b]
      );
      if (removed.rowCount > 0) {
        await client.query(
          'UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1',
          [a]
        );
        await client.query(
          'UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1',
          [b]
        );
      }
    }
    await client.query(
      `DELETE FROM follow_requests
        WHERE (requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1)`,
      [blockerId, blockedId]
    );
  });
}

async function unblock(blockerId, blockedId) {
  await db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
}

async function mute(muterId, mutedId) {
  if (Number(muterId) === Number(mutedId)) throw badRequest('You cannot mute yourself.');
  await db.query('INSERT INTO mutes (muter_id, muted_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    muterId,
    mutedId,
  ]);
}

async function unmute(muterId, mutedId) {
  await db.query('DELETE FROM mutes WHERE muter_id = $1 AND muted_id = $2', [muterId, mutedId]);
}

async function blockedUsers(userId) {
  return db.many(
    `SELECT ${userModel.PUBLIC_COLUMNS}, b.created_at AS blocked_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [userId]
  );
}

async function mutedUsers(userId) {
  return db.many(
    `SELECT ${userModel.PUBLIC_COLUMNS}, m.created_at AS muted_at
       FROM mutes m JOIN users u ON u.id = m.muted_id
      WHERE m.muter_id = $1 ORDER BY m.created_at DESC`,
    [userId]
  );
}

/**
 * The viewer's relationship with a target account, in one round trip.
 */
async function relationship(viewerId, targetId) {
  const empty = {
    following: false,
    followed_by: false,
    requested: false,
    blocking: false,
    blocked_by: false,
    muting: false,
  };
  if (!viewerId || !targetId || Number(viewerId) === Number(targetId)) return empty;
  const row = await db.one(
    `SELECT
       EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2) AS following,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1) AS followed_by,
       EXISTS (SELECT 1 FROM follow_requests WHERE requester_id = $1 AND target_id = $2) AS requested,
       EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2) AS blocking,
       EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $2 AND blocked_id = $1) AS blocked_by,
       EXISTS (SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2) AS muting`,
    [viewerId, targetId]
  );
  return row || empty;
}

/**
 * Can `viewerId` read `author`'s Tweets? Protected accounts are visible to
 * approved followers and to the author; blocks hide content both ways.
 */
async function canViewTweets(viewerId, author) {
  if (!author || author.is_suspended) return false;
  if (viewerId && Number(viewerId) === Number(author.id)) return true;
  if (viewerId && (await isBlocked(viewerId, author.id))) return false;
  if (!author.is_protected) return true;
  if (!viewerId) return false;
  return isFollowing(viewerId, author.id);
}

module.exports = {
  isFollowing,
  hasRequested,
  isBlocked,
  blocking,
  isMuted,
  follow,
  unfollow,
  cancelRequest,
  pendingRequests,
  pendingRequestCount,
  approveRequest,
  denyRequest,
  followers,
  following,
  followedBy,
  block,
  unblock,
  mute,
  unmute,
  blockedUsers,
  mutedUsers,
  relationship,
  canViewTweets,
};
