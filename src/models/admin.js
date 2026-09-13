'use strict';

const db = require('../config/db');

/**
 * Read models for the control panel.
 *
 * Everything here is aggregate or cross-cutting - the sort of query no
 * member-facing page should ever run. They are kept apart from the ordinary
 * models so the hot paths stay obvious and cheap.
 */

// --------------------------------------------------------------- overview --

/** Headline counters, each with the comparable figure from the week before. */
async function headline() {
  return db.one(`
    SELECT
      (SELECT count(*) FROM users)::int                                        AS users,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int  AS users_7d,
      (SELECT count(*) FROM users
        WHERE created_at > now() - interval '14 days'
          AND created_at <= now() - interval '7 days')::int                    AS users_prev_7d,
      (SELECT count(*) FROM tweets WHERE is_deleted = false)::int              AS tweets,
      (SELECT count(*) FROM tweets
        WHERE is_deleted = false AND created_at > now() - interval '7 days')::int     AS tweets_7d,
      (SELECT count(*) FROM tweets
        WHERE is_deleted = false AND created_at > now() - interval '14 days'
          AND created_at <= now() - interval '7 days')::int                    AS tweets_prev_7d,
      (SELECT count(*) FROM users WHERE is_suspended)::int                     AS suspended,
      (SELECT count(*) FROM reports WHERE status = 'open')::int                AS open_reports,
      (SELECT count(*) FROM follows)::int                                      AS follows,
      (SELECT count(*) FROM messages WHERE is_deleted = false)::int            AS messages
  `);
}

/**
 * Distinct people who did something visible in the window. "Active" here
 * means posted, favorited, retweeted or sent a message - not merely loaded
 * a page, which we do not record.
 */
async function activeUsers() {
  return db.one(`
    WITH activity AS (
      SELECT user_id, created_at FROM tweets WHERE is_deleted = false
      UNION ALL SELECT user_id, created_at FROM favorites
      UNION ALL SELECT user_id, created_at FROM retweets
      UNION ALL SELECT sender_id, created_at FROM messages WHERE is_deleted = false
    )
    SELECT
      count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '1 day')::int  AS day,
      count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
      count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '30 days')::int AS month
    FROM activity
  `);
}

/** Daily signups and Tweets for the last `days` days, zero-filled. */
async function dailySeries(days = 30) {
  return db.many(
    `SELECT d::date AS day,
            (SELECT count(*) FROM users u
              WHERE u.created_at >= d AND u.created_at < d + interval '1 day')::int AS signups,
            (SELECT count(*) FROM tweets t
              WHERE t.is_deleted = false
                AND t.created_at >= d AND t.created_at < d + interval '1 day')::int AS tweets
       FROM generate_series(
              date_trunc('day', now()) - (($1 - 1) || ' days')::interval,
              date_trunc('day', now()),
              interval '1 day') d
      ORDER BY d`,
    [days]
  );
}

/** The accounts doing the most in the window, for spotting both stars and spam. */
async function mostActive(days = 7, limit = 8) {
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.is_suspended,
            count(t.id)::int AS tweets,
            COALESCE(sum(t.favorite_count), 0)::int AS favorites_received
       FROM users u
       JOIN tweets t ON t.user_id = u.id AND t.is_deleted = false
        AND t.created_at > now() - (($1)::text || ' days')::interval
      GROUP BY u.id
      ORDER BY tweets DESC, favorites_received DESC
      LIMIT $2`,
    [days, limit]
  );
}

// ------------------------------------------------------------------ users --

const USER_SORTS = {
  created: 'u.created_at DESC',
  active: 'u.last_login_at DESC NULLS LAST',
  tweets: 'u.tweet_count DESC',
  followers: 'u.follower_count DESC',
  username: 'u.username ASC',
};

/**
 * The user table with every filter the panel offers. Filters are composed as
 * parameterised fragments; the sort is picked from a fixed allow-list, never
 * interpolated from the query string.
 */
async function searchUsers({
  term = '', role = 'any', status = 'any', sort = 'created', limit = 50, offset = 0,
} = {}) {
  const where = [];
  const params = [];

  if (term) {
    params.push(term);
    where.push(`(u.username ILIKE '%' || $${params.length} || '%'
              OR u.display_name ILIKE '%' || $${params.length} || '%'
              OR u.email ILIKE '%' || $${params.length} || '%')`);
  }
  if (['user', 'moderator', 'admin'].includes(role)) {
    params.push(role);
    where.push(`u.role = $${params.length}`);
  }
  if (status === 'suspended') where.push('u.is_suspended = true');
  if (status === 'active') where.push('u.is_suspended = false');
  if (status === 'verified') where.push('u.is_verified = true');
  if (status === 'unconfirmed') where.push('u.email_verified_at IS NULL');
  if (status === 'protected') where.push('u.is_protected = true');

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const order = USER_SORTS[sort] || USER_SORTS.created;

  params.push(limit, offset);
  const rows = await db.many(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.is_suspended,
            u.is_verified, u.is_protected, u.email_verified_at, u.tweet_count,
            u.follower_count, u.following_count, u.created_at, u.last_login_at,
            (SELECT count(*) FROM reports r WHERE r.target_user_id = u.id
              AND r.status = 'open')::int AS open_reports
       FROM users u
       ${clause}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = await db.one(
    `SELECT count(*)::int AS n FROM users u ${clause}`,
    params.slice(0, params.length - 2)
  );

  return { rows, total: total ? total.n : 0 };
}

/** Everything the panel shows about one account, in one round trip each. */
async function userDetail(userId) {
  const [account, settings, theme, recentTweets, reportsAgainst, reportsBy, logins, audit, sessions] =
    await Promise.all([
      db.one(
        `SELECT u.*, (SELECT count(*) FROM media m WHERE m.user_id = u.id)::int AS media_count,
                (SELECT COALESCE(sum(m.byte_size), 0) FROM media m WHERE m.user_id = u.id)::bigint AS media_bytes
           FROM users u WHERE u.id = $1`,
        [userId]
      ),
      db.one('SELECT * FROM user_settings WHERE user_id = $1', [userId]),
      db.one('SELECT * FROM profile_settings WHERE user_id = $1', [userId]),
      db.many(
        `SELECT id, body, created_at, favorite_count, retweet_count, reply_count, has_media
           FROM tweets WHERE user_id = $1 AND is_deleted = false
          ORDER BY created_at DESC LIMIT 10`,
        [userId]
      ),
      db.many(
        `SELECT r.id, r.category, r.details, r.status, r.created_at,
                rep.username AS reporter_username, r.target_tweet_id
           FROM reports r LEFT JOIN users rep ON rep.id = r.reporter_id
          WHERE r.target_user_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
        [userId]
      ),
      db.one(
        `SELECT count(*)::int AS n FROM reports WHERE reporter_id = $1`,
        [userId]
      ),
      db.many(
        `SELECT succeeded, ip_address, created_at FROM login_attempts
          WHERE identifier IN (SELECT username::text FROM users WHERE id = $1
                               UNION SELECT email::text FROM users WHERE id = $1)
          ORDER BY created_at DESC LIMIT 12`,
        [userId]
      ),
      db.many(
        `SELECT a.action, a.created_at, a.metadata, act.username AS actor_username
           FROM audit_logs a LEFT JOIN users act ON act.id = a.actor_id
          WHERE (a.target_type = 'user' AND a.target_id = $1::text)
             OR a.actor_id = $1::bigint
          ORDER BY a.created_at DESC LIMIT 15`,
        [userId]
      ),
      db.one(
        `SELECT count(*)::int AS n FROM sessions
          WHERE expire > now() AND sess::text LIKE '%"userId":' || $1 || '%'`,
        [userId]
      ),
    ]);

  return {
    account,
    settings,
    theme,
    recentTweets,
    reportsAgainst,
    reportsByCount: reportsBy ? reportsBy.n : 0,
    logins,
    audit,
    activeSessions: sessions ? sessions.n : 0,
  };
}

// ---------------------------------------------------------------- content --

const TWEET_SORTS = {
  recent: 't.created_at DESC',
  engagement: '(t.favorite_count + t.retweet_count * 2 + t.reply_count) DESC',
  replies: 't.reply_count DESC',
};

async function searchTweets({
  term = '', author = '', filter = 'any', sort = 'recent', limit = 40, offset = 0,
} = {}) {
  const where = ['t.is_deleted = false'];
  const params = [];

  if (term) {
    params.push(term);
    where.push(`t.body ILIKE '%' || $${params.length} || '%'`);
  }
  if (author) {
    params.push(author.replace(/^@/, ''));
    where.push(`u.username = $${params.length}`);
  }
  if (filter === 'media') where.push('t.has_media = true');
  if (filter === 'replies') where.push('t.in_reply_to_tweet_id IS NOT NULL');
  if (filter === 'reported') {
    where.push(`EXISTS (SELECT 1 FROM reports r WHERE r.target_tweet_id = t.id)`);
  }
  if (filter === 'suspended') where.push('u.is_suspended = true');

  const clause = `WHERE ${where.join(' AND ')}`;
  const order = TWEET_SORTS[sort] || TWEET_SORTS.recent;

  params.push(limit, offset);
  const rows = await db.many(
    `SELECT t.id, t.body, t.created_at, t.favorite_count, t.retweet_count,
            t.reply_count, t.has_media, u.username, u.display_name, u.is_suspended,
            (SELECT count(*) FROM reports r WHERE r.target_tweet_id = t.id)::int AS report_count
       FROM tweets t JOIN users u ON u.id = t.user_id
       ${clause}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = await db.one(
    `SELECT count(*)::int AS n FROM tweets t JOIN users u ON u.id = t.user_id ${clause}`,
    params.slice(0, params.length - 2)
  );

  return { rows, total: total ? total.n : 0 };
}

// ----------------------------------------------------------------- system --

async function storageStats() {
  const [totals, orphans] = await Promise.all([
    db.one(`
      SELECT count(*)::int AS files,
             COALESCE(sum(byte_size), 0)::bigint AS bytes,
             count(*) FILTER (WHERE kind = 'photo')::int AS photos,
             count(*) FILTER (WHERE kind = 'animated_gif')::int AS gifs,
             count(*) FILTER (WHERE kind = 'video')::int AS videos
        FROM media
    `),
    db.one(`
      SELECT count(*)::int AS files, COALESCE(sum(m.byte_size), 0)::bigint AS bytes
        FROM media m
       WHERE m.created_at < now() - interval '24 hours'
         AND NOT EXISTS (SELECT 1 FROM tweet_media tm WHERE tm.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM messages ms WHERE ms.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_path = m.storage_key
                                              OR u.header_path = m.storage_key)
         AND NOT EXISTS (SELECT 1 FROM profile_settings p WHERE p.background_path = m.storage_key)
    `),
  ]);
  return { ...totals, orphanFiles: orphans.files, orphanBytes: orphans.bytes };
}

async function databaseStats() {
  return db.many(`
    SELECT relname AS table_name,
           n_live_tup::bigint AS rows,
           pg_total_relation_size(relid)::bigint AS bytes
      FROM pg_stat_user_tables
     ORDER BY pg_total_relation_size(relid) DESC
     LIMIT 14
  `);
}

async function sessionStats() {
  return db.one(`
    SELECT count(*) FILTER (WHERE expire > now())::int AS active,
           count(*) FILTER (WHERE expire <= now())::int AS expired
      FROM sessions
  `);
}

async function migrationStatus() {
  return db.many('SELECT name, applied_at FROM schema_migrations ORDER BY name');
}

/**
 * Denormalised counters are maintained by hand inside transactions, so a
 * crash at the wrong moment can leave them adrift. This finds the drift.
 */
async function counterDrift() {
  return db.many(`
    SELECT u.id, u.username,
           u.tweet_count, t.n AS actual_tweets,
           u.follower_count, fr.n AS actual_followers,
           u.following_count, fg.n AS actual_following,
           u.favorite_count, fv.n AS actual_favorites,
           u.list_count, l.n AS actual_lists
      FROM users u
      JOIN LATERAL (SELECT count(*)::int n FROM tweets x
                     WHERE x.user_id = u.id AND x.is_deleted = false) t ON true
      JOIN LATERAL (SELECT count(*)::int n FROM follows x WHERE x.followee_id = u.id) fr ON true
      JOIN LATERAL (SELECT count(*)::int n FROM follows x WHERE x.follower_id = u.id) fg ON true
      JOIN LATERAL (SELECT count(*)::int n FROM favorites x WHERE x.user_id = u.id) fv ON true
      JOIN LATERAL (SELECT count(*)::int n FROM lists x WHERE x.owner_id = u.id) l ON true
     WHERE u.tweet_count <> t.n OR u.follower_count <> fr.n OR u.following_count <> fg.n
        OR u.favorite_count <> fv.n OR u.list_count <> l.n
     ORDER BY u.username
     LIMIT 100
  `);
}

/**
 * Put every counter back in step with the rows it counts.
 *
 * The true values are computed in a CTE rather than a LATERAL join: an
 * UPDATE's target table is not part of its FROM list, so a lateral item
 * cannot reference it.
 */
async function recountAll() {
  const result = await db.query(`
    WITH actual AS (
      SELECT u.id,
             (SELECT count(*)::int FROM tweets x
               WHERE x.user_id = u.id AND x.is_deleted = false) AS tweets,
             (SELECT count(*)::int FROM follows x WHERE x.followee_id = u.id) AS followers,
             (SELECT count(*)::int FROM follows x WHERE x.follower_id = u.id) AS following,
             (SELECT count(*)::int FROM favorites x WHERE x.user_id = u.id) AS favorites,
             (SELECT count(*)::int FROM lists x WHERE x.owner_id = u.id) AS lists
        FROM users u
    )
    UPDATE users u SET
      tweet_count     = a.tweets,
      follower_count  = a.followers,
      following_count = a.following,
      favorite_count  = a.favorites,
      list_count      = a.lists,
      updated_at      = now()
      FROM actual a
     WHERE a.id = u.id
       AND (u.tweet_count <> a.tweets
         OR u.follower_count <> a.followers
         OR u.following_count <> a.following
         OR u.favorite_count <> a.favorites
         OR u.list_count <> a.lists)
  `);
  return result.rowCount;
}

/** Sign one account out of every browser it is signed in on. */
async function purgeUserSessions(userId) {
  const result = await db.query(
    `DELETE FROM sessions WHERE sess::text LIKE '%"userId":' || $1 || '%'`,
    [userId]
  );
  return result.rowCount;
}

async function purgeExpiredSessions() {
  const result = await db.query('DELETE FROM sessions WHERE expire <= now()');
  return result.rowCount;
}

async function pruneLoginAttempts(days = 30) {
  const result = await db.query(
    `DELETE FROM login_attempts WHERE created_at < now() - (($1)::text || ' days')::interval`,
    [days]
  );
  return result.rowCount;
}

// ------------------------------------------------------------ audit trail --

async function auditLog({ actor = '', action = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (actor) {
    params.push(actor.replace(/^@/, ''));
    where.push(`act.username = $${params.length}`);
  }
  if (action) {
    params.push(action);
    where.push(`a.action ILIKE '%' || $${params.length} || '%'`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const rows = await db.many(
    `SELECT a.*, act.username AS actor_username
       FROM audit_logs a LEFT JOIN users act ON act.id = a.actor_id
       ${clause}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const actions = await db.many(
    'SELECT DISTINCT action FROM audit_logs ORDER BY action'
  );
  return { rows, actions: actions.map((r) => r.action) };
}

module.exports = {
  headline,
  activeUsers,
  dailySeries,
  mostActive,
  searchUsers,
  userDetail,
  searchTweets,
  storageStats,
  databaseStats,
  sessionStats,
  migrationStatus,
  counterDrift,
  recountAll,
  purgeUserSessions,
  purgeExpiredSessions,
  pruneLoginAttempts,
  auditLog,
  USER_SORTS,
  TWEET_SORTS,
};
