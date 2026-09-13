'use strict';

const db = require('../config/db');
const tweetModel = require('./tweet');

/**
 * Connect: the interactions timeline (follows, retweets, favorites,
 * replies and mentions).
 */

const SELECT = `
  SELECT n.id, n.type, n.tweet_id, n.read_at, n.created_at,
         a.id AS actor_id, a.username AS actor_username,
         a.display_name AS actor_display_name, a.avatar_path AS actor_avatar_path,
         a.is_verified AS actor_is_verified, a.bio AS actor_bio,
         (af.follower_id IS NOT NULL) AS viewer_follows_actor
    FROM notifications n
    JOIN users a ON a.id = n.actor_id
    LEFT JOIN follows af ON af.follower_id = n.user_id AND af.followee_id = n.actor_id
   WHERE n.user_id = $1 AND a.is_suspended = false
`;

/** `filter`: all | mentions */
async function list(userId, { filter = 'all', cursor = null, limit = 25 } = {}) {
  const params = [userId, limit + 1];
  let where = '';
  if (filter === 'mentions') where += ` AND n.type IN ('mention', 'reply')`;
  if (cursor) {
    params.push(cursor.at, cursor.id);
    where += ` AND (n.created_at, n.id) < ($3::timestamptz, $4::bigint)`;
  }
  const rows = await db.many(
    `${SELECT} ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const tweetIds = [...new Set(page.map((r) => r.tweet_id).filter(Boolean))];
  const tweets = await tweetModel.hydrate(tweetIds, userId);
  const byTweetId = new Map(tweets.map((t) => [Number(t.id), t]));
  const items = page.map((row) => ({ ...row, tweet: row.tweet_id ? byTweetId.get(Number(row.tweet_id)) : null }));

  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? { at: last.created_at, id: Number(last.id) } : null,
  };
}

async function unreadCount(userId) {
  if (!userId) return 0;
  const row = await db.one(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return row ? row.n : 0;
}

async function markAllRead(userId) {
  await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
}

module.exports = { list, unreadCount, markAllRead };
