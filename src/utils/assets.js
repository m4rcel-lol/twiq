'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../config/logger');

/**
 * Cache-busting for the stylesheet and the script.
 *
 * Static assets are served with a long max-age, which is only safe if the URL
 * changes when the file does. Each file's content hash is computed once at
 * startup and appended as `?v=`, so a deploy invalidates the old copy and a
 * returning reader never has to force a reload.
 */

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const cache = new Map();

function version(relativePath) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  let stamp;
  try {
    const buffer = fs.readFileSync(path.join(PUBLIC_DIR, relativePath));
    stamp = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 10);
  } catch (err) {
    logger.warn({ err, asset: relativePath }, 'could not fingerprint asset');
    stamp = String(Date.now());
  }
  cache.set(relativePath, stamp);
  return stamp;
}

/** `asset('/css/twiq.css')` -> `/css/twiq.css?v=1a2b3c4d5e` */
function asset(url) {
  const relativePath = url.replace(/^\//, '');
  return `${url}?v=${version(relativePath)}`;
}

module.exports = { asset, version };
