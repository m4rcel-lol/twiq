'use strict';

/**
 * Cursor-based pagination helpers.
 *
 * A cursor is an opaque, URL-safe base64 string encoding the sort key of the
 * last row of a page: `<epoch-millis>.<id>`. Keyset pagination keeps timeline
 * queries O(page) regardless of how deep the reader scrolls.
 */

function encodeCursor(date, id) {
  if (!date) return null;
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Buffer.from(`${ms}.${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string' || cursor.length > 128) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^(\d{1,16})\.(\d{1,19})$/.exec(raw);
    if (!match) return null;
    const ms = Number(match[1]);
    const id = Number(match[2]);
    if (!Number.isFinite(ms) || !Number.isFinite(id)) return null;
    return { at: new Date(ms), id };
  } catch {
    return null;
  }
}

/** Clamp a user supplied page size. */
function pageSize(value, fallback = 20, max = 50) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

module.exports = { encodeCursor, decodeCursor, pageSize };
