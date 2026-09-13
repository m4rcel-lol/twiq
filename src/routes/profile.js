'use strict';

/**
 * `/:username` is matched last of all, after every system route, and the
 * username validator rejects anything that is not a real Twiq handle.
 */

const express = require('express');
const asyncHandler = require('../utils/async');
const profile = require('../controllers/profile');
const tweets = require('../controllers/tweets');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');
const { isReservedUsername } = require('../utils/reserved');
const { notFound } = require('../utils/errors');

const router = express.Router();

const USERNAME = '[A-Za-z0-9_]{1,15}';

/** Reject reserved handles before they ever reach a controller. */
function guardUsername(req, res, next) {
  const name = String(req.params.username || '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name) || isReservedUsername(name)) {
    return next(notFound());
  }
  return next();
}

router.param('username', guardUsername);

router.get(`/:username(${USERNAME})`, asyncHandler(profile.show));
router.get(`/:username(${USERNAME})/status/:id(\\d+)`, asyncHandler(tweets.show));
router.get(`/:username(${USERNAME})/followers`, asyncHandler(profile.followers));
router.get(`/:username(${USERNAME})/following`, asyncHandler(profile.following));
router.get(`/:username(${USERNAME})/favorites`, asyncHandler(profile.favorites));
router.get(`/:username(${USERNAME})/media`, asyncHandler(profile.media));
router.get(`/:username(${USERNAME})/lists`, asyncHandler(profile.lists));
router.get(`/:username(${USERNAME})/report`, requireAuth(), asyncHandler(profile.showReport));

router.post(`/:username(${USERNAME})/follow`, requireAuth(), limits.interaction, asyncHandler(profile.follow));
router.post(`/:username(${USERNAME})/unfollow`, requireAuth(), limits.interaction, asyncHandler(profile.unfollow));
router.post(`/:username(${USERNAME})/block`, requireAuth(), asyncHandler(profile.block));
router.post(`/:username(${USERNAME})/unblock`, requireAuth(), asyncHandler(profile.unblock));
router.post(`/:username(${USERNAME})/mute`, requireAuth(), asyncHandler(profile.mute));
router.post(`/:username(${USERNAME})/unmute`, requireAuth(), asyncHandler(profile.unmute));
router.post(`/:username(${USERNAME})/approve`, requireAuth(), asyncHandler(profile.approveRequest));
router.post(`/:username(${USERNAME})/deny`, requireAuth(), asyncHandler(profile.denyRequest));

module.exports = router;
