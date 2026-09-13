'use strict';

const express = require('express');

const router = express.Router();

// Order matters: `/:username` is the catch-all and must be mounted last.
router.use('/api', require('./api'));
router.use('/', require('./auth'));
router.use('/', require('./main'));
router.use('/messages', require('./messages'));
router.use('/lists', require('./lists'));
router.use('/settings', require('./settings'));
router.use('/admin', require('./admin'));
router.use('/', require('./profile'));

module.exports = router;
