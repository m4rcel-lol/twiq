'use strict';

const crypto = require('crypto');
const { forbidden } = require('../utils/errors');

/**
 * Synchronizer-token CSRF protection.
 *
 * A random token is minted per session and must be echoed back in a `_csrf`
 * field or an `X-CSRF-Token` header on every state-changing request.
 * Comparison is constant time.
 *
 * Multipart bodies are the awkward case: `express.urlencoded` cannot read
 * them, so the token is still unparsed when the global check runs. Rather
 * than weaken the check, the multipart endpoints are mounted *before* this
 * middleware (see src/routes/uploads.js), where they parse the body with
 * multer and then call `verifyCsrf()` themselves. Anything multipart that
 * reaches the global middleware therefore has no legitimate reason to be
 * there and is refused outright.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isMultipart(req) {
  return String(req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data');
}

function suppliedToken(req) {
  return (
    (req.body && req.body._csrf) ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token') ||
    (req.query && req.query._csrf)
  );
}

function badToken() {
  return forbidden(
    'Your session expired or the form was tampered with. Please reload the page and try again.',
    { code: 'EBADCSRFTOKEN' }
  );
}

/** Check the token and drop it from the body. Throws on mismatch. */
function check(req) {
  const token = ensureToken(req);
  if (!token || !safeEqual(token, suppliedToken(req))) throw badToken();
  // The token has done its job; drop it so it never reaches a validator,
  // a model or a log line.
  if (req.body && typeof req.body === 'object') delete req.body._csrf;
}

/** Global protection for every route whose body a standard parser can read. */
function csrf() {
  return function csrfMiddleware(req, res, next) {
    const token = ensureToken(req);
    res.locals.csrfToken = token || '';
    req.csrfToken = () => token;

    if (SAFE_METHODS.has(req.method)) return next();

    if (isMultipart(req)) {
      // A multipart POST only reaches here if it was aimed at a route that
      // does not accept file uploads - which is exactly what a cross-site
      // form post trying to dodge the token check looks like.
      return next(badToken());
    }

    try {
      check(req);
    } catch (err) {
      return next(err);
    }
    return next();
  };
}

/** Route-level protection, used immediately after multer has parsed a form. */
function verifyCsrf() {
  return function verifyCsrfMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    try {
      check(req);
    } catch (err) {
      return next(err);
    }
    return next();
  };
}

module.exports = { csrf, verifyCsrf, ensureToken };
