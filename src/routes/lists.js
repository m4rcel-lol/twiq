'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const lists = require('../controllers/lists');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth(), asyncHandler(lists.index));
router.post('/', requireAuth(), asyncHandler(lists.create));
router.get('/:id(\\d+)', asyncHandler(lists.show));
router.get('/:id(\\d+)/members', asyncHandler(lists.members));
router.post('/:id(\\d+)/update', requireAuth(), asyncHandler(lists.update));
router.post('/:id(\\d+)/delete', requireAuth(), asyncHandler(lists.destroy));
router.post('/:id(\\d+)/members', requireAuth(), asyncHandler(lists.addMember));
router.post('/:id(\\d+)/members/:username/delete', requireAuth(), asyncHandler(lists.removeMember));

module.exports = router;
