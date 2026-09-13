'use strict';

/**
 * Test harness.
 *
 * Tests run against a throwaway database derived from DATABASE_URL (or
 * TEST_DATABASE_URL). It is created if missing, migrated, and truncated
 * between test files - the development database is never touched.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret-0123456789';
process.env.SECURE_COOKIES = 'false';
process.env.TRUST_PROXY = 'false';
process.env.RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED || 'true';
// A small pool per test process: nine files running one after another do not
// need ten connections each, and the churn was producing occasional resets.
process.env.DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX || '4';

const http = require('http');
// Node 19 turned client keep-alive on by default, and a Node server drops an
// idle keep-alive socket after five seconds. Tests are sequential and gain
// nothing from keep-alive, so turn it off rather than write to a socket the
// server is already closing.
http.globalAgent = new http.Agent({ keepAlive: false });

installTransportRetry();

/**
 * supertest binds a throwaway loopback server for every request. On a busy
 * machine one of those connections is occasionally reset or times out before
 * the application ever sees it - a plain express app with no database and no
 * password hashing reproduces it at roughly one request in fifteen hundred,
 * which over a whole suite is a failure every few runs, in whichever test
 * happened to be running.
 *
 * That is the transport giving up, not the application misbehaving, so those
 * requests are replayed. Assertion failures carry different messages and are
 * never retried, so a real regression still fails on the first attempt.
 */
function installTransportRetry() {
  const supertest = require('supertest');
  const TRANSPORT = /ECONNRESET|socket hang up|ETIMEDOUT|EPIPE|ECONNREFUSED|ECONNABORTED/;
  const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options']);
  const ATTEMPTS = 3;

  async function run(build, steps) {
    let last;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      let test = build();
      for (const step of steps) test = test[step.name](...step.args);
      try {
        return await test;
      } catch (err) {
        if (!TRANSPORT.test(String((err && err.message) || ''))) throw err;
        last = err;
      }
    }
    throw last;
  }

  // A supertest request is built up by chaining, so the chain is recorded and
  // replayed from the start rather than resumed part way through.
  function chain(build, steps) {
    return new Proxy(function pending() {}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (onResolve, onReject) => run(build, steps).then(onResolve, onReject);
        }
        if (prop === 'catch') return (onReject) => run(build, steps).catch(onReject);
        if (prop === 'finally') return (onDone) => run(build, steps).finally(onDone);
        if (prop === 'end') {
          return (callback) => run(build, steps).then((res) => callback(null, res), callback);
        }
        return (...args) => chain(build, steps.concat([{ name: prop, args }]));
      },
    });
  }

  function wrapRequester(requester) {
    return new Proxy(requester, {
      get(target, prop, receiver) {
        if (VERBS.has(prop)) return (...args) => chain(() => target[prop](...args), []);
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  const wrapped = (app) => wrapRequester(supertest(app));
  wrapped.agent = (app, options) => wrapRequester(supertest.agent(app, options));
  Object.setPrototypeOf(wrapped, supertest);
  require.cache[require.resolve('supertest')].exports = wrapped;
}

const path = require('path');
const fs = require('fs');
const os = require('os');

// Pick up DATABASE_URL from .env the same way the application does, but only
// to derive the *test* database name from it.
require('dotenv').config();

function withTestDatabaseName(base) {
  const url = new URL(base);
  if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  return url;
}

/**
 * Candidate connection strings, in order of preference. `.env` normally holds
 * the compose value, whose host is the `postgres` service name - unreachable
 * from a test run on the host - so a localhost variant is offered as a
 * fallback. Set TEST_DATABASE_URL to skip all of this.
 */
function testDatabaseCandidates() {
  if (process.env.TEST_DATABASE_URL) return [process.env.TEST_DATABASE_URL];
  const base = process.env.DATABASE_URL || 'postgres://twiq:twiq_password@localhost:5432/twiq';
  const url = withTestDatabaseName(base);
  const candidates = [url.toString()];
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    const local = new URL(url.toString());
    local.hostname = '127.0.0.1';
    candidates.push(local.toString());
  }
  return candidates;
}

process.env.DATABASE_URL = testDatabaseCandidates()[0];
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'twiq-uploads-'));

const { Client } = require('pg');

let prepared = false;

async function createIfMissing(connectionString) {
  const url = new URL(connectionString);
  const dbName = url.pathname.slice(1);
  const admin = new URL(connectionString);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString(), connectionTimeoutMillis: 4000 });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
    }
  } finally {
    await client.end();
  }
}

/** Use the first candidate server that answers, and create its database. */
async function ensureDatabase() {
  const candidates = testDatabaseCandidates();
  let lastError;
  for (const candidate of candidates) {
    try {
      await createIfMissing(candidate);
      process.env.DATABASE_URL = candidate;
      return candidate;
    } catch (err) {
      lastError = err;
    }
  }
  const hosts = candidates.map((c) => new URL(c).host).join(', ');
  throw new Error(
    `Could not reach a PostgreSQL server for the tests (tried ${hosts}). ` +
    'Set TEST_DATABASE_URL to a reachable server. Original error: ' + lastError.message
  );
}

/** Create + migrate the test database once per process. */
async function prepare() {
  if (prepared) return;
  await ensureDatabase();
  const migrate = require('../src/db/migrate');
  await migrate.up();
  prepared = true;
}

const TABLES = [
  'status_incident_components', 'status_incident_updates', 'status_incidents',
  'status_components',
  'audit_logs', 'reports', 'list_members', 'lists', 'messages',
  'conversation_participants', 'conversations', 'notifications', 'mutes', 'blocks',
  'follow_requests', 'follows', 'pinned_tweets', 'favorites', 'retweets',
  'tweet_mentions', 'tweet_hashtags', 'hashtags', 'tweet_media', 'tweets',
  'media', 'profile_settings', 'user_settings', 'password_resets',
  'email_verifications', 'login_attempts', 'trends', 'users', 'sessions',
];

async function truncate() {
  const db = require('../src/config/db');
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

function createApp() {
  const { createApp: build } = require('../src/app');
  return build();
}

/** A supertest agent that keeps cookies, with the CSRF token pre-fetched. */
async function agentFor(app) {
  const request = require('supertest');
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  agent.csrfToken = match ? match[1] : '';
  return agent;
}

async function register(agent, { username, displayName, email, password = 'correct horse battery' }) {
  return agent.post('/register').type('form').send({
    _csrf: agent.csrfToken,
    username,
    display_name: displayName || username,
    email: email || `${username}@example.test`,
    password,
  });
}

/** Register + sign in, returning an agent whose CSRF token is current. */
async function signedUpAgent(app, username, overrides = {}) {
  const agent = await agentFor(app);
  const signup = await register(agent, { username, ...overrides });
  // Without this a rejected sign-up returns an anonymous agent, and the
  // failure surfaces much later as an unexplained 401 or a missing row.
  if (signup.status !== 302) {
    throw new Error(`could not sign up @${username}: ${signup.status} ${signup.text.slice(0, 200)}`);
  }
  const home = await agent.get('/home');
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (match) agent.csrfToken = match[1];
  agent.username = username;
  return agent;
}

async function login(app, username, password = 'correct horse battery') {
  const agent = await agentFor(app);
  await agent.post('/login').type('form').send({
    _csrf: agent.csrfToken,
    identifier: username,
    password,
  });
  const home = await agent.get('/home');
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (match) agent.csrfToken = match[1];
  agent.username = username;
  return agent;
}

async function close() {
  const db = require('../src/config/db');
  await db.close();
}

module.exports = {
  prepare,
  truncate,
  createApp,
  agentFor,
  register,
  signedUpAgent,
  login,
  close,
  TABLES,
};
