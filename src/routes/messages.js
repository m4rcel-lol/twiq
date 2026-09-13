'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const messages = require('../controllers/messages');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');

const router = express.Router();

router.use(requireAuth());

router.get('/', asyncHandler(messages.index));
router.post('/new', limits.dm, asyncHandler(messages.create));
router.get('/:id(\\d+)', asyncHandler(messages.show));
// POST /messages/:id may carry a photo - see routes/uploads.js.
router.get('/:id(\\d+)/poll', asyncHandler(messages.poll));
router.post('/:id(\\d+)/delete', asyncHandler(messages.destroy));
router.post('/:id(\\d+)/messages/:messageId(\\d+)/delete', asyncHandler(messages.destroyMessage));

module.exports = router;
