'use strict';

/**
 * Every endpoint that accepts a multipart form.
 *
 * These are mounted *before* the global CSRF middleware, because a multipart
 * body has to be parsed by multer before the `_csrf` field can be read. Each
 * route therefore runs the check itself, in this order:
 *
 *   requireAuth  ->  rate limit  ->  multer  ->  verifyCsrf  ->  handler
 *
 * Authentication comes first so an anonymous request is rejected before any
 * file is read into memory.
 */

const express = require('express');
const asyncHandler = require('../utils/async');
const settings = require('../controllers/settings');
const tweets = require('../controllers/tweets');
const messages = require('../controllers/messages');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const limits = require('../middleware/rateLimit');
const upload = require('../middleware/upload');

const router = express.Router();

router.post(
  '/media',
  requireAuth(),
  limits.upload,
  upload.single('media'),
  verifyCsrf(),
  asyncHandler(tweets.uploadMedia)
);

router.post(
  '/settings/profile/avatar',
  requireAuth(),
  limits.upload,
  upload.single('avatar'),
  verifyCsrf(),
  asyncHandler(settings.updateAvatar)
);

router.post(
  '/settings/profile/header',
  requireAuth(),
  limits.upload,
  upload.single('header'),
  verifyCsrf(),
  asyncHandler(settings.updateHeader)
);

router.post(
  '/settings/design',
  requireAuth(),
  limits.upload,
  upload.single('background'),
  verifyCsrf(),
  asyncHandler(settings.updateDesign)
);

// Direct Messages may or may not carry a photo; multer passes a plain
// form-encoded body straight through, so one route covers both.
router.post(
  '/messages/:id(\\d+)',
  requireAuth(),
  limits.dm,
  upload.single('media'),
  verifyCsrf(),
  asyncHandler(messages.send)
);

module.exports = router;
