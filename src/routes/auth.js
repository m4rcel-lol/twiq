'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const auth = require('../controllers/auth');
const { requireGuest, requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const schemas = require('../validators/schemas');

const router = express.Router();

router.get('/register', requireGuest(), auth.showRegister);
router.post(
  '/register',
  requireGuest(),
  limits.register,
  validate(schemas.registration, { mode: 'collect' }),
  asyncHandler(auth.register)
);

router.get('/login', requireGuest(), auth.showLogin);
router.post(
  '/login',
  requireGuest(),
  limits.login,
  validate(schemas.login, { mode: 'collect' }),
  asyncHandler(auth.login)
);

router.post('/logout', requireAuth(), auth.logout);
router.get('/logout', requireAuth(), auth.logout);

router.get('/forgot-password', requireGuest(), auth.showForgotPassword);
router.post('/forgot-password', requireGuest(), limits.passwordReset, asyncHandler(auth.requestPasswordReset));
router.get('/reset-password', requireGuest(), auth.showResetPassword);
router.post('/reset-password', requireGuest(), limits.passwordReset, asyncHandler(auth.resetPassword));
router.get('/verify-email', asyncHandler(auth.verifyEmail));

module.exports = router;
