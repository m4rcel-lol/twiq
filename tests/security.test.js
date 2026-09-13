'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let app;

test.before(async () => {
  await helpers.prepare();
  app = helpers.createApp();
});
test.beforeEach(async () => helpers.truncate());
test.after(async () => helpers.close());

test('a state-changing request without a CSRF token is refused', async () => {
  const agent = await helpers.signedUpAgent(app, 'csrfuser');
  const response = await agent.post('/tweets').type('form').send({ body: 'no token here' });
  assert.equal(response.status, 403);
});

test('a state-changing request with the wrong CSRF token is refused', async () => {
  const agent = await helpers.signedUpAgent(app, 'csrfuser2');
  const response = await agent.post('/tweets').type('form')
    .send({ _csrf: 'definitely-not-the-token', body: 'nope' });
  assert.equal(response.status, 403);
});

test('signed-out visitors are redirected away from private pages', async () => {
  const request = require('supertest');
  for (const path of ['/home', '/connect', '/messages', '/settings/account', '/lists']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 302, `${path} should redirect`);
    assert.match(response.headers.location, /^\/login/);
  }
});

test('the admin panel is a 404 for ordinary members', async () => {
  const agent = await helpers.signedUpAgent(app, 'ordinary');
  const response = await agent.get('/admin');
  assert.equal(response.status, 404);
});

test('moderators reach the admin panel; admin-only actions still refuse them', async () => {
  const agent = await helpers.signedUpAgent(app, 'modperson');
  const victim = await helpers.signedUpAgent(app, 'victim');
  const db = require('../src/config/db');
  await db.query(`UPDATE users SET role = 'moderator' WHERE username = 'modperson'`);

  const dashboard = await agent.get('/admin');
  assert.equal(dashboard.status, 200);

  const page = await agent.get('/admin/users');
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const deleteAttempt = await agent.post('/admin/users/victim/delete').type('form').send({ _csrf: token });
  assert.equal(deleteAttempt.status, 403);
  assert.ok(victim);
});

test('Tweet text is escaped, never rendered as markup', async () => {
  const agent = await helpers.signedUpAgent(app, 'xssuser');
  await agent.post('/tweets').type('form').send({
    _csrf: agent.csrfToken,
    body: '<img src=x onerror=alert(1)> <script>alert(2)</script>',
  });
  const profile = await agent.get('/xssuser');
  assert.equal(profile.status, 200);
  assert.ok(!profile.text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!profile.text.includes('<script>alert(2)</script>'));
  assert.match(profile.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('display names and bios are escaped too', async () => {
  const agent = await helpers.signedUpAgent(app, 'xssprofile');
  await agent.post('/settings/profile').type('form').send({
    _csrf: agent.csrfToken,
    display_name: '<b>bold</b>',
    bio: '"><script>alert(1)</script>',
    location: '',
    website: '',
  });
  const profile = await agent.get('/xssprofile');
  assert.ok(!profile.text.includes('<b>bold</b>'));
  assert.ok(!profile.text.includes('<script>alert(1)</script>'));
});

test('a username cannot shadow a system route', async () => {
  const request = require('supertest');
  const response = await request(app).get('/discover');
  assert.equal(response.status, 200);
  assert.match(response.text, /Discover/);
});

test('security headers are present', async () => {
  const request = require('supertest');
  const response = await request(app).get('/login');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('the session cookie is HttpOnly and SameSite=Lax', async () => {
  const agent = await helpers.agentFor(app);
  const response = await helpers.register(agent, { username: 'cookieuser' });
  const cookies = response.headers['set-cookie'].join(';');
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /SameSite=Lax/i);
});

test('rate limiting refuses a flood of sign-in attempts', async () => {
  const request = require('supertest');
  const limits = require('../src/middleware/rateLimit');
  const express = require('express');

  // The shared limiters are switched off under NODE_ENV=test so the rest of
  // the suite can run; `force` builds a real one with the same wiring.
  const limited = express();
  limited.use(express.urlencoded({ extended: false }));
  limited.post('/login', limits.make('test-login', 3, 60000, { force: true }), (req, res) => res.status(200).end());
  limited.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));

  const agent = request.agent(limited);
  for (let i = 0; i < 3; i += 1) {
    const ok = await agent.post('/login').send({});
    assert.equal(ok.status, 200);
  }
  const blocked = await agent.post('/login').send({});
  assert.equal(blocked.status, 429);
});

test('uploads are rejected when the bytes do not match an allowed type', async () => {
  const storage = require('../src/services/storage');
  assert.throws(
    () => storage.validateUpload(Buffer.from('#!/bin/sh\necho hello\n'), 'image/png'),
    /JPEG, PNG, GIF, WebP, MP4 and WebM/
  );
  const png = require('../seeds/png');
  const real = png.gradient(8, 8, [0, 0, 0], [255, 255, 255]);
  const info = storage.validateUpload(real, 'image/png');
  assert.equal(info.mime, 'image/png');
  assert.equal(info.kind, 'photo');
});

test('a storage key cannot escape the upload directory', async () => {
  const storage = require('../src/services/storage');
  assert.throws(() => storage.driver.resolve('../../etc/passwd'), /Invalid storage key/);
});

test('the reduced Argon2id work factor is confined to the test environment', async () => {
  // This suite runs with a deliberately cheap hash. Nothing else may.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'services', 'password.js'), 'utf8'
  );
  assert.match(source, /config\.isTest/, 'the cheap parameters must be gated on NODE_ENV=test');
  assert.match(source, /memoryCost: 19456/, 'and the real ones must still be there');

  const { OPTIONS_FOR_TESTS } = require('../src/services/password');
  assert.equal(OPTIONS_FOR_TESTS.memoryCost, 1024, 'tests hash at the floor');

  // A hash made outside the test branch carries the production parameters.
  delete require.cache[require.resolve('../src/services/password')];
  delete require.cache[require.resolve('../src/config/env')];
  process.env.NODE_ENV = 'development';
  try {
    const real = require('../src/services/password');
    const digest = await real.hash('correct horse battery');
    assert.match(digest, /^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
  } finally {
    process.env.NODE_ENV = 'test';
    delete require.cache[require.resolve('../src/services/password')];
    delete require.cache[require.resolve('../src/config/env')];
    require('../src/services/password');
  }
});
