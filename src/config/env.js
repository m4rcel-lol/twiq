'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return fallback;
  }
  return v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

// TRUST_PROXY accepts `1`, `true`, `false` or an address/list understood by Express.
function trustProxyValue() {
  const raw = str('TRUST_PROXY', isProduction ? '1' : 'false');
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const n = Number.parseInt(raw, 10);
  if (!Number.isNaN(n) && String(n) === raw.trim()) return n;
  return raw;
}

// The database constraint in migrations/003_tweet_length.sql is the ceiling;
// going past it would turn an over-long Tweet into a 500 instead of a 400.
const TWEET_LENGTH_CEILING = 300;
const tweetMaxLength = int('TWEET_MAX_LENGTH', 300);

if (tweetMaxLength < 1 || tweetMaxLength > TWEET_LENGTH_CEILING) {
  throw new Error(
    `TWEET_MAX_LENGTH must be between 1 and ${TWEET_LENGTH_CEILING}. ` +
    'Raising it further also needs a migration widening the tweets_body_length check.'
  );
}

const config = {
  nodeEnv,
  isProduction,
  isTest,
  isDevelopment: nodeEnv === 'development',

  port: int('PORT', 40437),
  host: str('HOST', '0.0.0.0'),
  baseUrl: str('BASE_URL', 'http://localhost:40437').replace(/\/+$/, ''),
  trustProxy: trustProxyValue(),

  db: {
    connectionString: str('DATABASE_URL', 'postgres://twiq:twiq_password@localhost:5432/twiq'),
    ssl: bool('DATABASE_SSL', false) ? { rejectUnauthorized: false } : false,
    max: int('DATABASE_POOL_MAX', 10),
    idleTimeoutMillis: int('DATABASE_POOL_IDLE_TIMEOUT', 30000),
    connectionTimeoutMillis: int('DATABASE_CONNECTION_TIMEOUT', 10000),
  },

  session: {
    secret: str('SESSION_SECRET', isProduction ? undefined : 'twiq-development-session-secret'),
    name: str('SESSION_NAME', 'twiq.sid'),
    ttlHours: int('SESSION_TTL_HOURS', 24 * 30),
    secure: bool('SECURE_COOKIES', isProduction),
  },

  uploads: {
    dir: path.resolve(str('UPLOAD_DIR', path.join(__dirname, '..', '..', 'public', 'uploads'))),
    publicPath: str('UPLOAD_PUBLIC_PATH', '/uploads'),
    maxSize: int('MAX_UPLOAD_SIZE', 15 * 1024 * 1024),
    driver: str('STORAGE_DRIVER', 'local'),
  },

  logLevel: str('LOG_LEVEL', isTest ? 'silent' : 'info'),

  features: {
    websockets: bool('ENABLE_WEBSOCKETS', true),
    registration: bool('ENABLE_REGISTRATION', true),
  },

  rateLimit: {
    windowMs: int('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    global: int('RATE_LIMIT_GLOBAL_MAX', 1200),
    login: int('RATE_LIMIT_LOGIN_MAX', 10),
    register: int('RATE_LIMIT_REGISTER_MAX', 5),
    tweet: int('RATE_LIMIT_TWEET_MAX', 60),
    dm: int('RATE_LIMIT_DM_MAX', 120),
    upload: int('RATE_LIMIT_UPLOAD_MAX', 60),
    disabled: bool('RATE_LIMIT_DISABLED', isTest),
  },

  admin: {
    username: str('ADMIN_USERNAME', 'twiq'),
    email: str('ADMIN_EMAIL', 'admin@twiq.example.com'),
    password: str('ADMIN_PASSWORD', 'twiq-development-admin'),
  },

  brand: {
    name: 'Twiq',
    tagline: `Say it in ${tweetMaxLength}.`,
    tweetMaxLength,
    // The composer lets you type past the limit so the counter can go
    // negative and you can edit back down, rather than silently truncating.
    tweetHardLimit: tweetMaxLength * 2,
    bioMaxLength: 160,
    startYear: 2014,
  },
};

if (config.isProduction && config.session.secret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}

config.TWEET_LENGTH_CEILING = TWEET_LENGTH_CEILING;

module.exports = config;
