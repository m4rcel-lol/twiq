'use strict';

const moderation = require('../models/moderation');
const config = require('../config/env');
const logger = require('../config/logger');

/**
 * Live system settings.
 *
 * These are the knobs the control panel turns while the site is running, so
 * they cannot come from the environment. They are read on nearly every
 * request, so they are cached in process for a few seconds and the cache is
 * dropped the moment the panel writes one.
 */

const CACHE_TTL_MS = 15 * 1000;

const DEFAULTS = {
  registration_open: config.features.registration,
  announcement: '',
  announcement_level: 'info',
  read_only: false,
  maintenance: false,
  maintenance_message: '',
  status_url: '/status',
};

let cache = { at: 0, values: null };

async function all() {
  if (cache.values && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  try {
    const rows = await moderation.allSystemSettings();
    const values = { ...DEFAULTS };
    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, row.key)) values[row.key] = row.value;
    }
    cache = { at: Date.now(), values };
    return values;
  } catch (err) {
    // A settings lookup must never take the site down.
    logger.error({ err }, 'failed to read system settings');
    return cache.values || { ...DEFAULTS };
  }
}

async function get(key) {
  const values = await all();
  return values[key];
}

async function set(key, value, actorId) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`Unknown system setting: ${key}`);
  }
  await moderation.setSystemSetting(key, value, actorId);
  invalidate();
}

function invalidate() {
  cache = { at: 0, values: null };
}

module.exports = { DEFAULTS, all, get, set, invalidate };
