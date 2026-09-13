'use strict';

/**
 * Public facts about this installation.
 *
 * Deliberately separate from userModel.stats(), which the control panel
 * uses: that one counts suspensions and open reports, and moderation
 * internals have no business on a public page.
 */

const db = require('../config/db');

async function publicStats() {
  const row = await db.one(`
    SELECT (SELECT count(*) FROM users WHERE is_suspended = false)::int AS accounts,
           (SELECT count(*) FROM tweets WHERE is_deleted = false)::int AS tweets,
           (SELECT count(*) FROM media)::int AS uploads,
           (SELECT min(created_at) FROM users) AS opened,
           (SELECT count(DISTINCT t.user_id) FROM tweets t
             JOIN users u ON u.id = t.user_id
            WHERE u.is_suspended = false
              AND t.created_at > now() - interval '7 days')::int AS active_this_week
  `);
  return row || { accounts: 0, tweets: 0, uploads: 0, opened: null, active_this_week: 0 };
}

/** Whoever runs the place: the official account, then the staff. */
async function staff() {
  return db.many(`
    SELECT username, display_name, avatar_path, bio, role, is_official, is_verified
      FROM users
     WHERE is_suspended = false AND (is_official OR role IN ('admin', 'moderator'))
     ORDER BY is_official DESC,
              CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
              username
     LIMIT 20
  `);
}

module.exports = { publicStats, staff };
