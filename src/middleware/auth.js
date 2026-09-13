'use strict';

const userModel = require('../models/user');
const { unauthorized, forbidden, notFound } = require('../utils/errors');

/** Load the signed-in member onto `req.user` for every request. */
function loadUser() {
  return async function loadUserMiddleware(req, res, next) {
    try {
      if (!req.session || !req.session.userId) {
        req.user = null;
        return next();
      }
      const user = await userModel.findById(req.session.userId);
      // A deleted or suspended account is signed out on its next request.
      // `destroy` clears req.session, so the rest of the stack must cope
      // with there being no session at all - see requireAuth below.
      if (!user || user.is_suspended) {
        return req.session.destroy(() => {
          req.user = null;
          next();
        });
      }
      req.user = user;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.xhr || req.get('accept') === 'application/json';
}

function requireAuth() {
  return function requireAuthMiddleware(req, res, next) {
    if (req.user) return next();
    if (wantsJson(req)) return next(unauthorized());
    const target = req.originalUrl && req.method === 'GET' ? req.originalUrl : '/home';
    if (req.session) req.session.returnTo = target;
    return res.redirect(`/login?redirect=${encodeURIComponent(target)}`);
  };
}

function requireGuest() {
  return function requireGuestMiddleware(req, res, next) {
    if (!req.user) return next();
    return res.redirect('/home');
  };
}

function requireRole(...roles) {
  const allowed = new Set(roles);
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (!allowed.has(req.user.role)) {
      // Do not confirm that the admin area exists to a regular member.
      return next(wantsJson(req) ? forbidden() : notFound());
    }
    return next();
  };
}

module.exports = { loadUser, requireAuth, requireGuest, requireRole, wantsJson };
