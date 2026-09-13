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

test('the instance page is public and says who runs the place', async () => {
  const request = require('supertest');
  const brand = await helpers.signedUpAgent(app, 'thebrand', { displayName: 'The Brand' });
  const mod = await helpers.signedUpAgent(app, 'themod');
  const db = require('../src/config/db');
  await db.query("UPDATE users SET is_official = true, role = 'admin' WHERE username = 'thebrand'");
  await db.query("UPDATE users SET role = 'moderator' WHERE username = 'themod'");
  await brand.post('/api/tweets').set('X-CSRF-Token', brand.csrfToken).send({ body: 'hello' });

  // Signed out: someone deciding whether to join can read it first.
  const page = await request(app).get('/instance');
  assert.equal(page.status, 200);
  assert.match(page.text, /@thebrand/);
  assert.match(page.text, /class="official-badge/, 'the operator wears its mark');
  assert.match(page.text, /@themod/);
  assert.match(page.text, /moderator/);
});

test('no moderation internals or e-mail addresses leak onto it', async () => {
  const request = require('supertest');
  const staff = await helpers.signedUpAgent(app, 'staffer');
  const bad = await helpers.signedUpAgent(app, 'troublemaker');
  const db = require('../src/config/db');
  await db.query("UPDATE users SET role = 'admin' WHERE username = 'staffer'");

  // A suspension and an open report - both of which the control panel shows.
  await staff.post('/troublemaker/report').type('form')
    .send({ _csrf: staff.csrfToken, reason: 'spam', detail: 'a private detail' });
  await db.query("UPDATE users SET is_suspended = true WHERE username = 'troublemaker'");

  const page = await request(app).get('/instance');
  assert.ok(!/staffer@example\.test/.test(page.text), 'no e-mail addresses');
  assert.ok(!/suspend/i.test(page.text), 'no suspension figures');
  assert.ok(!/report/i.test(page.text) || !/open report/i.test(page.text), 'no open-report count');
  assert.ok(!page.text.includes('a private detail'));

  // A suspended account is not counted as one of the instance's people.
  assert.match(page.text, /<b>1<\/b><span>accounts<\/span>/);
});

test('it reports the setup a member would actually notice', async () => {
  const request = require('supertest');
  const page = await request(app).get('/instance');
  assert.match(page.text, /300 characters/);
  assert.match(page.text, /Reverse chronological/);
  assert.match(page.text, /Anyone can join|not accepting new accounts/);
  assert.match(page.text, /MB each/);
  assert.match(page.text, /href="\/status"/);
});

test('it states plainly that this is not the service it resembles', async () => {
  const request = require('supertest');
  const page = await request(app).get('/instance');
  // The template wraps, so the rendered text carries newlines mid-sentence.
  const flat = page.text.replace(/\s+/g, ' ');
  assert.match(flat, /not affiliated with, endorsed by, or connected to Twitter/);
  assert.match(flat, /carries none of their code, data or branding/);
  assert.match(page.text, /href="https:\/\/github\.com\/m4rcel-lol\/twiq"/);
});

test('closed sign-ups are reported as closed', async () => {
  const request = require('supertest');
  const settings = require('../src/services/settings');
  await settings.set('registration_open', false);
  try {
    const page = await request(app).get('/instance');
    assert.match(page.text, /not accepting new accounts/);
    assert.ok(!/Anyone can join/.test(page.text));
  } finally {
    await settings.set('registration_open', true);
  }
});

test('the footer links to it from everywhere', async () => {
  const request = require('supertest');
  for (const path of ['/', '/about', '/instance', '/login']) {
    const page = await request(app).get(path);
    assert.match(page.text, /<a href="\/instance">Instance<\/a>/, `${path} should link to it`);
  }
});
