'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const home = require('../controllers/home');
const connect = require('../controllers/connect');
const discover = require('../controllers/discover');
const search = require('../controllers/search');
const tweets = require('../controllers/tweets');
const pages = require('../controllers/pages');
const status = require('../controllers/status');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');

const router = express.Router();

router.get('/', asyncHandler(home.landing));
router.get('/home', requireAuth(), asyncHandler(home.home));
router.get('/home/new-count', requireAuth(), asyncHandler(home.newCount));
router.get('/who-to-follow', requireAuth(), asyncHandler(home.refreshWhoToFollow));
router.post('/trends/location', requireAuth(), asyncHandler(home.changeTrendScope));

router.get('/compose', requireAuth(), asyncHandler(home.compose));
router.get('/compose/tweet', requireAuth(), asyncHandler(home.compose));

router.get('/connect', requireAuth(), asyncHandler(connect.index));
router.get('/notifications', requireAuth(), (req, res) => res.redirect('/connect'));
router.get('/connect/unread', requireAuth(), asyncHandler(connect.unreadCount));

router.get('/discover', asyncHandler(discover.index));

// The status page, and a small feed for anything watching from outside.
router.get('/status', asyncHandler(status.show));
router.get('/status.json', asyncHandler(status.json));

// The pages the footer links to.
router.get('/about', pages.show('about'));
router.get('/help', pages.show('help'));
router.get('/terms', pages.show('terms'));
router.get('/privacy', pages.show('privacy'));
router.get('/search', limits.search, asyncHandler(search.index));

// Tweet creation and interactions (form posts; the JSON API mirrors these).
router.post('/tweets', requireAuth(), limits.tweet, asyncHandler(tweets.create));
router.post('/tweets/:id/favorite', requireAuth(), limits.interaction, asyncHandler(tweets.favorite));
router.post('/tweets/:id/unfavorite', requireAuth(), limits.interaction, asyncHandler(tweets.unfavorite));
router.get('/tweets/:id/retweet', requireAuth(), asyncHandler(tweets.retweetChoice));
router.post('/tweets/:id/retweet', requireAuth(), limits.interaction, asyncHandler(tweets.retweet));
router.post('/tweets/:id/unretweet', requireAuth(), limits.interaction, asyncHandler(tweets.unretweet));
router.post('/tweets/:id/pin', requireAuth(), asyncHandler(tweets.pin));
router.post('/tweets/:id/unpin', requireAuth(), asyncHandler(tweets.unpin));
router.post('/tweets/:id/delete', requireAuth(), asyncHandler(tweets.destroy));
router.get('/tweets/:id/report', requireAuth(), asyncHandler(tweets.showReport));
router.post('/reports', requireAuth(), limits.report, asyncHandler(tweets.submitReport));

// POST /media is a multipart upload and lives in routes/uploads.js, which is
// mounted ahead of the global CSRF middleware.

module.exports = router;
