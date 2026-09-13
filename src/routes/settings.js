'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const settings = require('../controllers/settings');
const profile = require('../controllers/profile');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');

const router = express.Router();

router.use(requireAuth());

router.get('/', settings.index);
router.get('/account', asyncHandler(settings.account));
router.post('/account', asyncHandler(settings.updateAccount));
router.post('/account/resend-verification', asyncHandler(settings.resendVerification));
router.post('/account/delete', asyncHandler(settings.deleteAccount));

router.get('/profile', asyncHandler(settings.profile));
router.post('/profile', asyncHandler(settings.updateProfile));
// /settings/profile/avatar and /settings/profile/header accept multipart
// forms and live in routes/uploads.js, ahead of the global CSRF middleware.
router.post('/profile/header/delete', asyncHandler(settings.removeHeader));

router.get('/password', settings.password);
router.post('/password', asyncHandler(settings.updatePassword));

router.get('/privacy', asyncHandler(settings.privacy));
router.post('/privacy', asyncHandler(settings.updatePrivacy));

router.get('/notifications', asyncHandler(settings.notifications));
router.post('/notifications', asyncHandler(settings.updateNotifications));

router.get('/design', asyncHandler(settings.design));
// POST /settings/design is multipart - see routes/uploads.js.
router.post('/design/background/delete', asyncHandler(settings.removeBackground));
router.post('/design/theme', asyncHandler(settings.toggleTheme));

router.get('/automation', asyncHandler(settings.automation));
// Rate limited like a sign-in: the form takes another account's password,
// so it must not become a quieter way to guess one.
router.post('/automation', limits.login, asyncHandler(settings.updateAutomation));
router.post('/automation/clear', asyncHandler(settings.clearAutomation));

router.get('/blocked', asyncHandler(settings.blocked));
router.get('/muted', asyncHandler(settings.muted));

router.get('/requests', asyncHandler(profile.followRequests));

module.exports = router;
