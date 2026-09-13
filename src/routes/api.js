'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const api = require('../controllers/api');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');

const router = express.Router();

router.get('/me', requireAuth(), asyncHandler(api.me));
router.get('/badges', requireAuth(), asyncHandler(api.badges));

router.get('/timeline/home', requireAuth(), asyncHandler(api.homeTimeline));

router.get('/users/:username', asyncHandler(api.getUser));
router.get('/users/:username/tweets', asyncHandler(api.getUserTweets));
router.post('/users/:username/follow', requireAuth(), limits.interaction, asyncHandler(api.follow));
router.post('/users/:username/unfollow', requireAuth(), limits.interaction, asyncHandler(api.unfollow));

router.get('/tweets/:id(\\d+)', asyncHandler(api.getTweet));
router.post('/tweets', requireAuth(), limits.tweet, asyncHandler(api.createTweet));
router.post('/tweets/:id(\\d+)/delete', requireAuth(), asyncHandler(api.deleteTweet));
router.post('/tweets/:id(\\d+)/favorite', requireAuth(), limits.interaction, asyncHandler(api.favorite));
router.post('/tweets/:id(\\d+)/unfavorite', requireAuth(), limits.interaction, asyncHandler(api.unfavorite));
router.post('/tweets/:id(\\d+)/retweet', requireAuth(), limits.interaction, asyncHandler(api.retweet));
router.post('/tweets/:id(\\d+)/unretweet', requireAuth(), limits.interaction, asyncHandler(api.unretweet));

router.get('/search', limits.search, asyncHandler(api.search));
router.get('/typeahead', requireAuth(), limits.search, asyncHandler(api.typeahead));
router.get('/trends', asyncHandler(api.trends));
router.get('/who-to-follow', requireAuth(), asyncHandler(api.whoToFollow));

module.exports = router;
