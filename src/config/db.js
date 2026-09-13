'use strict';

const { Pool } = require('pg');
const config = require('./env');
const logger = require('./logger');

// Return BIGINT (int8) as a JS number. Every bigint column in Twiq is an
// identity/count column that stays far below Number.MAX_SAFE_INTEGER.
require('pg').types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  application_name: 'twiq',
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected error on idle postgres client');
});

const SLOW_QUERY_MS = 250;

async function query(text, params) {
  const started = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > SLOW_QUERY_MS) {
      logger.warn({ ms: Math.round(ms), sql: text.replace(/\s+/g, ' ').slice(0, 200) }, 'slow query');
    }
    return result;
  } catch (err) {
    logger.error(
      { err, sql: text.replace(/\s+/g, ' ').slice(0, 300) },
      'database query failed'
    );
    throw err;
  }
}

/** Convenience: first row or null. */
async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

/** Convenience: all rows. */
async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/** Run `fn` inside a transaction, with automatic ROLLBACK on throw. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, one, many, transaction, healthcheck, close };
