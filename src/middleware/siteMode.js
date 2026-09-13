'use strict';

const settingsService = require('../services/settings');
const config = require('../config/env');
const { HttpError } = require('../utils/errors');

/**
 * Applies the switches the control panel owns: the announcement banner,
 * whether sign-ups are open, and read-only mode.
 *
 * Read-only keeps the whole site readable and stops anything being written.
 * Paths people still need while it is on - signing in and out, recovering a
 * password, the control panel itself - stay open, and staff are exempt so
 * they can moderate their way out of whatever caused it.
 */

const ALWAYS_WRITABLE = [
  '/login',
  '/logout',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/admin',
  '/settings',
];

/**
 * Reachable even while the site is down: staff have to be able to sign in and
 * reach the control panel to turn maintenance back off, and the health check
 * has to keep answering or the container is declared dead and restarted.
 */
const REACHABLE_IN_MAINTENANCE = [
  '/login', '/logout', '/admin', '/healthz', '/status', '/status.json',
];

function matchesPrefix(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isWritablePath(path) {
  return matchesPrefix(path, ALWAYS_WRITABLE);
}

function isStaff(user) {
  return Boolean(user && (user.role === 'admin' || user.role === 'moderator'));
}

function siteMode() {
  return async function siteModeMiddleware(req, res, next) {
    try {
      const settings = await settingsService.all();

      res.locals.registrationEnabled = Boolean(settings.registration_open);
      res.locals.announcement = settings.announcement || '';
      res.locals.announcementLevel = settings.announcement_level || 'info';
      res.locals.readOnly = Boolean(settings.read_only);
      res.locals.maintenance = Boolean(settings.maintenance);
      req.siteSettings = settings;

      // Maintenance takes the whole site over, so it is checked first.
      if (settings.maintenance && !isStaff(req.user)
          && !matchesPrefix(req.path, REACHABLE_IN_MAINTENANCE)) {
        res.status(503);
        res.set('Retry-After', '600');
        return res.render('maintenance', {
          layout: false,
          brand: config.brand,
          customMessage: settings.maintenance_message || '',
          statusUrl: settings.status_url || '/help',
        });
      }

      if (!settings.read_only) return next();
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
      if (isWritablePath(req.path)) return next();
      if (req.user && (req.user.role === 'admin' || req.user.role === 'moderator')) return next();

      return next(
        new HttpError(503, 'Twiq is read-only at the moment. You can still read everything; posting is paused.')
      );
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { siteMode, isWritablePath, isStaff, ALWAYS_WRITABLE, REACHABLE_IN_MAINTENANCE };
