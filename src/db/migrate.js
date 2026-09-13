#!/usr/bin/env node
'use strict';

/**
 * Minimal forward-only SQL migration runner.
 *
 *   node src/db/migrate.js up       apply every pending migration
 *   node src/db/migrate.js status   list applied / pending migrations
 *
 * Each file in /migrations is applied exactly once, inside a transaction,
 * in filename order. Files are checksummed so an edited, already-applied
 * migration is reported instead of silently ignored.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/db');
const logger = require('../config/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function applied(client) {
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function up() {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    const files = readMigrations();
    let count = 0;

    for (const file of files) {
      const previous = done.get(file.name);
      if (previous) {
        if (previous !== file.checksum) {
          logger.warn(
            { migration: file.name },
            'migration file changed after it was applied - create a new migration instead'
          );
        }
        continue;
      }
      logger.info({ migration: file.name }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum]
        );
        await client.query('COMMIT');
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err, migration: file.name }, 'migration failed');
        throw err;
      }
    }
    logger.info({ applied: count, total: files.length }, 'migrations complete');
  } finally {
    client.release();
  }
}

async function status() {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    for (const file of readMigrations()) {
      const state = done.has(file.name)
        ? done.get(file.name) === file.checksum
          ? 'applied'
          : 'applied (file modified!)'
        : 'pending';
      process.stdout.write(`${state.padEnd(24)} ${file.name}\n`);
    }
  } finally {
    client.release();
  }
}

async function main() {
  const command = process.argv[2] || 'up';
  if (command === 'up') await up();
  else if (command === 'status') await status();
  else {
    process.stderr.write('usage: migrate.js [up|status]\n');
    process.exitCode = 1;
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'migration runner failed');
    process.exit(1);
  });
}

module.exports = { up, status };
