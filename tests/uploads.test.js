'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const png = require('../seeds/png');

let app;

const PHOTO = png.gradient(64, 64, [30, 80, 140], [220, 220, 200]);
const AVATAR = png.avatar(96, [120, 60, 160], 3);

test.before(async () => {
  await helpers.prepare();
  app = helpers.createApp();
});
test.beforeEach(async () => helpers.truncate());
test.after(async () => helpers.close());

test('a profile photo can be uploaded through the ordinary multipart form', async () => {
  const agent = await helpers.signedUpAgent(app, 'photouser');

  const response = await agent
    .post('/settings/profile/avatar')
    .field('_csrf', agent.csrfToken)
    .attach('avatar', AVATAR, { filename: 'me.png', contentType: 'image/png' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/settings/profile');

  const profile = await agent.get('/api/users/photouser');
  assert.match(profile.body.user.avatarUrl, /^\/uploads\/avatar\//);
  assert.ok(!profile.body.user.avatarUrl.includes('default-avatar'));
  // The browser's filename is never used as the storage path.
  assert.ok(!profile.body.user.avatarUrl.includes('me.png'));
});

test('a header image can be uploaded and removed', async () => {
  const agent = await helpers.signedUpAgent(app, 'headeruser');

  const uploaded = await agent
    .post('/settings/profile/header')
    .field('_csrf', agent.csrfToken)
    .attach('header', PHOTO, { filename: 'banner.png', contentType: 'image/png' });
  assert.equal(uploaded.status, 302);

  let profile = await agent.get('/api/users/headeruser');
  assert.match(profile.body.user.headerUrl, /^\/uploads\/header\//);

  const removed = await agent.post('/settings/profile/header/delete')
    .type('form').send({ _csrf: agent.csrfToken });
  assert.equal(removed.status, 302);

  profile = await agent.get('/api/users/headeruser');
  assert.match(profile.body.user.headerUrl, /default-header/);
});

test('an upload without a CSRF token is refused', async () => {
  const agent = await helpers.signedUpAgent(app, 'notokenuser');
  const response = await agent
    .post('/settings/profile/avatar')
    .attach('avatar', AVATAR, { filename: 'me.png', contentType: 'image/png' });
  assert.equal(response.status, 403);

  const profile = await agent.get('/api/users/notokenuser');
  assert.match(profile.body.user.avatarUrl, /default-avatar/);
});

test('an upload with the wrong CSRF token is refused', async () => {
  const agent = await helpers.signedUpAgent(app, 'badtokenuser');
  const response = await agent
    .post('/settings/profile/avatar')
    .field('_csrf', 'not-the-right-token')
    .attach('avatar', AVATAR, { filename: 'me.png', contentType: 'image/png' });
  assert.equal(response.status, 403);
});

test('a signed-out visitor cannot upload', async () => {
  const request = require('supertest');
  const response = await request(app)
    .post('/settings/profile/avatar')
    .attach('avatar', AVATAR, { filename: 'me.png', contentType: 'image/png' });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^\/login/);
});

test('a multipart body aimed at a route that takes no files is refused', async () => {
  // multipart/form-data is one of the content types an attacker's cross-site
  // <form> can send, so a route that ignores its body must not accept one.
  const actor = await helpers.signedUpAgent(app, 'multipartactor');
  await helpers.signedUpAgent(app, 'multiparttarget');

  const response = await actor
    .post('/multiparttarget/follow')
    .field('_csrf', actor.csrfToken);
  assert.equal(response.status, 403);

  const target = await actor.get('/api/users/multiparttarget');
  assert.equal(target.body.user.counts.followers, 0);
});

test('a file whose bytes are not an image is rejected with a Twiq error page', async () => {
  const agent = await helpers.signedUpAgent(app, 'shelluser');
  const response = await agent
    .post('/settings/profile/avatar')
    .field('_csrf', agent.csrfToken)
    .attach('avatar', Buffer.from('#!/bin/sh\necho hello\n'), {
      filename: 'innocent.png',
      contentType: 'image/png',
    });

  assert.equal(response.status, 400);
  // A styled page, not Express's built-in one.
  assert.match(response.text, /class="error-shell"/);
  assert.match(response.text, /JPEG, PNG, GIF, WebP, MP4 and WebM/);
  assert.ok(!response.text.includes('<pre>Bad Request</pre>'));
});

test('an oversized file is refused', async () => {
  const config = require('../src/config/env');
  const agent = await helpers.signedUpAgent(app, 'bigfileuser');
  const huge = Buffer.alloc(config.uploads.maxSize + 1024, 0x41);
  const response = await agent
    .post('/settings/profile/avatar')
    .field('_csrf', agent.csrfToken)
    .attach('avatar', huge, { filename: 'huge.png', contentType: 'image/png' });
  assert.equal(response.status, 413);
});

test('composer media uploads and attaches to a Tweet', async () => {
  const agent = await helpers.signedUpAgent(app, 'mediauser');

  const uploaded = await agent
    .post('/media')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', agent.csrfToken)
    .attach('media', PHOTO, { filename: 'shot.png', contentType: 'image/png' });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.media.isVideo, false);

  const created = await agent.post('/api/tweets')
    .set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'A Tweet with a photo', media_ids: String(uploaded.body.media.id) });
  assert.equal(created.status, 201);
  assert.equal(created.body.tweet.media.length, 1);
  assert.equal(created.body.tweet.hasMedia, true);

  const profile = await agent.get('/mediauser');
  assert.match(profile.text, /tweet-media/);
});

test('media uploaded by one member cannot be attached by another', async () => {
  const owner = await helpers.signedUpAgent(app, 'mediaowner');
  const thief = await helpers.signedUpAgent(app, 'mediathief');

  const uploaded = await owner
    .post('/media')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', owner.csrfToken)
    .attach('media', PHOTO, { filename: 'shot.png', contentType: 'image/png' });

  const created = await thief.post('/api/tweets')
    .set('X-CSRF-Token', thief.csrfToken)
    .send({ body: 'Not my photo', media_ids: String(uploaded.body.media.id) });
  assert.equal(created.status, 201);
  assert.equal(created.body.tweet.media.length, 0);
  assert.equal(created.body.tweet.hasMedia, false);
});

test('a Direct Message can carry a photo, and still works without one', async () => {
  const sender = await helpers.signedUpAgent(app, 'dmsender');
  const recipient = await helpers.signedUpAgent(app, 'dmrecipient');
  await recipient.post('/api/users/dmsender/follow').set('X-CSRF-Token', recipient.csrfToken);

  const started = await sender.post('/messages/new')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: sender.csrfToken, username: 'dmrecipient' });
  const id = started.body.conversationId;

  const withPhoto = await sender
    .post(`/messages/${id}`)
    .field('_csrf', sender.csrfToken)
    .field('body', 'here is a photo')
    .attach('media', PHOTO, { filename: 'dm.png', contentType: 'image/png' });
  assert.equal(withPhoto.status, 302);

  const withoutPhoto = await sender.post(`/messages/${id}`)
    .type('form').send({ _csrf: sender.csrfToken, body: 'and one without' });
  assert.equal(withoutPhoto.status, 302);

  const thread = await recipient.get(`/messages/${id}`);
  assert.match(thread.text, /here is a photo/);
  assert.match(thread.text, /and one without/);
  assert.match(thread.text, /dm-media/);
});
