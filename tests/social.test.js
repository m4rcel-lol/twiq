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

test('following and unfollowing update both counters', async () => {
  const a = await helpers.signedUpAgent(app, 'follower');
  await helpers.signedUpAgent(app, 'followee');

  const follow = await a.post('/api/users/followee/follow').set('X-CSRF-Token', a.csrfToken);
  assert.equal(follow.status, 200);
  assert.equal(follow.body.state, 'following');

  const profile = await a.get('/api/users/followee');
  assert.equal(profile.body.user.counts.followers, 1);
  const self = await a.get('/api/users/follower');
  assert.equal(self.body.user.counts.following, 1);

  await a.post('/api/users/followee/unfollow').set('X-CSRF-Token', a.csrfToken);
  const after = await a.get('/api/users/followee');
  assert.equal(after.body.user.counts.followers, 0);
});

test('you cannot follow yourself', async () => {
  const a = await helpers.signedUpAgent(app, 'narcissus');
  const response = await a.post('/api/users/narcissus/follow').set('X-CSRF-Token', a.csrfToken);
  assert.equal(response.status, 400);
});

test('a protected account turns a follow into a request that must be approved', async () => {
  const owner = await helpers.signedUpAgent(app, 'guarded');
  await owner.post('/settings/privacy').type('form').send({
    _csrf: owner.csrfToken,
    is_protected: 'on',
    dm_policy: 'followers',
  });
  await owner.post('/api/tweets').set('X-CSRF-Token', owner.csrfToken).send({ body: 'secret Tweet' });

  const stranger = await helpers.signedUpAgent(app, 'outsider');
  const hidden = await stranger.get('/guarded');
  assert.equal(hidden.status, 200);
  assert.match(hidden.text, /These Tweets are protected/);
  assert.ok(!hidden.text.includes('secret Tweet'));

  const requested = await stranger.post('/api/users/guarded/follow').set('X-CSRF-Token', stranger.csrfToken);
  assert.equal(requested.body.state, 'requested');

  const stillHidden = await stranger.get('/api/users/guarded/tweets');
  assert.equal(stillHidden.status, 403);

  const requests = await owner.get('/settings/requests');
  assert.match(requests.text, /@outsider/);
  await owner.post('/outsider/approve').type('form').send({ _csrf: owner.csrfToken });

  const visible = await stranger.get('/api/users/guarded/tweets');
  assert.equal(visible.status, 200);
  assert.equal(visible.body.tweets[0].body, 'secret Tweet');
});

test('blocking severs the relationship and hides interaction', async () => {
  const blocker = await helpers.signedUpAgent(app, 'blocker');
  const blocked = await helpers.signedUpAgent(app, 'blocked');

  await blocked.post('/api/users/blocker/follow').set('X-CSRF-Token', blocked.csrfToken);
  let profile = await blocked.get('/api/users/blocker');
  assert.equal(profile.body.user.counts.followers, 1);

  await blocker.post('/blocked/block').type('form').send({ _csrf: blocker.csrfToken });

  profile = await blocked.get('/api/users/blocker');
  assert.equal(profile.body.user.counts.followers, 0);

  const refollow = await blocked.post('/api/users/blocker/follow').set('X-CSRF-Token', blocked.csrfToken);
  assert.equal(refollow.status, 403);

  const blockedList = await blocker.get('/settings/blocked');
  assert.match(blockedList.text, /@blocked/);
});

test('a muted account disappears from the timeline but stays followed', async () => {
  const listener = await helpers.signedUpAgent(app, 'listener');
  const noisy = await helpers.signedUpAgent(app, 'noisy');

  await listener.post('/api/users/noisy/follow').set('X-CSRF-Token', listener.csrfToken);
  await noisy.post('/api/tweets').set('X-CSRF-Token', noisy.csrfToken).send({ body: 'very loud Tweet' });

  let timeline = await listener.get('/api/timeline/home');
  assert.equal(timeline.body.tweets.length, 1);

  await listener.post('/noisy/mute').type('form').send({ _csrf: listener.csrfToken });
  timeline = await listener.get('/api/timeline/home');
  assert.equal(timeline.body.tweets.length, 0);

  const following = await listener.get('/api/users/noisy');
  assert.equal(following.body.user.counts.followers, 1);

  await listener.post('/noisy/unmute').type('form').send({ _csrf: listener.csrfToken });
  timeline = await listener.get('/api/timeline/home');
  assert.equal(timeline.body.tweets.length, 1);
});

test('Direct Messages need a mutual follow by default', async () => {
  const sender = await helpers.signedUpAgent(app, 'sender');
  const recipient = await helpers.signedUpAgent(app, 'recipient');

  const refused = await sender.post('/messages/new')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: sender.csrfToken, username: 'recipient' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error.message, /follow you/i);

  await recipient.post('/api/users/sender/follow').set('X-CSRF-Token', recipient.csrfToken);

  const allowed = await sender.post('/messages/new')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: sender.csrfToken, username: 'recipient' });
  assert.equal(allowed.status, 200);

  const conversationId = allowed.body.conversationId;
  const sent = await sender.post(`/messages/${conversationId}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: sender.csrfToken, body: 'hello there' });
  assert.equal(sent.status, 201);

  const inbox = await recipient.get('/messages');
  assert.match(inbox.text, /hello there/);

  // A third party cannot read the conversation.
  const nosy = await helpers.signedUpAgent(app, 'nosy');
  const denied = await nosy.get(`/messages/${conversationId}`);
  assert.equal(denied.status, 403);
});

test('Lists can be created, filled and read, and private Lists stay private', async () => {
  const owner = await helpers.signedUpAgent(app, 'curator');
  const member = await helpers.signedUpAgent(app, 'listed');
  await member.post('/api/tweets').set('X-CSRF-Token', member.csrfToken).send({ body: 'a Tweet for the List' });

  await owner.post('/lists').type('form').send({
    _csrf: owner.csrfToken, name: 'Good people', description: 'A test List',
  });
  const lists = await owner.get('/lists');
  assert.match(lists.text, /Good people/);
  const listId = /\/lists\/(\d+)/.exec(lists.text)[1];

  await owner.post(`/lists/${listId}/members`).type('form')
    .send({ _csrf: owner.csrfToken, username: 'listed' });

  const timeline = await owner.get(`/lists/${listId}`);
  assert.match(timeline.text, /a Tweet for the List/);

  await owner.post(`/lists/${listId}/update`).type('form').send({
    _csrf: owner.csrfToken, name: 'Good people', description: 'A test List', is_private: 'on',
  });
  const stranger = await helpers.signedUpAgent(app, 'peeker');
  const denied = await stranger.get(`/lists/${listId}`);
  assert.equal(denied.status, 403);
});

test('reports are stored and visible to moderators', async () => {
  const reporter = await helpers.signedUpAgent(app, 'reporter');
  const target = await helpers.signedUpAgent(app, 'target');
  const created = await target.post('/api/tweets').set('X-CSRF-Token', target.csrfToken)
    .send({ body: 'something objectionable' });

  const filed = await reporter.post('/reports').type('form').send({
    _csrf: reporter.csrfToken,
    category: 'spam',
    details: 'this is spam',
    tweet_id: String(created.body.tweet.id),
  });
  assert.equal(filed.status, 302);

  const db = require('../src/config/db');
  await db.query(`UPDATE users SET role = 'admin' WHERE username = 'reporter'`);
  const reports = await reporter.get('/admin/reports');
  assert.match(reports.text, /spam/);
  assert.match(reports.text, /this is spam/);
});

test('an admin can suspend an account, which signs it out', async () => {
  const admin = await helpers.signedUpAgent(app, 'theadmin');
  const member = await helpers.signedUpAgent(app, 'troublemaker');
  const db = require('../src/config/db');
  await db.query(`UPDATE users SET role = 'admin' WHERE username = 'theadmin'`);

  const page = await admin.get('/admin/users');
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const suspended = await admin.post('/admin/users/troublemaker/suspend').type('form')
    .send({ _csrf: token, reason: 'testing' });
  assert.equal(suspended.status, 302);

  const home = await member.get('/home');
  assert.equal(home.status, 302);

  const audit = await admin.get('/admin/audit');
  assert.match(audit.text, /admin.user.suspend/);
});

test('search finds Tweets, hashtags and people', async () => {
  const agent = await helpers.signedUpAgent(app, 'searcher');
  await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'a distinctive phrase about #sourdough' });

  const byText = await agent.get('/api/search?q=distinctive');
  assert.equal(byText.body.tweets.length, 1);

  const byTag = await agent.get('/api/search?q=%23sourdough');
  assert.equal(byTag.body.tweets.length, 1);

  const byPerson = await agent.get('/api/search?q=searcher');
  assert.equal(byPerson.body.users[0].username, 'searcher');
});

test('trends score hashtags by distinct people, not raw volume', async () => {
  const one = await helpers.signedUpAgent(app, 'trenda');
  const two = await helpers.signedUpAgent(app, 'trendb');
  const three = await helpers.signedUpAgent(app, 'trendc');

  // #shared is used once by three people; #shouty four times by one person.
  for (const agent of [one, two, three]) {
    await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken).send({ body: 'look #shared' });
  }
  for (let i = 0; i < 4; i += 1) {
    await one.post('/api/tweets').set('X-CSRF-Token', one.csrfToken).send({ body: `me again ${i} #shouty` });
  }

  const trends = require('../src/services/trends');
  const rows = await trends.computeGlobal(10);
  const shared = rows.find((r) => r.tag === 'shared');
  const shouty = rows.find((r) => r.tag === 'shouty');
  assert.ok(Number(shared.score) > Number(shouty.score), 'distinct users should outweigh repetition');
});
