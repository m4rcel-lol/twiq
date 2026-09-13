'use strict';

const db = require('../config/db');
const userModel = require('./user');
const { forbidden, notFound, conflict, badRequest } = require('../utils/errors');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'list';
}

async function create(ownerId, { name, description = '', isPrivate = false }) {
  const clean = String(name || '').trim();
  if (!clean) throw badRequest('Give your List a name.');
  if (clean.length > 25) throw badRequest('List names are limited to 25 characters.');
  let slug = slugify(clean);
  return db.transaction(async (client) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const inserted = await client.query(
          `INSERT INTO lists (owner_id, name, slug, description, is_private)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [ownerId, clean, slug, String(description || '').slice(0, 160), isPrivate]
        );
        await client.query('UPDATE users SET list_count = list_count + 1 WHERE id = $1', [ownerId]);
        return inserted.rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
        slug = `${slugify(clean)}-${attempt + 2}`;
      }
    }
    throw conflict('You already have too many Lists with that name.');
  });
}

async function findById(id) {
  return db.one(
    `SELECT l.*, u.username AS owner_username, u.display_name AS owner_display_name,
            u.avatar_path AS owner_avatar_path
       FROM lists l JOIN users u ON u.id = l.owner_id WHERE l.id = $1`,
    [id]
  );
}

async function forOwner(ownerId, { viewerId = null } = {}) {
  const includePrivate = Number(ownerId) === Number(viewerId);
  return db.many(
    `SELECT l.*, u.username AS owner_username
       FROM lists l JOIN users u ON u.id = l.owner_id
      WHERE l.owner_id = $1 AND ($2::boolean OR l.is_private = false)
      ORDER BY l.created_at DESC`,
    [ownerId, includePrivate]
  );
}

function canView(list, viewerId) {
  if (!list) return false;
  if (!list.is_private) return true;
  return Number(list.owner_id) === Number(viewerId);
}

function assertOwner(list, userId) {
  if (!list) throw notFound('That List does not exist.');
  if (Number(list.owner_id) !== Number(userId)) throw forbidden('That is not your List.');
}

async function update(listId, ownerId, { name, description, isPrivate }) {
  const list = await findById(listId);
  assertOwner(list, ownerId);
  const clean = String(name || list.name).trim().slice(0, 25);
  await db.query(
    `UPDATE lists SET name = $2, description = $3, is_private = $4 WHERE id = $1`,
    [listId, clean, String(description || '').slice(0, 160), Boolean(isPrivate)]
  );
  return findById(listId);
}

async function remove(listId, ownerId) {
  const list = await findById(listId);
  assertOwner(list, ownerId);
  await db.transaction(async (client) => {
    await client.query('DELETE FROM lists WHERE id = $1', [listId]);
    await client.query('UPDATE users SET list_count = GREATEST(list_count - 1, 0) WHERE id = $1', [ownerId]);
  });
}

async function addMember(listId, ownerId, userId) {
  const list = await findById(listId);
  assertOwner(list, ownerId);
  await db.transaction(async (client) => {
    const inserted = await client.query(
      'INSERT INTO list_members (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING list_id',
      [listId, userId]
    );
    if (inserted.rowCount > 0) {
      await client.query('UPDATE lists SET member_count = member_count + 1 WHERE id = $1', [listId]);
    }
  });
}

async function removeMember(listId, ownerId, userId) {
  const list = await findById(listId);
  assertOwner(list, ownerId);
  await db.transaction(async (client) => {
    const removed = await client.query(
      'DELETE FROM list_members WHERE list_id = $1 AND user_id = $2 RETURNING list_id',
      [listId, userId]
    );
    if (removed.rowCount > 0) {
      await client.query('UPDATE lists SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1', [listId]);
    }
  });
}

async function members(listId, { viewerId = null, limit = 50, offset = 0 } = {}) {
  return db.many(
    `SELECT ${userModel.PUBLIC_COLUMNS}, (vf.follower_id IS NOT NULL) AS viewer_follows
       FROM list_members lm
       JOIN users u ON u.id = lm.user_id
       LEFT JOIN follows vf ON vf.follower_id = $2 AND vf.followee_id = u.id
      WHERE lm.list_id = $1
      ORDER BY lm.created_at DESC LIMIT $3 OFFSET $4`,
    [listId, viewerId, limit, offset]
  );
}

async function memberIds(listId) {
  const rows = await db.many('SELECT user_id FROM list_members WHERE list_id = $1', [listId]);
  return rows.map((r) => Number(r.user_id));
}

module.exports = {
  create,
  findById,
  forOwner,
  canView,
  update,
  remove,
  addMember,
  removeMember,
  members,
  memberIds,
  slugify,
};
