'use strict';

const db = require('../config/db');
const logger = require('../config/logger');

/**
 * Trends.
 *
 * The score is deterministic and readable: a hashtag earns points for how
 * many distinct people used it, how often it was used, how much of that use
 * is recent (velocity) and how long ago it was last used (recency decay).
 *
 *   score = (3 * unique_users + uses + 4 * uses_last_6h) / (1 + hours_since_last / 12)
 *
 * Worldwide trends are computed from Tweets. Country and city trends are
 * curated from the admin panel; when a scope has no curated rows, the
 * worldwide list is used so the sidebar is never empty.
 */

const WINDOW_HOURS = 48;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, rows: [] };

async function computeGlobal(limit = 10) {
  return db.many(
    `WITH usage AS (
       SELECT h.tag,
              count(DISTINCT t.user_id)::int AS unique_users,
              count(*)::int AS uses,
              count(*) FILTER (WHERE t.created_at > now() - interval '6 hours')::int AS recent_uses,
              EXTRACT(EPOCH FROM (now() - max(t.created_at))) / 3600.0 AS hours_since_last
         FROM tweet_hashtags th
         JOIN hashtags h ON h.id = th.hashtag_id
         JOIN tweets t ON t.id = th.tweet_id AND t.is_deleted = false
         JOIN users u ON u.id = t.user_id
        WHERE t.created_at > now() - ($1 || ' hours')::interval
          AND u.is_protected = false AND u.is_suspended = false
        GROUP BY h.tag
       HAVING count(DISTINCT t.user_id) >= 1
     )
     SELECT tag,
            unique_users,
            uses,
            recent_uses,
            round(((3 * unique_users + uses + 4 * recent_uses)
                   / (1 + hours_since_last / 12.0))::numeric, 4) AS score
       FROM usage
      ORDER BY score DESC, uses DESC, tag ASC
      LIMIT $2`,
    [String(WINDOW_HOURS), limit]
  );
}

/** Recompute the worldwide list and persist it so admins can see/curate it. */
async function refreshGlobal(limit = 10) {
  const rows = await computeGlobal(limit);
  await db.transaction(async (client) => {
    await client.query(`DELETE FROM trends WHERE scope_type = 'global' AND is_manual = false`);
    let position = 0;
    for (const row of rows) {
      await client.query(
        `INSERT INTO trends (scope_type, scope_name, tag, query, score, tweet_volume, position, computed_at)
         VALUES ('global', 'Worldwide', $1, $2, $3, $4, $5, now())
         ON CONFLICT (scope_type, scope_name, tag)
         DO UPDATE SET score = EXCLUDED.score, tweet_volume = EXCLUDED.tweet_volume,
                       position = EXCLUDED.position, computed_at = now()`,
        [row.tag, `#${row.tag}`, row.score, row.uses, position]
      );
      position += 1;
    }
  });
  cache = { at: 0, rows: [] };
  return rows;
}

/** Trends for a scope, with an in-process cache so the sidebar is cheap. */
async function forScope({ scopeType = 'global', scopeName = 'Worldwide', limit = 10 } = {}) {
  if (scopeType === 'global') {
    if (Date.now() - cache.at < CACHE_TTL_MS && cache.rows.length > 0) {
      return cache.rows.slice(0, limit);
    }
    const manual = await db.many(
      `SELECT tag, query, tweet_volume, position FROM trends
        WHERE scope_type = 'global' AND is_manual = true ORDER BY position LIMIT $1`,
      [limit]
    );
    let rows = manual.map((r) => ({ tag: r.tag, query: r.query, uses: r.tweet_volume, promoted: true }));
    if (rows.length < limit) {
      const computed = await computeGlobal(limit - rows.length + 5);
      const seen = new Set(rows.map((r) => r.tag.toLowerCase()));
      for (const row of computed) {
        if (rows.length >= limit) break;
        if (seen.has(row.tag.toLowerCase())) continue;
        rows.push({ tag: row.tag, query: `#${row.tag}`, uses: row.uses, promoted: false });
      }
    }
    cache = { at: Date.now(), rows };
    return rows.slice(0, limit);
  }

  const curated = await db.many(
    `SELECT tag, query, tweet_volume FROM trends
      WHERE scope_type = $1 AND scope_name = $2 ORDER BY position LIMIT $3`,
    [scopeType, scopeName, limit]
  );
  if (curated.length > 0) {
    return curated.map((r) => ({ tag: r.tag, query: r.query, uses: r.tweet_volume, promoted: true }));
  }
  return forScope({ scopeType: 'global', scopeName: 'Worldwide', limit });
}

/** Every scope a member can switch to in the "Change" dialog. */
async function scopes() {
  const rows = await db.many(
    `SELECT DISTINCT scope_type, scope_name FROM trends WHERE scope_type <> 'global'
      ORDER BY scope_type, scope_name`
  );
  return [{ scope_type: 'global', scope_name: 'Worldwide' }, ...rows];
}

async function upsertManual({ scopeType, scopeName, tag, query, volume = 0, position = 0 }) {
  await db.query(
    `INSERT INTO trends (scope_type, scope_name, tag, query, score, tweet_volume, is_manual, position, computed_at)
     VALUES ($1, $2, $3, $4, 0, $5, true, $6, now())
     ON CONFLICT (scope_type, scope_name, tag)
     DO UPDATE SET query = EXCLUDED.query, tweet_volume = EXCLUDED.tweet_volume,
                   is_manual = true, position = EXCLUDED.position, computed_at = now()`,
    [scopeType, scopeName, tag, query || `#${tag}`, volume, position]
  );
  cache = { at: 0, rows: [] };
}

async function removeTrend(id) {
  await db.query('DELETE FROM trends WHERE id = $1', [id]);
  cache = { at: 0, rows: [] };
}

async function all() {
  return db.many('SELECT * FROM trends ORDER BY scope_type, scope_name, position, score DESC');
}

/** Refresh worldwide trends on a slow timer; failures never take the app down. */
function startScheduler(intervalMs = 10 * 60 * 1000) {
  const timer = setInterval(() => {
    refreshGlobal().catch((err) => logger.warn({ err }, 'trend refresh failed'));
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  computeGlobal,
  refreshGlobal,
  forScope,
  scopes,
  upsertManual,
  removeTrend,
  all,
  startScheduler,
};
