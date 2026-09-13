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

test('registration creates an account and signs the member in', async () => {
  const agent = await helpers.agentFor(app);
  const response = await helpers.register(agent, { username: 'ada', displayName: 'Ada L' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/home');

  const home = await agent.get('/home');
  assert.equal(home.status, 200);
  assert.match(home.text, /@ada/);
});

test('registration rejects reserved usernames', async () => {
  const agent = await helpers.agentFor(app);
  const response = await helpers.register(agent, { username: 'settings' });
  assert.equal(response.status, 400);
  assert.match(response.text, /reserved/i);
});

test('registration rejects duplicate usernames and emails', async () => {
  const first = await helpers.agentFor(app);
  await helpers.register(first, { username: 'grace', email: 'grace@example.test' });

  const second = await helpers.agentFor(app);
  const dupUsername = await helpers.register(second, { username: 'grace', email: 'other@example.test' });
  assert.equal(dupUsername.status, 409);
  assert.match(dupUsername.text, /already taken/i);

  const third = await helpers.agentFor(app);
  const dupEmail = await helpers.register(third, { username: 'grace2', email: 'grace@example.test' });
  assert.equal(dupEmail.status, 409);
  assert.match(dupEmail.text, /already registered/i);
});

test('registration rejects short passwords and bad usernames', async () => {
  const agent = await helpers.agentFor(app);
  const short = await helpers.register(agent, { username: 'tim', password: 'abc' });
  assert.equal(short.status, 400);

  const bad = await helpers.register(agent, { username: 'no spaces' });
  assert.equal(bad.status, 400);
});

test('login works with the username or the email, and rejects a wrong password', async () => {
  await helpers.signedUpAgent(app, 'linus', { email: 'linus@example.test' });

  const byUsername = await helpers.agentFor(app);
  const ok = await byUsername.post('/login').type('form')
    .send({ _csrf: byUsername.csrfToken, identifier: 'linus', password: 'correct horse battery' });
  assert.equal(ok.status, 302);

  const byEmail = await helpers.agentFor(app);
  const okEmail = await byEmail.post('/login').type('form')
    .send({ _csrf: byEmail.csrfToken, identifier: 'linus@example.test', password: 'correct horse battery' });
  assert.equal(okEmail.status, 302);

  const wrong = await helpers.agentFor(app);
  const bad = await wrong.post('/login').type('form')
    .send({ _csrf: wrong.csrfToken, identifier: 'linus', password: 'not the password' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /incorrect/i);
});

test('a failed login does not reveal whether the account exists', async () => {
  await helpers.signedUpAgent(app, 'realuser');

  const a = await helpers.agentFor(app);
  const existing = await a.post('/login').type('form')
    .send({ _csrf: a.csrfToken, identifier: 'realuser', password: 'wrong' });

  const b = await helpers.agentFor(app);
  const missing = await b.post('/login').type('form')
    .send({ _csrf: b.csrfToken, identifier: 'ghostuser', password: 'wrong' });

  assert.equal(existing.status, missing.status);
  // Per-session tokens differ; everything else must be byte-identical.
  const strip = (html) => html.replace(/value="[^"]*"/g, '').replace(/data-csrf="[^"]*"/g, '');
  assert.equal(strip(existing.text), strip(missing.text));
});

test('logout ends the session', async () => {
  const agent = await helpers.signedUpAgent(app, 'logoutuser');
  const out = await agent.post('/logout').type('form').send({ _csrf: agent.csrfToken });
  assert.equal(out.status, 302);
  const home = await agent.get('/home');
  assert.equal(home.status, 302);
  assert.match(home.headers.location, /^\/login/);
});

test('password reset issues a single-use token that changes the password', async () => {
  await helpers.signedUpAgent(app, 'resetme', { email: 'resetme@example.test' });
  const mailer = require('../src/services/mailer');

  const agent = await helpers.agentFor(app);
  const requested = await agent.post('/forgot-password').type('form')
    .send({ _csrf: agent.csrfToken, identifier: 'resetme' });
  assert.equal(requested.status, 200);

  const mail = mailer.sent[mailer.sent.length - 1];
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)[1];

  const done = await agent.post('/reset-password').type('form').send({
    _csrf: agent.csrfToken,
    token,
    password: 'a whole new password',
    password_confirm: 'a whole new password',
  });
  assert.equal(done.status, 302);

  const signedIn = await helpers.login(app, 'resetme', 'a whole new password');
  const home = await signedIn.get('/home');
  assert.equal(home.status, 200);

  // The same token cannot be replayed.
  const replay = await helpers.agentFor(app);
  const again = await replay.post('/reset-password').type('form').send({
    _csrf: replay.csrfToken,
    token,
    password: 'another password entirely',
    password_confirm: 'another password entirely',
  });
  assert.equal(again.status, 400);
});

test('changing the password requires the current one', async () => {
  const agent = await helpers.signedUpAgent(app, 'changer');
  const wrong = await agent.post('/settings/password').type('form').send({
    _csrf: agent.csrfToken,
    current_password: 'nope',
    new_password: 'a brand new password',
    new_password_confirm: 'a brand new password',
  });
  assert.equal(wrong.status, 302);
  const page = await agent.get('/settings/password');
  assert.match(page.text, /not correct/i);
});
