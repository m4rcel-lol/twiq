'use strict';

const db = require('../config/db');
const text = require('../services/text');
const { badRequest, notFound, forbidden } = require('../utils/errors');
const config = require('../config/env');

/**
 * Tweets, retweets, favorites and every timeline that reads them.
 *
 * Every timeline runs in two steps: one keyset query that selects the ids
 * for the page, then a single hydration query that joins authors, media and
 * the viewer's own favorite/retweet state. That keeps a page of the timeline
 * at two queries no matter how many Tweets it contains.
 */

const HYDRATE_SQL = `
  SELECT t.id, t.user_id, t.body, t.created_at, t.reply_count, t.retweet_count,
         t.favorite_count, t.quote_count, t.has_media,
         t.in_reply_to_tweet_id, t.in_reply_to_user_id, t.quoted_tweet_id,
         t.conversation_id,
         u.username        AS author_username,
         u.display_name    AS author_display_name,
         u.avatar_path     AS author_avatar_path,
         u.is_verified     AS author_is_verified,
         (u.role = 'admin') AS author_is_admin,
         u.is_official     AS author_is_official,
         u.is_protected    AS author_is_protected,
         (u.automated_by_user_id IS NOT NULL) AS author_is_automated,
         ru.username       AS reply_to_username,
         (fav.user_id IS NOT NULL) AS viewer_favorited,
         (rtw.user_id IS NOT NULL) AS viewer_retweeted,
         (pin.user_id IS NOT NULL) AS is_pinned,
         COALESCE(m.items, '[]'::json) AS media
    FROM tweets t
    JOIN users u  ON u.id = t.user_id
    LEFT JOIN users ru ON ru.id = t.in_reply_to_user_id
    LEFT JOIN favorites fav ON fav.tweet_id = t.id AND fav.user_id = $2
    LEFT JOIN retweets  rtw ON rtw.tweet_id = t.id AND rtw.user_id = $2
    LEFT JOIN pinned_tweets pin ON pin.tweet_id = t.id AND pin.user_id = t.user_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'id', md.id, 'kind', md.kind, 'key', md.storage_key,
               'mime', md.mime_type, 'alt', md.alt_text
             ) ORDER BY tm.position, md.id) AS items
        FROM tweet_media tm JOIN media md ON md.id = tm.media_id
       WHERE tm.tweet_id = t.id
    ) m ON true
   WHERE t.id = ANY($1::bigint[]) AND t.is_deleted = false
`;

/** Fetch full rows for a set of tweet ids, preserving the given order. */
async function hydrate(ids, viewerId = null, { withQuoted = true } = {}) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (list.length === 0) return [];
  const rows = await db.many(HYDRATE_SQL, [list, viewerId]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const ordered = list.map((id) => byId.get(Number(id))).filter(Boolean);
  if (withQuoted) await attachQuoted(ordered, viewerId);
  return ordered;
}

/**
 * Fill in the Tweet each row quotes, in one extra query for the whole page.
 * Deliberately one level deep: a quote of a quote shows the card it points
 * at, not the whole chain behind it.
 */
async function attachQuoted(rows, viewerId) {
  const wanted = [...new Set(rows.map((r) => Number(r.quoted_tweet_id)).filter(Boolean))];
  if (wanted.length === 0) return;
  const quoted = await hydrate(wanted, viewerId, { withQuoted: false });
  const byId = new Map(quoted.map((r) => [Number(r.id), r]));
  rows.forEach((row) => {
    if (!row.quoted_tweet_id) return;
    // A missing row means it was deleted or is not visible; the card says so.
    row.quoted_row = byId.get(Number(row.quoted_tweet_id)) || null;
  });
}

/** Turn timeline "events" (tweet or retweet) into hydrated, ordered rows. */
async function hydrateEvents(events, viewerId = null) {
  if (events.length === 0) return [];
  // One Tweet can reach a timeline several times (the original plus a retweet
  // from each person you follow). Keep only the first, newest occurrence.
  const seen = new Set();
  events = events.filter((event) => {
    const key = Number(event.tweet_id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rows = await hydrate(events.map((e) => e.tweet_id), viewerId);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const out = [];
  for (const event of events) {
    const row = byId.get(Number(event.tweet_id));
    if (!row) continue;
    out.push({
      ...row,
      retweeter_id: event.retweeter_id || null,
      retweeter_username: event.retweeter_username || null,
      retweeter_display_name: event.retweeter_display_name || null,
      sort_at: event.sort_at,
      sort_id: event.sort_id,
    });
  }
  return out;
}

function cursorClause(cursor, paramIndex) {
  if (!cursor) return { sql: '', params: [] };
  return {
    sql: `AND (e.sort_at, e.sort_id) < ($${paramIndex}::timestamptz, $${paramIndex + 1}::bigint)`,
    params: [cursor.at, cursor.id],
  };
}

// --------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------

/**
 * Create a Tweet. Entities (hashtags, mentions), media attachments,
 * counters and notifications are all written in one transaction.
 */
async function create({ userId, body, mediaIds = [], inReplyToTweetId = null, quotedTweetId = null }) {
  const trimmed = String(body || '').replace(/\r\n/g, '\n').trim();
  const length = text.tweetLength(trimmed);
  if (length === 0 && mediaIds.length === 0 && !quotedTweetId) throw badRequest('Your Tweet is empty.');
  if (length > config.brand.tweetMaxLength) {
    throw badRequest(`Tweets are limited to ${config.brand.tweetMaxLength} characters.`);
  }

  const hashtags = text.extractHashtags(trimmed);
  const mentions = text.extractMentions(trimmed);

  return db.transaction(async (client) => {
    let parent = null;
    if (inReplyToTweetId) {
      const found = await client.query(
        `SELECT t.id, t.user_id, t.conversation_id, u.username
           FROM tweets t JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 AND t.is_deleted = false`,
        [inReplyToTweetId]
      );
      parent = found.rows[0] || null;
      if (!parent) throw notFound('The Tweet you are replying to no longer exists.');
      const blocked = await client.query(
        `SELECT 1 FROM blocks
          WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [userId, parent.user_id]
      );
      if (blocked.rowCount > 0) throw forbidden('You cannot reply to that Tweet.');
    }

    let quoted = null;
    if (quotedTweetId) {
      const found = await client.query(
        `SELECT t.id, t.user_id FROM tweets t
           JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 AND t.is_deleted = false`,
        [quotedTweetId]
      );
      quoted = found.rows[0] || null;
      if (!quoted) throw notFound('The Tweet you are quoting no longer exists.');
      const blocked = await client.query(
        `SELECT 1 FROM blocks
          WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [userId, quoted.user_id]
      );
      if (blocked.rowCount > 0) throw forbidden('You cannot quote that Tweet.');
    }

    const inserted = await client.query(
      `INSERT INTO tweets (user_id, body, in_reply_to_tweet_id, in_reply_to_user_id, has_media, quoted_tweet_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, body, created_at`,
      [userId, trimmed, parent ? parent.id : null, parent ? parent.user_id : null,
       mediaIds.length > 0, quoted ? quoted.id : null]
    );
    const tweet = inserted.rows[0];

    if (quoted) {
      await client.query('UPDATE tweets SET quote_count = quote_count + 1 WHERE id = $1', [quoted.id]);
      if (Number(quoted.user_id) !== Number(userId)) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, type, tweet_id) VALUES ($1, $2, 'quote', $3)`,
          [quoted.user_id, userId, tweet.id]
        );
      }
    }

    await client.query('UPDATE tweets SET conversation_id = $2 WHERE id = $1', [
      tweet.id,
      parent ? parent.conversation_id || parent.id : tweet.id,
    ]);

    if (parent) {
      await client.query('UPDATE tweets SET reply_count = reply_count + 1 WHERE id = $1', [parent.id]);
      if (Number(parent.user_id) !== Number(userId)) {
        await client.query(
          `INSERT INTO notifications (user_id, actor_id, type, tweet_id) VALUES ($1, $2, 'reply', $3)`,
          [parent.user_id, userId, tweet.id]
        );
      }
    }

    if (mediaIds.length > 0) {
      // Only attach media the author uploaded and has not attached elsewhere.
      const owned = await client.query(
        `SELECT m.id FROM media m
          WHERE m.id = ANY($1::bigint[]) AND m.user_id = $2
            AND NOT EXISTS (SELECT 1 FROM tweet_media tm WHERE tm.media_id = m.id)`,
        [mediaIds.map(Number), userId]
      );
      let position = 0;
      for (const row of owned.rows) {
        await client.query(
          'INSERT INTO tweet_media (tweet_id, media_id, position) VALUES ($1, $2, $3)',
          [tweet.id, row.id, position]
        );
        position += 1;
      }
      if (position === 0) {
        await client.query('UPDATE tweets SET has_media = false WHERE id = $1', [tweet.id]);
      }
    }

    for (const tag of hashtags) {
      const tagRow = await client.query(
        `INSERT INTO hashtags (tag) VALUES ($1)
         ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag
         RETURNING id`,
        [tag]
      );
      await client.query(
        'INSERT INTO tweet_hashtags (tweet_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [tweet.id, tagRow.rows[0].id]
      );
    }

    if (mentions.length > 0) {
      const mentioned = await client.query(
        `SELECT u.id FROM users u
          WHERE u.username = ANY($1::citext[]) AND u.id <> $2 AND u.is_suspended = false
            AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE (b.blocker_id = u.id AND b.blocked_id = $2)
                                OR (b.blocker_id = $2 AND b.blocked_id = u.id))`,
        [mentions, userId]
      );
      for (const row of mentioned.rows) {
        await client.query(
          'INSERT INTO tweet_mentions (tweet_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [tweet.id, row.id]
        );
        // A reply already notified the parent author; do not notify twice.
        if (!parent || Number(parent.user_id) !== Number(row.id)) {
          await client.query(
            `INSERT INTO notifications (user_id, actor_id, type, tweet_id) VALUES ($1, $2, 'mention', $3)`,
            [row.id, userId, tweet.id]
          );
        }
      }
    }

    await client.query('UPDATE users SET tweet_count = tweet_count + 1 WHERE id = $1', [userId]);
    return tweet;
  });
}

async function findById(id, viewerId = null) {
  const rows = await hydrate([id], viewerId);
  return rows[0] || null;
}

async function findRaw(id) {
  return db.one('SELECT * FROM tweets WHERE id = $1 AND is_deleted = false', [id]);
}

/** Soft-delete: the row stays for referential integrity, content is cleared. */
async function remove(tweetId, actorId, { force = false } = {}) {
  return db.transaction(async (client) => {
    const found = await client.query(
      'SELECT id, user_id, in_reply_to_tweet_id, quoted_tweet_id, is_deleted FROM tweets WHERE id = $1',
      [tweetId]
    );
    const tweet = found.rows[0];
    if (!tweet || tweet.is_deleted) throw notFound('That Tweet no longer exists.');
    if (!force && Number(tweet.user_id) !== Number(actorId)) {
      throw forbidden('You can only delete your own Tweets.');
    }
    await client.query(
      `UPDATE tweets SET is_deleted = true, deleted_at = now(), body = '', has_media = false
        WHERE id = $1`,
      [tweetId]
    );
    await client.query('UPDATE users SET tweet_count = GREATEST(tweet_count - 1, 0) WHERE id = $1', [
      tweet.user_id,
    ]);
    if (tweet.in_reply_to_tweet_id) {
      await client.query('UPDATE tweets SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1', [
        tweet.in_reply_to_tweet_id,
      ]);
    }
    if (tweet.quoted_tweet_id) {
      await client.query('UPDATE tweets SET quote_count = GREATEST(quote_count - 1, 0) WHERE id = $1', [
        tweet.quoted_tweet_id,
      ]);
    }
    await client.query('DELETE FROM pinned_tweets WHERE tweet_id = $1', [tweetId]);
    await client.query('DELETE FROM notifications WHERE tweet_id = $1', [tweetId]);
    return tweet;
  });
}

// --------------------------------------------------------------------------
// Favorites and retweets
// --------------------------------------------------------------------------

async function favorite(userId, tweetId) {
  return db.transaction(async (client) => {
    const found = await client.query(
      'SELECT id, user_id FROM tweets WHERE id = $1 AND is_deleted = false',
      [tweetId]
    );
    const tweet = found.rows[0];
    if (!tweet) throw notFound('That Tweet no longer exists.');
    const inserted = await client.query(
      'INSERT INTO favorites (user_id, tweet_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id',
      [userId, tweetId]
    );
    if (inserted.rowCount === 0) {
      const current = await client.query('SELECT favorite_count FROM tweets WHERE id = $1', [tweetId]);
      return { favorited: true, count: current.rows[0].favorite_count };
    }
    const updated = await client.query(
      'UPDATE tweets SET favorite_count = favorite_count + 1 WHERE id = $1 RETURNING favorite_count',
      [tweetId]
    );
    await client.query('UPDATE users SET favorite_count = favorite_count + 1 WHERE id = $1', [userId]);
    if (Number(tweet.user_id) !== Number(userId)) {
      await client.query(
        `INSERT INTO notifications (user_id, actor_id, type, tweet_id) VALUES ($1, $2, 'favorite', $3)`,
        [tweet.user_id, userId, tweetId]
      );
    }
    return { favorited: true, count: updated.rows[0].favorite_count, notifyUserId: tweet.user_id };
  });
}

async function unfavorite(userId, tweetId) {
  return db.transaction(async (client) => {
    const removed = await client.query(
      'DELETE FROM favorites WHERE user_id = $1 AND tweet_id = $2 RETURNING user_id',
      [userId, tweetId]
    );
    const current = await client.query('SELECT favorite_count FROM tweets WHERE id = $1', [tweetId]);
    if (removed.rowCount === 0) {
      return { favorited: false, count: current.rows[0] ? current.rows[0].favorite_count : 0 };
    }
    const updated = await client.query(
      'UPDATE tweets SET favorite_count = GREATEST(favorite_count - 1, 0) WHERE id = $1 RETURNING favorite_count',
      [tweetId]
    );
    await client.query('UPDATE users SET favorite_count = GREATEST(favorite_count - 1, 0) WHERE id = $1', [
      userId,
    ]);
    await client.query(
      `DELETE FROM notifications WHERE user_id = (SELECT user_id FROM tweets WHERE id = $2)
         AND actor_id = $1 AND tweet_id = $2 AND type = 'favorite'`,
      [userId, tweetId]
    );
    return { favorited: false, count: updated.rows[0].favorite_count };
  });
}

async function retweet(userId, tweetId) {
  return db.transaction(async (client) => {
    const found = await client.query(
      `SELECT t.id, t.user_id, u.is_protected
         FROM tweets t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1 AND t.is_deleted = false`,
      [tweetId]
    );
    const tweet = found.rows[0];
    if (!tweet) throw notFound('That Tweet no longer exists.');
    if (tweet.is_protected && Number(tweet.user_id) !== Number(userId)) {
      throw forbidden('Tweets from protected accounts cannot be retweeted.');
    }
    const inserted = await client.query(
      `INSERT INTO retweets (user_id, tweet_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id`,
      [userId, tweetId]
    );
    if (inserted.rowCount === 0) {
      const current = await client.query('SELECT retweet_count FROM tweets WHERE id = $1', [tweetId]);
      return { retweeted: true, count: current.rows[0].retweet_count };
    }
    const updated = await client.query(
      'UPDATE tweets SET retweet_count = retweet_count + 1 WHERE id = $1 RETURNING retweet_count',
      [tweetId]
    );
    if (Number(tweet.user_id) !== Number(userId)) {
      await client.query(
        `INSERT INTO notifications (user_id, actor_id, type, tweet_id) VALUES ($1, $2, 'retweet', $3)`,
        [tweet.user_id, userId, tweetId]
      );
    }
    return { retweeted: true, count: updated.rows[0].retweet_count, notifyUserId: tweet.user_id };
  });
}

async function unretweet(userId, tweetId) {
  return db.transaction(async (client) => {
    const removed = await client.query(
      'DELETE FROM retweets WHERE user_id = $1 AND tweet_id = $2 RETURNING id',
      [userId, tweetId]
    );
    const current = await client.query('SELECT retweet_count FROM tweets WHERE id = $1', [tweetId]);
    if (removed.rowCount === 0) {
      return { retweeted: false, count: current.rows[0] ? current.rows[0].retweet_count : 0 };
    }
    const updated = await client.query(
      'UPDATE tweets SET retweet_count = GREATEST(retweet_count - 1, 0) WHERE id = $1 RETURNING retweet_count',
      [tweetId]
    );
    await client.query(
      `DELETE FROM notifications WHERE user_id = (SELECT user_id FROM tweets WHERE id = $2)
         AND actor_id = $1 AND tweet_id = $2 AND type = 'retweet'`,
      [userId, tweetId]
    );
    return { retweeted: false, count: updated.rows[0].retweet_count };
  });
}

async function favoritedBy(tweetId, limit = 30) {
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.is_verified
       FROM favorites f JOIN users u ON u.id = f.user_id
      WHERE f.tweet_id = $1 ORDER BY f.created_at DESC LIMIT $2`,
    [tweetId, limit]
  );
}

async function retweetedBy(tweetId, limit = 30) {
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.is_verified
       FROM retweets r JOIN users u ON u.id = r.user_id
      WHERE r.tweet_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [tweetId, limit]
  );
}

// --------------------------------------------------------------------------
// Pinned Tweet
// --------------------------------------------------------------------------

async function pin(userId, tweetId) {
  const tweet = await db.one('SELECT id, user_id FROM tweets WHERE id = $1 AND is_deleted = false', [tweetId]);
  if (!tweet) throw notFound('That Tweet no longer exists.');
  if (Number(tweet.user_id) !== Number(userId)) throw forbidden('You can only pin your own Tweets.');
  await db.query(
    `INSERT INTO pinned_tweets (user_id, tweet_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET tweet_id = EXCLUDED.tweet_id, created_at = now()`,
    [userId, tweetId]
  );
}

async function unpin(userId) {
  await db.query('DELETE FROM pinned_tweets WHERE user_id = $1', [userId]);
}

async function pinnedTweet(userId, viewerId = null) {
  const row = await db.one('SELECT tweet_id FROM pinned_tweets WHERE user_id = $1', [userId]);
  if (!row) return null;
  const rows = await hydrate([row.tweet_id], viewerId);
  return rows[0] || null;
}

// --------------------------------------------------------------------------
// Timelines
// --------------------------------------------------------------------------

/**
 * Home timeline: the people you follow plus yourself, strictly reverse
 * chronological, with their retweets folded in. Replies to accounts you do
 * not follow are hidden, exactly as they were in 2014.
 */
async function homeTimeline(viewerId, { cursor = null, limit = 20 } = {}) {
  const params = [viewerId, limit + 1];
  const keyset = cursorClause(cursor, 3);
  params.push(...keyset.params);

  const events = await db.many(
    `WITH sources AS (
       SELECT followee_id AS id FROM follows WHERE follower_id = $1
       UNION SELECT $1::bigint
     )
     SELECT e.tweet_id, e.sort_at, e.sort_id, e.retweeter_id, e.retweeter_username,
            e.retweeter_display_name
       FROM (
         SELECT t.id AS tweet_id, t.created_at AS sort_at, t.id AS sort_id,
                NULL::bigint AS retweeter_id, NULL::citext AS retweeter_username,
                NULL::text AS retweeter_display_name
           FROM tweets t
           JOIN sources s ON s.id = t.user_id
          WHERE t.is_deleted = false
            AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = $1 AND m.muted_id = t.user_id)
            AND (t.in_reply_to_user_id IS NULL
                 OR t.in_reply_to_user_id = $1
                 OR EXISTS (SELECT 1 FROM sources s2 WHERE s2.id = t.in_reply_to_user_id))
         UNION ALL
         SELECT rt.tweet_id, rt.created_at, rt.tweet_id, rt.user_id, ru.username, ru.display_name
           FROM retweets rt
           JOIN sources s ON s.id = rt.user_id
           JOIN users ru ON ru.id = rt.user_id
           JOIN tweets t ON t.id = rt.tweet_id AND t.is_deleted = false
          WHERE rt.user_id <> $1
            AND NOT EXISTS (SELECT 1 FROM mutes m
                             WHERE m.muter_id = $1 AND m.muted_id IN (rt.user_id, t.user_id))
            AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE (b.blocker_id = $1 AND b.blocked_id = t.user_id)
                                OR (b.blocker_id = t.user_id AND b.blocked_id = $1))
       ) e
      WHERE true ${keyset.sql}
      ORDER BY e.sort_at DESC, e.sort_id DESC
      LIMIT $2`,
    params
  );
  return paginate(events, limit, viewerId);
}

/** Profile timeline. `mode`: tweets | replies | media */
async function userTimeline(userId, { viewerId = null, mode = 'tweets', cursor = null, limit = 20 } = {}) {
  const filters = {
    tweets: 'AND (t.in_reply_to_tweet_id IS NULL)',
    replies: '',
    media: 'AND t.has_media = true',
  };
  const filter = filters[mode] !== undefined ? filters[mode] : filters.tweets;
  const params = [userId, limit + 1];
  const keyset = cursorClause(cursor, 3);
  params.push(...keyset.params);

  const events = await db.many(
    `SELECT e.tweet_id, e.sort_at, e.sort_id, e.retweeter_id, e.retweeter_username,
            e.retweeter_display_name
       FROM (
         SELECT t.id AS tweet_id, t.created_at AS sort_at, t.id AS sort_id,
                NULL::bigint AS retweeter_id, NULL::citext AS retweeter_username,
                NULL::text AS retweeter_display_name
           FROM tweets t
          WHERE t.user_id = $1 AND t.is_deleted = false ${filter}
         ${
           mode === 'media'
             ? ''
             : `UNION ALL
         SELECT rt.tweet_id, rt.created_at, rt.tweet_id, rt.user_id, ru.username, ru.display_name
           FROM retweets rt
           JOIN users ru ON ru.id = rt.user_id
           JOIN tweets t ON t.id = rt.tweet_id AND t.is_deleted = false
           JOIN users au ON au.id = t.user_id
          WHERE rt.user_id = $1 AND au.is_protected = false`
         }
       ) e
      WHERE true ${keyset.sql}
      ORDER BY e.sort_at DESC, e.sort_id DESC
      LIMIT $2`,
    params
  );
  return paginate(events, limit, viewerId);
}

/** Tweets a user has favorited, newest favorite first. */
async function favoritesTimeline(userId, { viewerId = null, cursor = null, limit = 20 } = {}) {
  const params = [userId, limit + 1];
  const keyset = cursorClause(cursor, 3);
  params.push(...keyset.params);
  const events = await db.many(
    `SELECT e.tweet_id, e.sort_at, e.sort_id, NULL::bigint AS retweeter_id,
            NULL::text AS retweeter_username, NULL::text AS retweeter_display_name
       FROM (
         SELECT f.tweet_id, f.created_at AS sort_at, f.tweet_id AS sort_id
           FROM favorites f
           JOIN tweets t ON t.id = f.tweet_id AND t.is_deleted = false
           JOIN users au ON au.id = t.user_id
          WHERE f.user_id = $1 AND au.is_suspended = false
            AND (au.is_protected = false OR au.id = $1)
       ) e
      WHERE true ${keyset.sql}
      ORDER BY e.sort_at DESC, e.sort_id DESC
      LIMIT $2`,
    params
  );
  return paginate(events, limit, viewerId);
}

/** All Tweets in a conversation thread, oldest first. */
async function conversation(tweetId, viewerId = null, limit = 100) {
  const root = await db.one(
    'SELECT COALESCE(conversation_id, id) AS conversation_id FROM tweets WHERE id = $1',
    [tweetId]
  );
  if (!root) return { ancestors: [], replies: [] };
  const rows = await db.many(
    `SELECT t.id, t.created_at, t.in_reply_to_tweet_id
       FROM tweets t
      WHERE t.conversation_id = $1 AND t.is_deleted = false
      ORDER BY t.created_at ASC, t.id ASC
      LIMIT $2`,
    [root.conversation_id, limit]
  );
  const ancestorIds = [];
  // Walk up the reply chain from the focused Tweet.
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  let cursorId = byId.get(Number(tweetId)) && byId.get(Number(tweetId)).in_reply_to_tweet_id;
  while (cursorId && byId.has(Number(cursorId))) {
    ancestorIds.unshift(Number(cursorId));
    cursorId = byId.get(Number(cursorId)).in_reply_to_tweet_id;
  }

  // Replies come back as a thread rather than a flat run: each one sits
  // under the Tweet it actually answers, and `depth` says how far in to set
  // it. Rows arrive oldest first, so every sibling list is already in order.
  const children = new Map();
  rows.forEach((row) => {
    const parent = Number(row.in_reply_to_tweet_id) || null;
    if (!parent) return;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(Number(row.id));
  });
  const replyIds = [];
  const depthById = new Map();
  (function walk(parentId, depth) {
    (children.get(parentId) || []).forEach((childId) => {
      replyIds.push(childId);
      depthById.set(childId, depth);
      walk(childId, depth + 1);
    });
  }(Number(tweetId), 0));

  const [ancestors, replies] = await Promise.all([
    hydrate(ancestorIds, viewerId),
    hydrate(replyIds, viewerId),
  ]);
  return {
    ancestors,
    replies: replies.map((row) => ({ ...row, thread_depth: depthById.get(Number(row.id)) || 0 })),
  };
}

/** Tweets matching a full-text-ish search, newest first. */
async function searchTimeline(term, { viewerId = null, cursor = null, limit = 20 } = {}) {
  const q = String(term || '').trim();
  if (!q) return { items: [], nextCursor: null };
  const hashtag = q.startsWith('#') ? q.slice(1) : null;
  const params = [q, limit + 1, viewerId, hashtag];
  const keyset = cursorClause(cursor, 5);
  params.push(...keyset.params);

  const events = await db.many(
    `SELECT e.tweet_id, e.sort_at, e.sort_id, NULL::bigint AS retweeter_id,
            NULL::text AS retweeter_username, NULL::text AS retweeter_display_name
       FROM (
         SELECT DISTINCT t.id AS tweet_id, t.created_at AS sort_at, t.id AS sort_id
           FROM tweets t
           JOIN users au ON au.id = t.user_id
           LEFT JOIN tweet_hashtags th ON th.tweet_id = t.id
           LEFT JOIN hashtags h ON h.id = th.hashtag_id
          WHERE t.is_deleted = false
            AND au.is_suspended = false
            AND (au.is_protected = false OR au.id = $3)
            AND ($4::text IS NULL OR h.tag = $4::citext)
            AND ($4::text IS NOT NULL OR t.body ILIKE '%' || $1 || '%')
            AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE (b.blocker_id = $3 AND b.blocked_id = t.user_id)
                                OR (b.blocker_id = t.user_id AND b.blocked_id = $3))
       ) e
      WHERE true ${keyset.sql}
      ORDER BY e.sort_at DESC, e.sort_id DESC
      LIMIT $2`,
    params
  );
  return paginate(events, limit, viewerId);
}

/** Timeline for a Twiq List. */
async function listTimeline(listId, { viewerId = null, cursor = null, limit = 20 } = {}) {
  const params = [listId, limit + 1, viewerId];
  const keyset = cursorClause(cursor, 4);
  params.push(...keyset.params);
  const events = await db.many(
    `SELECT e.tweet_id, e.sort_at, e.sort_id, NULL::bigint AS retweeter_id,
            NULL::text AS retweeter_username, NULL::text AS retweeter_display_name
       FROM (
         SELECT t.id AS tweet_id, t.created_at AS sort_at, t.id AS sort_id
           FROM list_members lm
           JOIN tweets t ON t.user_id = lm.user_id AND t.is_deleted = false
           JOIN users au ON au.id = t.user_id
          WHERE lm.list_id = $1
            AND (au.is_protected = false OR au.id = $3
                 OR EXISTS (SELECT 1 FROM follows f
                             WHERE f.follower_id = $3 AND f.followee_id = au.id))
       ) e
      WHERE true ${keyset.sql}
      ORDER BY e.sort_at DESC, e.sort_id DESC
      LIMIT $2`,
    params
  );
  return paginate(events, limit, viewerId);
}

/** Popular public Tweets from the last few days - used by Discover. */
async function popularTimeline({ viewerId = null, limit = 12, hours = 168 } = {}) {
  const events = await db.many(
    `SELECT t.id AS tweet_id, t.created_at AS sort_at, t.id AS sort_id,
            NULL::bigint AS retweeter_id, NULL::text AS retweeter_username,
            NULL::text AS retweeter_display_name
       FROM tweets t
       JOIN users au ON au.id = t.user_id
      WHERE t.is_deleted = false AND au.is_protected = false AND au.is_suspended = false
        AND t.created_at > now() - ($2 || ' hours')::interval
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = $3 AND b.blocked_id = t.user_id)
                            OR (b.blocker_id = t.user_id AND b.blocked_id = $3))
      ORDER BY (t.favorite_count * 1 + t.retweet_count * 2 + t.reply_count) DESC,
               t.created_at DESC
      LIMIT $1`,
    [limit, String(hours), viewerId]
  );
  const items = await hydrateEvents(events, viewerId);
  return { items, nextCursor: null };
}

/** Media Tweets for the profile "Photos and videos" grid. */
async function userMedia(userId, { limit = 6, offset = 0 } = {}) {
  return db.many(
    `SELECT md.id, md.kind, md.storage_key, md.alt_text, t.id AS tweet_id, u.username
       FROM tweet_media tm
       JOIN media md ON md.id = tm.media_id
       JOIN tweets t ON t.id = tm.tweet_id
       JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND t.is_deleted = false
      ORDER BY t.created_at DESC, tm.position
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
}

/**
 * Deterministic "Best Tweets" threshold for a profile: a Tweet is enlarged
 * when its engagement is at least 2.5x the author's own average and clears a
 * small floor, so quiet accounts do not get random giant Tweets.
 */
async function bestTweetThreshold(userId) {
  const row = await db.one(
    `SELECT COALESCE(avg(favorite_count + retweet_count * 2 + reply_count), 0)::float AS avg_engagement,
            count(*)::int AS n
       FROM tweets WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (!row || row.n < 5) return Number.POSITIVE_INFINITY;
  return Math.max(4, Math.ceil(row.avg_engagement * 2.5));
}

function engagementScore(tweet) {
  return (tweet.favorite_count || 0) + (tweet.retweet_count || 0) * 2 + (tweet.reply_count || 0);
}

async function paginate(events, limit, viewerId) {
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const items = await hydrateEvents(page, viewerId);
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? { at: last.sort_at, id: Number(last.sort_id) } : null,
  };
}

async function countForHashtag(tag) {
  const row = await db.one(
    `SELECT count(*)::int AS n FROM tweet_hashtags th
       JOIN hashtags h ON h.id = th.hashtag_id WHERE h.tag = $1`,
    [tag]
  );
  return row ? row.n : 0;
}

/** Tweets newer than a given id in the viewer's home timeline (new-Tweet bar). */
async function countNewerInHome(viewerId, sinceId) {
  const row = await db.one(
    `WITH sources AS (
       SELECT followee_id AS id FROM follows WHERE follower_id = $1
       UNION SELECT $1::bigint
     )
     SELECT count(*)::int AS n,
            count(DISTINCT t.user_id)::int AS accounts
       FROM tweets t JOIN sources s ON s.id = t.user_id
      WHERE t.is_deleted = false AND t.id > $2 AND t.user_id <> $1
        AND NOT EXISTS (SELECT 1 FROM mutes m
                         WHERE m.muter_id = $1 AND m.muted_id = t.user_id)
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = $1 AND b.blocked_id = t.user_id)
                            OR (b.blocker_id = t.user_id AND b.blocked_id = $1))`,
    [viewerId, sinceId || 0]
  );
  return { count: row ? row.n : 0, accounts: row ? row.accounts : 0 };
}

/**
 * Which of `candidateIds` follow this author and would actually see the
 * Tweet - muted and blocked pairs are left out, so the bar never announces
 * something the timeline will not show.
 */
async function followersAmong(authorId, candidateIds) {
  const list = (candidateIds || []).map(Number).filter(Boolean);
  if (list.length === 0) return [];
  const rows = await db.many(
    `SELECT f.follower_id AS id
       FROM follows f
      WHERE f.followee_id = $1 AND f.follower_id = ANY($2::bigint[])
        AND NOT EXISTS (SELECT 1 FROM mutes m
                         WHERE m.muter_id = f.follower_id AND m.muted_id = $1)
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = f.follower_id AND b.blocked_id = $1)
                            OR (b.blocker_id = $1 AND b.blocked_id = f.follower_id))`,
    [authorId, list]
  );
  return rows.map((r) => Number(r.id));
}

/** Everyone a Tweet raised a notification for, so they can be nudged. */
async function notifiedBy(tweetId) {
  const rows = await db.many(
    'SELECT DISTINCT user_id AS id FROM notifications WHERE tweet_id = $1',
    [tweetId]
  );
  return rows.map((r) => Number(r.id));
}

module.exports = {
  create,
  findById,
  findRaw,
  hydrate,
  remove,
  favorite,
  unfavorite,
  retweet,
  unretweet,
  favoritedBy,
  retweetedBy,
  pin,
  unpin,
  pinnedTweet,
  homeTimeline,
  userTimeline,
  favoritesTimeline,
  conversation,
  searchTimeline,
  listTimeline,
  popularTimeline,
  userMedia,
  bestTweetThreshold,
  engagementScore,
  countForHashtag,
  countNewerInHome,
  followersAmong,
  notifiedBy,
};
