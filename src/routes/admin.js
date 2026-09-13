'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const admin = require('../controllers/admin');
const { requireAuth, requireRole } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');

const router = express.Router();

// The whole panel needs a signed-in moderator or administrator; anything else
// gets a 404, so its existence is not discoverable.
router.use(requireAuth(), requireRole('admin', 'moderator'));

const USERNAME = '[A-Za-z0-9_]{1,15}';

router.get('/', asyncHandler(admin.overview));

// -- people ---------------------------------------------------------------
router.get('/users', asyncHandler(admin.users));
router.get(`/users/:username(${USERNAME})`, asyncHandler(admin.userDetail));
router.post(`/users/:username(${USERNAME})/suspend`, asyncHandler(admin.suspendUser));
router.post(`/users/:username(${USERNAME})/unsuspend`, asyncHandler(admin.unsuspendUser));
router.post(`/users/:username(${USERNAME})/sign-out`, asyncHandler(admin.signOutUser));
router.post(`/users/:username(${USERNAME})/role`, asyncHandler(admin.setRole));
router.post(`/users/:username(${USERNAME})/verified`, asyncHandler(admin.setVerified));
router.post(`/users/:username(${USERNAME})/reset-link`, limits.passwordReset, asyncHandler(admin.resetLink));
router.post(`/users/:username(${USERNAME})/delete`, asyncHandler(admin.deleteUser));

// -- content --------------------------------------------------------------
router.get('/content', asyncHandler(admin.content));
router.post('/tweets/:id(\\d+)/delete', asyncHandler(admin.deleteTweet));

// -- reports --------------------------------------------------------------
router.get('/reports', asyncHandler(admin.reports));
router.post('/reports/:id(\\d+)/resolve', asyncHandler(admin.resolveReport));

// -- trends ---------------------------------------------------------------
router.get('/trends', asyncHandler(admin.trends));
router.post('/trends', asyncHandler(admin.saveTrend));
router.post('/trends/refresh', asyncHandler(admin.refreshTrends));
router.post('/trends/:id(\\d+)/delete', asyncHandler(admin.deleteTrend));

// -- status page (moderators may operate it; deletions are admin-only) ----
router.get('/status', asyncHandler(admin.status));
router.post('/status/components', asyncHandler(admin.addComponent));
router.post('/status/components/:id(\\d+)', asyncHandler(admin.setComponentStatus));
router.post('/status/components/:id(\\d+)/delete', asyncHandler(admin.removeComponent));
router.post('/status/all-clear', asyncHandler(admin.allClear));
router.post('/status/incidents', asyncHandler(admin.createIncident));
router.post('/status/incidents/:id(\\d+)/update', asyncHandler(admin.addIncidentUpdate));
router.post('/status/incidents/:id(\\d+)/delete', asyncHandler(admin.deleteIncident));

// -- system (administrators only, enforced in the controller too) ---------
router.get('/system', requireRole('admin'), asyncHandler(admin.system));
router.post('/system/settings', requireRole('admin'), asyncHandler(admin.updateSettings));
router.post('/system/maintenance/:task', requireRole('admin'), asyncHandler(admin.runMaintenance));

// -- audit ----------------------------------------------------------------
router.get('/audit', asyncHandler(admin.audit));

module.exports = router;
