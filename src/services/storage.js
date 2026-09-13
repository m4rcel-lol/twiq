'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const { badRequest } = require('../utils/errors');

/**
 * Media storage.
 *
 * `LocalDriver` writes to UPLOAD_DIR using a randomly generated, sharded key.
 * The original filename supplied by the browser is never used for anything -
 * not for the path, not for the extension - which rules out path traversal and
 * double-extension tricks. Add an S3 driver by implementing the same three
 * methods and registering it in `createDriver`.
 */

const ALLOWED = {
  'image/jpeg': { ext: 'jpg', kind: 'photo' },
  'image/png': { ext: 'png', kind: 'photo' },
  'image/gif': { ext: 'gif', kind: 'animated_gif' },
  'image/webp': { ext: 'webp', kind: 'photo' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
};

/** Magic-number sniffing - the declared Content-Type is never trusted alone. */
function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const hex = buffer.subarray(0, 12);
  if (hex[0] === 0xff && hex[1] === 0xd8 && hex[2] === 0xff) return 'image/jpeg';
  if (hex.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  const ascii6 = hex.subarray(0, 6).toString('latin1');
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') return 'image/gif';
  if (hex.subarray(0, 4).toString('latin1') === 'RIFF' && hex.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (hex.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (hex.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null;
}

/**
 * Validate an uploaded buffer. Throws a 400 when the real content does not
 * match an allowed type, or when it disagrees with the declared type.
 */
function validateUpload(buffer, declaredMime, { images = true, videos = true } = {}) {
  if (!buffer || buffer.length === 0) throw badRequest('That file is empty.');
  if (buffer.length > config.uploads.maxSize) {
    throw badRequest(`Files must be smaller than ${Math.round(config.uploads.maxSize / 1048576)} MB.`);
  }
  const sniffed = sniffMime(buffer);
  if (!sniffed || !ALLOWED[sniffed]) {
    throw badRequest('Twiq accepts JPEG, PNG, GIF, WebP, MP4 and WebM files only.');
  }
  const declared = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  if (declared && ALLOWED[declared] && declared !== sniffed) {
    // jpeg is often announced as image/jpg; anything else is a mismatch.
    throw badRequest('That file does not look like the type it claims to be.');
  }
  const meta = ALLOWED[sniffed];
  if (!images && meta.kind !== 'video') throw badRequest('Only video files are accepted here.');
  if (!videos && meta.kind === 'video') throw badRequest('Only image files are accepted here.');
  return { mime: sniffed, ext: meta.ext, kind: meta.kind, size: buffer.length };
}

function randomKey(prefix, ext) {
  const id = crypto.randomBytes(16).toString('hex');
  // Shard by the first two bytes so a single directory never holds everything.
  return `${prefix}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.${ext}`;
}

class LocalDriver {
  constructor(root, publicPath) {
    this.root = path.resolve(root);
    this.publicPath = publicPath.replace(/\/+$/, '');
    fsSync.mkdirSync(this.root, { recursive: true });
  }

  resolve(key) {
    const target = path.resolve(this.root, key);
    // Defence in depth: a key must never escape the upload root.
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw badRequest('Invalid storage key.');
    }
    return target;
  }

  async save(buffer, { prefix = 'media', ext = 'bin' } = {}) {
    const key = randomKey(prefix, ext);
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer, { mode: 0o644, flag: 'wx' });
    return key;
  }

  urlFor(key) {
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;
    return `${this.publicPath}/${key}`;
  }

  async remove(key) {
    if (!key) return;
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err, key }, 'failed to remove stored file');
    }
  }
}

function createDriver() {
  switch (config.uploads.driver) {
    case 'local':
      return new LocalDriver(config.uploads.dir, config.uploads.publicPath);
    default:
      throw new Error(`Unsupported STORAGE_DRIVER: ${config.uploads.driver}`);
  }
}

const driver = createDriver();

module.exports = {
  driver,
  validateUpload,
  sniffMime,
  ALLOWED_MIME_TYPES: Object.keys(ALLOWED),
  save: (buffer, opts) => driver.save(buffer, opts),
  urlFor: (key) => driver.urlFor(key),
  remove: (key) => driver.remove(key),
};
