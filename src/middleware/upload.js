'use strict';

const multer = require('multer');
const config = require('../config/env');
const { badRequest, tooLarge } = require('../utils/errors');
const storage = require('../services/storage');

/**
 * Uploads are buffered in memory (never written under a user-controlled
 * path), size-capped by multer, then content-sniffed by the storage service
 * before anything touches the disk.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxSize,
    files: 4,
    fields: 20,
    parts: 30,
  },
  fileFilter(req, file, cb) {
    const declared = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!storage.ALLOWED_MIME_TYPES.includes(declared)) {
      cb(badRequest('Twiq accepts JPEG, PNG, GIF, WebP, MP4 and WebM files only.'));
      return;
    }
    cb(null, true);
  },
});

function translateMulterError(err) {
  if (!(err instanceof multer.MulterError)) return err;
  if (err.code === 'LIMIT_FILE_SIZE') {
    return tooLarge(`Files must be smaller than ${Math.round(config.uploads.maxSize / 1048576)} MB.`);
  }
  if (err.code === 'LIMIT_FILE_COUNT') return badRequest('Too many files.');
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return badRequest('Unexpected file field.');
  return badRequest('That upload could not be processed.');
}

/** Wrap a multer handler so its errors become normal HttpErrors. */
function single(field) {
  const handler = upload.single(field);
  return function singleUpload(req, res, next) {
    handler(req, res, (err) => (err ? next(translateMulterError(err)) : next()));
  };
}

function array(field, maxCount = 4) {
  const handler = upload.array(field, maxCount);
  return function arrayUpload(req, res, next) {
    handler(req, res, (err) => (err ? next(translateMulterError(err)) : next()));
  };
}

module.exports = { upload, single, array, translateMulterError };
