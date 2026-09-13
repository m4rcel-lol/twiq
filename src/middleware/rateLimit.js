'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const logger = require('../config/logger');
const { tooMany } = require('../utils/errors');

/**
 * Rate limiting. Keys are the signed-in member id when there is one and the
 * client IP otherwise, so one abusive account cannot burn a shared NAT's
 * budget - and vice versa. Behind Caddy, `trust proxy` makes `req.ip` the
 * real client address.
 */

function keyGenerator(req) {
  return req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
}

function make(name, max, windowMs = config.rateLimit.windowMs, options = {}) {
  const { force, ...limiterOptions } = options;
  if (config.rateLimit.disabled && !force) {
    return (req, res, next) => next();
  }
  options = limiterOptions;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skip: (req) => Boolean(req.user && (req.user.role === 'admin' || req.user.role === 'moderator')),
    handler: (req, res, next) => {
      logger.warn({ limiter: name, key: keyGenerator(req), path: req.path }, 'rate limit exceeded');
      next(tooMany(options.message));
    },
    ...options,
  });
}

module.exports = {
  global: make('global', config.rateLimit.global),
  login: make('login', config.rateLimit.login, 15 * 60 * 1000, {
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    skipSuccessfulRequests: true,
  }),
  register: make('register', config.rateLimit.register, 60 * 60 * 1000, {
    message: 'Too many accounts created from here. Please try again later.',
  }),
  passwordReset: make('password-reset', 5, 60 * 60 * 1000, {
    message: 'Too many password reset requests. Please try again later.',
  }),
  tweet: make('tweet', config.rateLimit.tweet, 15 * 60 * 1000, {
    message: 'You are Tweeting a bit too fast. Take a breath and try again.',
  }),
  dm: make('dm', config.rateLimit.dm, 15 * 60 * 1000, {
    message: 'You are sending messages too quickly.',
  }),
  upload: make('upload', config.rateLimit.upload, 15 * 60 * 1000, {
    message: 'Too many uploads. Please wait a moment.',
  }),
  interaction: make('interaction', 400, 15 * 60 * 1000),
  search: make('search', 200, 15 * 60 * 1000),
  report: make('report', 20, 60 * 60 * 1000, { message: 'Too many reports submitted.' }),
  make,
};
