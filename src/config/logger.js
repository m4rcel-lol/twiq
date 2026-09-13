'use strict';

const pino = require('pino');
const config = require('./env');

const redact = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'res.headers["set-cookie"]',
    'password',
    'passwordConfirm',
    'current_password',
    'body.password',
    'body.password_confirm',
    'body.current_password',
    'body.new_password',
    'body.body', // direct message contents are never logged
    'token',
    'session_secret',
  ],
  censor: '[redacted]',
};

const logger = pino({
  level: config.logLevel,
  redact,
  base: { service: 'twiq', env: config.nodeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    config.isDevelopment && process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

module.exports = logger;
