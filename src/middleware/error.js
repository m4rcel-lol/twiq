'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const { HttpError, notFound } = require('../utils/errors');

const TITLES = {
  400: 'That request did not look right',
  401: 'Please sign in',
  403: 'You are not allowed to see this',
  404: 'Sorry, that page does not exist',
  413: 'That file is too large',
  429: 'You are doing that too often',
  503: 'Twiq is read-only right now',
  500: 'Something is technically wrong',
};

const PAGES = new Set([400, 403, 404, 429, 500, 503]);

/**
 * An error can be raised before `baseLocals` has run - by the body parser,
 * the session store or a rate limiter - so the error page supplies every
 * local the layout needs rather than assuming they are already there.
 */
function chromeDefaults() {
  return {
    brand: config.brand,
    baseUrl: config.baseUrl,
    csrfToken: '',
    currentPath: '',
    nav: null,
    flash: [],
    currentUser: null,
    profileTheme: null,
    unreadNotifications: 0,
    unreadMessages: 0,
    pendingFollowRequests: 0,
    websocketsEnabled: false,
    registrationEnabled: config.features.registration,
    canonical: null,
    ogImage: null,
    ogType: 'website',
  };
}

/** Last resort if even the error template fails to render. */
function plainPage(status, heading, message) {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${heading} | ${config.brand.name}</title>` +
    '<link rel="stylesheet" href="/css/twiq.css"></head><body>' +
    `<div class="error-shell"><div class="code">${status}</div>` +
    `<h1>${heading}</h1><p>${message}</p>` +
    `<div class="error-actions"><a class="btn btn-primary" href="/">Back to ${config.brand.name}</a></div>` +
    '</div></body></html>'
  );
}

function notFoundHandler() {
  return function notFoundMiddleware(req, res, next) {
    next(notFound());
  };
}

function wantsJson(req) {
  if (req.path.startsWith('/api/')) return true;
  if (req.xhr) return true;
  const accept = req.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function errorHandler() {
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  return function errorMiddleware(err, req, res, next) {
    let status = Number(err.status || err.statusCode || 500);
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;

    const expose = err instanceof HttpError ? err.expose : status < 500;
    const heading = TITLES[status] || TITLES[500];
    const message = expose && err.message ? err.message : heading;

    if (status >= 500) {
      logger.error(
        { err, path: req.originalUrl, method: req.method, userId: req.user && req.user.id },
        'unhandled application error'
      );
    } else {
      logger.warn(
        { status, path: req.originalUrl, method: req.method, msg: err.message },
        'request rejected'
      );
    }

    if (res.headersSent) return res.end();

    res.status(status);
    if (wantsJson(req)) {
      return res.json({
        error: {
          status,
          message,
          code: err.code || undefined,
          details: expose ? err.details : undefined,
        },
      });
    }

    const view = `errors/${PAGES.has(status) ? status : 500}`;
    return res.render(
      view,
      {
        ...chromeDefaults(),
        layout: 'layouts/minimal',
        title: `${heading} | ${config.brand.name}`,
        description: heading,
        bodyClass: 'page-error',
        status,
        heading,
        message,
        noindex: true,
        stack: config.isProduction ? null : err.stack,
      },
      (renderErr, html) => {
        if (renderErr) {
          logger.error({ err: renderErr, view }, 'failed to render the error page');
          return res.type('html').send(plainPage(status, heading, message));
        }
        return res.type('html').send(html);
      }
    );
  };
}

module.exports = { notFoundHandler, errorHandler };
