'use strict';

const db = require('../config/db');

/**
 * "Who to follow".
 *
 * Three cheap, explainable sources, tried in order until the box is full:
 *   1. friends-of-friends - accounts followed by people you follow
 *   2. accounts that already follow you but that you do not follow back
 *   3. active public accounts, as a fallback for brand new members
 *
 * `page` is the Refresh counter, so refreshing walks deterministically
 * through the candidate list instead of reshuffling at random.
 */

const COMMON_FILTERS = `
  u.id <> $1
  AND u.is_suspended = false
  AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                      OR (b.blocker_id = u.id AND b.blocked_id = $1))
  AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = $1 AND m.muted_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id)
`;

async function friendsOfFriends(userId, limit, offset) {
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.is_verified,
            u.follower_count, count(*)::int AS mutual_count,
            (array_agg(mu.username ORDER BY mu.follower_count DESC))[1:2] AS mutual_usernames,
            (array_agg(mu.display_name ORDER BY mu.follower_count DESC))[1:2] AS mutual_names
       FROM follows mine
       JOIN follows theirs ON theirs.follower_id = mine.followee_id
       JOIN users u ON u.id = theirs.followee_id
       JOIN users mu ON mu.id = mine.followee_id
      WHERE mine.follower_id = $1 AND ${COMMON_FILTERS}
      GROUP BY u.id
      ORDER BY mutual_count DESC, u.follower_count DESC, u.id
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
}

async function followsYouBack(userId, limit, offset) {
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.is_verified,
            u.follower_count, 0 AS mutual_count,
            NULL::citext[] AS mutual_usernames, NULL::text[] AS mutual_names
       FROM follows f
       JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = $1 AND ${COMMON_FILTERS}
      ORDER BY f.created_at DESC, u.id
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
}

async function activeAccounts(userId, limit, offset) {
  return db.many(
    `SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.is_verified,
            u.follower_count, 0 AS mutual_count,
            NULL::citext[] AS mutual_usernames, NULL::text[] AS mutual_names
       FROM users u
      WHERE u.is_protected = false AND u.tweet_count > 0 AND ${COMMON_FILTERS}
      ORDER BY u.follower_count DESC, u.tweet_count DESC, u.id
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
}

async function whoToFollow(userId, { limit = 3, page = 0 } = {}) {
  if (!userId) {
    return db.many(
      `SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.is_verified,
              u.follower_count, 0 AS mutual_count,
              NULL::citext[] AS mutual_usernames, NULL::text[] AS mutual_names
         FROM users u
        WHERE u.is_protected = false AND u.is_suspended = false
        ORDER BY u.follower_count DESC, u.id LIMIT $1 OFFSET $2`,
      [limit, page * limit]
    );
  }

  const offset = page * limit;
  const seen = new Set();
  const out = [];
  const sources = [friendsOfFriends, followsYouBack, activeAccounts];

  for (const source of sources) {
    if (out.length >= limit) break;
    const rows = await source(userId, limit * 2, offset);
    for (const row of rows) {
      if (out.length >= limit) break;
      if (seen.has(Number(row.id))) continue;
      seen.add(Number(row.id));
      out.push(row);
    }
  }
  // A late page can run past the end of every source; wrap back to the start.
  if (out.length === 0 && page > 0) return whoToFollow(userId, { limit, page: 0 });
  return out;
}

/** Larger list for Discover / "View all". */
async function suggestions(userId, { limit = 20 } = {}) {
  return whoToFollow(userId, { limit, page: 0 });
}

module.exports = { whoToFollow, suggestions };
