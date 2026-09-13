'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const expressLayouts = require('express-ejs-layouts');
const PgSession = require('connect-pg-simple')(session);

const config = require('./config/env');
const logger = require('./config/logger');
const db = require('./config/db');
const routes = require('./routes');
const uploadRoutes = require('./routes/uploads');
const { csrf } = require('./middleware/csrf');
const { loadUser } = require('./middleware/auth');
const { flash, baseLocals, viewerContext } = require('./middleware/locals');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { siteMode } = require('./middleware/siteMode');
const limits = require('./middleware/rateLimit');
const format = require('./utils/format');
const { escapeHtml, escapeAttribute } = require('./utils/escape');

function createSessionMiddleware() {
  return session({
    store: new PgSession({
      pool: db.pool,
      tableName: 'sessions',
      createTableIfMissing: false,
      pruneSessionInterval: 60 * 15,
    }),
    name: config.session.name,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: config.trustProxy !== false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.secure,
      maxAge: config.session.ttlHours * 60 * 60 * 1000,
      path: '/',
    },
  });
}

function createApp({ sessionMiddleware } = {}) {
  const app = express();

  // Caddy terminates TLS on the host and forwards X-Forwarded-*.
  app.set('trust proxy', config.trustProxy);
  app.set('x-powered-by', false);
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.set('layout', 'layouts/main');
  app.set('layout extractScripts', false);
  app.use(expressLayouts);

  // Helpers every template can use.
  app.locals.fmt = format;
  app.locals.asset = require('./utils/assets').asset;
  app.locals.escapeHtml = escapeHtml;
  app.locals.escapeAttr = escapeAttribute;

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.id || req.get('x-request-id');
        const id = existing || crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url.startsWith('/css/') || req.url.startsWith('/js/'),
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          // Profile themes and the composer's counter colour are applied with
          // style attributes; scripts stay strictly same-origin.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          upgradeInsecureRequests: config.session.secure ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    })
  );

  app.get('/healthz', async (req, res) => {
    try {
      await db.healthcheck();
      res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
    } catch (err) {
      logger.error({ err }, 'healthcheck failed');
      res.status(503).json({ status: 'degraded' });
    }
  });

  const staticOptions = {
    maxAge: config.isProduction ? '7d' : 0,
    dotfiles: 'ignore',
    index: false,
    redirect: false,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  };
  app.use(express.static(path.join(__dirname, '..', 'public'), staticOptions));
  // Uploads live outside the source tree in production (UPLOAD_DIR).
  app.use(
    config.uploads.publicPath,
    express.static(config.uploads.dir, {
      ...staticOptions,
      maxAge: '30d',
      immutable: true,
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      },
    })
  );

  app.use(express.urlencoded({ extended: false, limit: '128kb' }));
  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser(config.session.secret));

  app.use(sessionMiddleware || createSessionMiddleware());
  app.use(loadUser());
  app.use(limits.global);
  app.use(flash());
  app.use(baseLocals());
  app.use(viewerContext());
  // The switches the control panel owns: announcement, sign-ups, read-only.
  app.use(siteMode());

  // Multipart endpoints run before the global CSRF middleware: multer has to
  // parse the body before the token in it can be checked, so these routes do
  // the check themselves once the form is parsed.
  app.use(uploadRoutes);

  // From here on, every state-changing request must carry a valid token, and
  // a multipart body is refused outright.
  app.use(csrf());

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      ['User-agent: *', 'Disallow: /settings', 'Disallow: /messages', 'Disallow: /admin',
        'Disallow: /search', 'Disallow: /api', '', `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n')
    );
  });

  app.use(routes);

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

module.exports = { createApp, createSessionMiddleware };
