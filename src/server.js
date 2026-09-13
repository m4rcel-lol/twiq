#!/usr/bin/env node
'use strict';

const http = require('http');
const config = require('./config/env');
const logger = require('./config/logger');
const db = require('./config/db');
const { createApp, createSessionMiddleware } = require('./app');
const realtime = require('./services/realtime');
const trends = require('./services/trends');

async function main() {
  // Fail fast if the database is unreachable, so the container restarts
  // instead of serving 500s.
  await db.healthcheck();

  const sessionMiddleware = createSessionMiddleware();
  const app = createApp({ sessionMiddleware });
  const server = http.createServer(app);

  // Keep-alive above the typical 60s proxy idle timeout avoids races
  // where Caddy reuses a connection Node is closing.
  server.keepAliveTimeout = 72 * 1000;
  server.headersTimeout = 75 * 1000;
  server.requestTimeout = 120 * 1000;

  realtime.attach(server, sessionMiddleware);
  const trendTimer = trends.startScheduler();

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  logger.info(
    { port: config.port, host: config.host, env: config.nodeEnv, baseUrl: config.baseUrl },
    'twiq is listening'
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(trendTimer);

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, 15000);
    force.unref();

    try {
      await realtime.close();
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      logger.info('shutdown complete');
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception - exiting');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start twiq');
  process.exit(1);
});
