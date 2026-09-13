'use strict';

const config = require('../config/env');
const present = require('../services/present');
const notificationModel = require('../models/notification');
const messageModel = require('../models/message');
const graphModel = require('../models/graph');
const { ensureToken } = require('./csrf');

/**
 * Everything the chrome (top bar, flash messages, page metadata) needs,
 * assembled once per request.
 */

function flash() {
  return function flashMiddleware(req, res, next) {
    req.flash = (type, message) => {
      if (!req.session) return;
      if (!req.session.flash) req.session.flash = [];
      req.session.flash.push({ type, message });
      if (req.session.flash.length > 5) req.session.flash.shift();
    };
    res.locals.flash = (req.session && req.session.flash) || [];
    if (req.session && req.session.flash) delete req.session.flash;
    next();
  };
}

function baseLocals() {
  return function baseLocalsMiddleware(req, res, next) {
    // Minted here rather than in the CSRF middleware, because the upload
    // routes are handled before that middleware runs and can still render
    // an error page.
    res.locals.csrfToken = ensureToken(req) || '';
    res.locals.brand = config.brand;
    res.locals.baseUrl = config.baseUrl;
    res.locals.currentPath = req.path;
    res.locals.nav = null;
    res.locals.title = config.brand.name;
    res.locals.description = `${config.brand.name} - ${config.brand.tagline}`;
    res.locals.canonical = null;
    res.locals.ogImage = null;
    res.locals.ogType = 'website';
    res.locals.noindex = false;
    res.locals.bodyClass = '';
    res.locals.currentUser = null;
    res.locals.profileTheme = null;
    // Light is the default, and needs no attribute at all.
    res.locals.theme = 'light';
    res.locals.unreadNotifications = 0;
    res.locals.unreadMessages = 0;
    res.locals.pendingFollowRequests = 0;
    res.locals.websocketsEnabled = config.features.websockets;
    res.locals.registrationEnabled = config.features.registration;
    next();
  };
}

/** Badge counts and the viewer's own presentation object. */
function viewerContext() {
  return async function viewerContextMiddleware(req, res, next) {
    try {
      if (!req.user) return next();
      res.locals.currentUser = present.user(req.user);
      if (req.path.startsWith('/api/')) return next();

      const [notifications, messages, requests, theme] = await Promise.all([
        notificationModel.unreadCount(req.user.id),
        messageModel.totalUnread(req.user.id),
        req.user.is_protected ? graphModel.pendingRequestCount(req.user.id) : Promise.resolve(0),
        require('../models/user').getProfileSettings(req.user.id),
      ]);
      res.locals.unreadNotifications = notifications;
      res.locals.unreadMessages = messages;
      res.locals.pendingFollowRequests = requests;
      res.locals.profileTheme = theme
        ? {
            accent: theme.accent_color,
            background: theme.background_color,
            backgroundUrl: theme.background_path ? present.mediaUrl(theme.background_path) : null,
            tile: theme.background_tile,
          }
        : null;
      res.locals.theme = (theme && theme.theme) || 'light';
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { flash, baseLocals, viewerContext };
