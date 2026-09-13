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

const say = async (agent, body) => {
  const res = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken).send({ body });
  assert.equal(res.status, 201, body);
  return res.body.tweet.id;
};

test('the new-Tweet count reports accounts, not Tweets', async () => {
  const reader = await helpers.signedUpAgent(app, 'barreader');
  const chatty = await helpers.signedUpAgent(app, 'barchatty');
  const quiet = await helpers.signedUpAgent(app, 'barquiet');
  for (const who of ['barchatty', 'barquiet']) {
    await reader.post(`/api/users/${who}/follow`).set('X-CSRF-Token', reader.csrfToken);
  }

  const first = await say(chatty, 'one');
  // Everything after `first` is what the bar would announce.
  await say(chatty, 'two');
  await say(chatty, 'three');
  await say(quiet, 'just the once');

  const res = await reader.get(`/home/new-count?since_id=${first}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3, 'three Tweets were posted');
  assert.equal(res.body.accounts, 2, 'but by two people, which is what the bar says');
});

test('a muted account does not set the bar off', async () => {
  const reader = await helpers.signedUpAgent(app, 'mutereader');
  const noisy = await helpers.signedUpAgent(app, 'mutenoisy');
  await reader.post('/api/users/mutenoisy/follow').set('X-CSRF-Token', reader.csrfToken);

  const marker = await say(reader, 'my own, as a marker');
  await say(noisy, 'before the mute');
  let res = await reader.get(`/home/new-count?since_id=${marker}`);
  assert.equal(res.body.accounts, 1);

  await reader.post('/mutenoisy/mute').type('form').send({ _csrf: reader.csrfToken });
  await say(noisy, 'after the mute');
  res = await reader.get(`/home/new-count?since_id=${marker}`);
  assert.equal(res.body.accounts, 0, 'the bar must not announce what the timeline hides');
});

test('your own Tweets never announce themselves', async () => {
  const agent = await helpers.signedUpAgent(app, 'selfposter');
  const first = await say(agent, 'first');
  await say(agent, 'second');
  const res = await agent.get(`/home/new-count?since_id=${first}`);
  assert.equal(res.body.accounts, 0);
  assert.equal(res.body.count, 0);
});

test('the timeline fan-out only considers people who are listening', async () => {
  const tweetModel = require('../src/models/tweet');
  const author = await helpers.signedUpAgent(app, 'fanauthor');
  const follower = await helpers.signedUpAgent(app, 'fanfollower');
  const stranger = await helpers.signedUpAgent(app, 'fanstranger');
  await follower.post('/api/users/fanauthor/follow').set('X-CSRF-Token', follower.csrfToken);

  const db = require('../src/config/db');
  const ids = {};
  for (const name of ['fanauthor', 'fanfollower', 'fanstranger']) {
    ids[name] = (await db.one('SELECT id FROM users WHERE username = $1', [name])).id;
  }

  // Nobody connected: no work to do at all.
  assert.deepEqual(await tweetModel.followersAmong(ids.fanauthor, []), []);

  // Only the follower is picked out of the connected set.
  const listening = [ids.fanfollower, ids.fanstranger];
  assert.deepEqual(await tweetModel.followersAmong(ids.fanauthor, listening), [Number(ids.fanfollower)]);

  // And a block removes them again.
  await stranger.post('/api/users/fanauthor/follow').set('X-CSRF-Token', stranger.csrfToken);
  await author.post('/fanstranger/block').type('form').send({ _csrf: author.csrfToken });
  const after = await tweetModel.followersAmong(ids.fanauthor, listening);
  assert.ok(!after.includes(Number(ids.fanstranger)), 'a blocked follower is not nudged');
});

test('a reply, a quote and a mention all raise a nudgeable notification', async () => {
  const tweetModel = require('../src/models/tweet');
  const author = await helpers.signedUpAgent(app, 'nudgeauthor');
  const other = await helpers.signedUpAgent(app, 'nudgeother');
  const root = await say(author, 'the opening post');

  const reply = await other.post('/api/tweets').set('X-CSRF-Token', other.csrfToken)
    .send({ body: '@nudgeauthor replying', in_reply_to: String(root) });
  const quote = await other.post('/api/tweets').set('X-CSRF-Token', other.csrfToken)
    .send({ body: 'quoting you', quote_of: String(root) });

  const db = require('../src/config/db');
  const authorId = Number((await db.one("SELECT id FROM users WHERE username = 'nudgeauthor'")).id);
  assert.deepEqual(await tweetModel.notifiedBy(reply.body.tweet.id), [authorId]);
  assert.deepEqual(await tweetModel.notifiedBy(quote.body.tweet.id), [authorId]);
});
