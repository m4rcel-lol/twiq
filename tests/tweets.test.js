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

async function tweet(agent, body, extra = {}) {
  return agent.post('/tweets').type('form').send({ _csrf: agent.csrfToken, body, ...extra });
}

test('a member can post a Tweet and see it on their profile', async () => {
  const agent = await helpers.signedUpAgent(app, 'poster');
  const response = await tweet(agent, 'Hello from the tests. #twiq');
  assert.equal(response.status, 302);

  const profile = await agent.get('/poster');
  assert.match(profile.text, /Hello from the tests/);
  assert.match(profile.text, /search\?q=%23twiq/);
});

test('a Tweet may run to the configured limit and not one character further', async () => {
  const config = require('../src/config/env');
  const limit = config.brand.tweetMaxLength;
  const agent = await helpers.signedUpAgent(app, 'longwinded');

  const ok = await tweet(agent, 'x'.repeat(limit));
  assert.equal(ok.status, 302);

  const tooLong = await agent.post('/api/tweets')
    .set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'x'.repeat(limit + 1) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error.message, new RegExp(`${limit} characters`));
});

test('the database ceiling is at least the limit the application enforces', async () => {
  // If these drift apart, an over-long Tweet stops being a 400 and becomes a
  // 500 from the database. The app refuses to boot above the ceiling, and
  // this checks the ceiling is really there.
  const db = require('../src/config/db');
  const config = require('../src/config/env');
  const user = await helpers.signedUpAgent(app, 'ceilinguser');
  assert.ok(user);
  const row = await db.one(`SELECT id FROM users WHERE username = 'ceilinguser'`);

  const atCeiling = await db.one(
    'INSERT INTO tweets (user_id, body) VALUES ($1, $2) RETURNING id',
    [row.id, 'y'.repeat(config.TWEET_LENGTH_CEILING)]
  );
  assert.ok(atCeiling.id);

  await assert.rejects(
    db.query('INSERT INTO tweets (user_id, body) VALUES ($1, $2)', [
      row.id,
      'y'.repeat(config.TWEET_LENGTH_CEILING + 1),
    ]),
    (err) => err.code === '23514'
  );

  assert.ok(config.brand.tweetMaxLength <= config.TWEET_LENGTH_CEILING);
});

test('an empty Tweet is refused', async () => {
  const agent = await helpers.signedUpAgent(app, 'emptyposter');
  const response = await agent.post('/api/tweets')
    .set('X-CSRF-Token', agent.csrfToken)
    .send({ body: '   ' });
  assert.equal(response.status, 400);
});

test('favorite and unfavorite move the counter in both directions', async () => {
  const author = await helpers.signedUpAgent(app, 'author');
  const created = await author.post('/api/tweets')
    .set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Favorite this' });
  const id = created.body.tweet.id;

  const reader = await helpers.signedUpAgent(app, 'reader');
  const fav = await reader.post(`/api/tweets/${id}/favorite`).set('X-CSRF-Token', reader.csrfToken);
  assert.equal(fav.status, 200);
  assert.equal(fav.body.favorited, true);
  assert.equal(fav.body.count, 1);

  // Favoriting twice is idempotent.
  const again = await reader.post(`/api/tweets/${id}/favorite`).set('X-CSRF-Token', reader.csrfToken);
  assert.equal(again.body.count, 1);

  const unfav = await reader.post(`/api/tweets/${id}/unfavorite`).set('X-CSRF-Token', reader.csrfToken);
  assert.equal(unfav.body.favorited, false);
  assert.equal(unfav.body.count, 0);
});

test('a retweet is stored separately and shows the original author', async () => {
  const author = await helpers.signedUpAgent(app, 'original');
  const created = await author.post('/api/tweets')
    .set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Retweet me' });
  const id = created.body.tweet.id;

  const sharer = await helpers.signedUpAgent(app, 'sharer');
  const rt = await sharer.post(`/api/tweets/${id}/retweet`).set('X-CSRF-Token', sharer.csrfToken);
  assert.equal(rt.body.retweeted, true);
  assert.equal(rt.body.count, 1);

  const profile = await sharer.get('/sharer');
  assert.match(profile.text, /Retweet me/);
  assert.match(profile.text, /retweeted/);
  assert.match(profile.text, /@original/);

  const undo = await sharer.post(`/api/tweets/${id}/unretweet`).set('X-CSRF-Token', sharer.csrfToken);
  assert.equal(undo.body.retweeted, false);
  assert.equal(undo.body.count, 0);
});

test('replies are threaded and counted on the parent', async () => {
  const author = await helpers.signedUpAgent(app, 'parentuser');
  const created = await author.post('/api/tweets')
    .set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Start of a thread' });
  const id = created.body.tweet.id;

  const replier = await helpers.signedUpAgent(app, 'replier');
  const reply = await replier.post('/api/tweets')
    .set('X-CSRF-Token', replier.csrfToken)
    .send({ body: '@parentuser here is my reply', in_reply_to: String(id) });
  assert.equal(reply.status, 201);

  const permalink = await author.get(`/parentuser/status/${id}`);
  assert.match(permalink.text, /here is my reply/);
  assert.match(permalink.text, /Replies/);
});

test('only the author can delete a Tweet', async () => {
  const author = await helpers.signedUpAgent(app, 'owner');
  const created = await author.post('/api/tweets')
    .set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Mine to delete' });
  const id = created.body.tweet.id;

  const stranger = await helpers.signedUpAgent(app, 'stranger');
  const refused = await stranger.post(`/api/tweets/${id}/delete`).set('X-CSRF-Token', stranger.csrfToken);
  assert.equal(refused.status, 403);

  const deleted = await author.post(`/api/tweets/${id}/delete`).set('X-CSRF-Token', author.csrfToken);
  assert.equal(deleted.status, 200);

  const gone = await author.get(`/owner/status/${id}`);
  assert.equal(gone.status, 404);
});

test('pinning is restricted to your own Tweets and surfaces on the profile', async () => {
  const author = await helpers.signedUpAgent(app, 'pinner');
  const created = await author.post('/api/tweets')
    .set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Pin this one' });
  const id = created.body.tweet.id;

  const other = await helpers.signedUpAgent(app, 'notpinner');
  const refused = await other.post(`/tweets/${id}/pin`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: other.csrfToken });
  assert.equal(refused.status, 403);

  await author.post(`/tweets/${id}/pin`).type('form').send({ _csrf: author.csrfToken });
  const profile = await author.get('/pinner');
  assert.match(profile.text, /Pinned Tweet/);
});

test('a Tweet body keeps its hashtags, mentions and links as entities', async () => {
  const mentioned = await helpers.signedUpAgent(app, 'mentioned');
  const agent = await helpers.signedUpAgent(app, 'entityuser');
  await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'hi @mentioned about #twiq see http://example.com/x' });

  const profile = await agent.get('/entityuser');
  assert.match(profile.text, /href="\/mentioned"/);
  assert.match(profile.text, /search\?q=%23twiq/);
  assert.match(profile.text, /href="http:\/\/example\.com\/x"/);

  const connect = await mentioned.get('/connect');
  assert.match(connect.text, /mentioned you/);
});

test('the home timeline is reverse chronological and follows the people you follow', async () => {
  const alice = await helpers.signedUpAgent(app, 'atimeline');
  const bob = await helpers.signedUpAgent(app, 'btimeline');
  const carol = await helpers.signedUpAgent(app, 'ctimeline');

  await bob.post('/api/tweets').set('X-CSRF-Token', bob.csrfToken).send({ body: 'from bob' });
  await carol.post('/api/tweets').set('X-CSRF-Token', carol.csrfToken).send({ body: 'from carol' });

  await alice.post('/api/users/btimeline/follow').set('X-CSRF-Token', alice.csrfToken);
  await bob.post('/api/tweets').set('X-CSRF-Token', bob.csrfToken).send({ body: 'second from bob' });

  const timeline = await alice.get('/api/timeline/home');
  const bodies = timeline.body.tweets.map((t) => t.body);
  assert.deepEqual(bodies, ['second from bob', 'from bob']);
  assert.ok(!bodies.includes('from carol'));
});

test('the timeline paginates with a cursor', async () => {
  const agent = await helpers.signedUpAgent(app, 'paginator');
  for (let i = 0; i < 5; i += 1) {
    await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken).send({ body: `tweet ${i}` });
  }
  const first = await agent.get('/api/timeline/home?count=2');
  assert.equal(first.body.tweets.length, 2);
  assert.ok(first.body.next_cursor);

  const second = await agent.get(`/api/timeline/home?count=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.equal(second.body.tweets.length, 2);
  const overlap = first.body.tweets.filter((t) => second.body.tweets.some((s) => s.id === t.id));
  assert.equal(overlap.length, 0);
});

test('a reply to a reply is nested under the one it answers', async () => {
  const root = await helpers.signedUpAgent(app, 'threadroot');
  const alice = await helpers.signedUpAgent(app, 'threadalice');
  const bob = await helpers.signedUpAgent(app, 'threadbob');

  const say = async (agent, body, parent) => {
    const res = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
      .send(parent ? { body, in_reply_to: String(parent) } : { body });
    assert.equal(res.status, 201, body);
    return res.body.tweet.id;
  };

  const top = await say(root, 'The opening post');
  const first = await say(alice, '@threadroot a direct reply', top);
  const deep = await say(bob, '@threadalice answering the reply', first);
  const deeper = await say(alice, '@threadbob answering that', deep);
  const sibling = await say(bob, '@threadroot a second direct reply', top);

  const page = await root.get(`/threadroot/status/${top}`);
  assert.equal(page.status, 200);

  const depthOf = (id) => {
    const at = page.text.indexOf(`data-tweet-id="${id}"`);
    assert.ok(at > -1, `${id} should be on the page`);
    const wrapper = page.text.lastIndexOf('reply-depth-', at);
    return Number(page.text.slice(wrapper + 'reply-depth-'.length, wrapper + 'reply-depth-'.length + 1));
  };

  assert.equal(depthOf(first), 0, 'a direct reply sits at the left edge');
  assert.equal(depthOf(deep), 1, 'a reply to that is stepped in once');
  assert.equal(depthOf(deeper), 2, 'and again');
  assert.equal(depthOf(sibling), 0, 'a second direct reply returns to the edge');

  // Depth-first: a branch is finished before its sibling starts, so the
  // conversation reads top to bottom the way it happened.
  const order = [first, deep, deeper, sibling].map((id) => page.text.indexOf(`data-tweet-id="${id}"`));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'replies read in thread order');
});

test('opening a reply shows its own branch, not the whole conversation', async () => {
  const root = await helpers.signedUpAgent(app, 'branchroot');
  const other = await helpers.signedUpAgent(app, 'branchother');
  const say = async (agent, body, parent) => {
    const res = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
      .send(parent ? { body, in_reply_to: String(parent) } : { body });
    return res.body.tweet.id;
  };

  const top = await say(root, 'Opening post');
  const left = await say(other, '@branchroot left branch', top);
  const leftChild = await say(root, '@branchother under the left branch', left);
  const right = await say(other, '@branchroot right branch', top);

  const page = await root.get(`/branchother/status/${left}`);
  assert.match(page.text, new RegExp(`data-tweet-id="${leftChild}"`), 'its own reply shows');
  assert.ok(!page.text.includes(`data-tweet-id="${right}"`), 'an unrelated branch does not');
  // The parent is still above it, as context.
  assert.match(page.text, new RegExp(`data-tweet-id="${top}"`));
});

test('the words of a Tweet carry its permalink as a click target', async () => {
  const author = await helpers.signedUpAgent(app, 'clickauthor');
  const created = await author.post('/api/tweets').set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Click the words to open this' });
  const id = created.body.tweet.id;

  const home = await author.get('/home');
  assert.match(home.text, new RegExp(`<p class="tweet-text" data-open-tweet="/clickauthor/status/${id}"`));

  // The timestamp stays a real link, so the page works with no JavaScript.
  assert.match(home.text, new RegExp(`<a class="tweet-time" href="/clickauthor/status/${id}">`));
});

test('a quote carries the original inside it and notifies its author', async () => {
  const author = await helpers.signedUpAgent(app, 'quotedauthor');
  const quoter = await helpers.signedUpAgent(app, 'thequoter');

  const original = await author.post('/api/tweets').set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'The original observation' });
  const id = original.body.tweet.id;

  const quote = await quoter.post('/api/tweets').set('X-CSRF-Token', quoter.csrfToken)
    .send({ body: 'My comment on it', quote_of: String(id) });
  assert.equal(quote.status, 201);

  // The card is rendered from the live original, not copied into the quote.
  const page = await quoter.get(quote.body.tweet.permalink);
  assert.match(page.text, /My comment on it/);
  assert.match(page.text, /class="quoted-tweet"/);
  assert.match(page.text, /The original observation/);

  // Quoting is not retweeting: the original's retweet count is untouched.
  const original2 = await author.get(`/api/tweets/${id}`);
  assert.equal(original2.body.tweet.counts.retweets, 0);

  const connect = await author.get('/connect');
  assert.match(connect.text, /thequoter/);
});

test('a quote with nothing to say is allowed, an empty Tweet is not', async () => {
  const agent = await helpers.signedUpAgent(app, 'terseqoter');
  const first = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'Something worth passing on' });
  const id = first.body.tweet.id;

  // A bare quote is a retweet-with-a-card; it still has content of its own.
  const bare = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
    .send({ body: '', quote_of: String(id) });
  assert.equal(bare.status, 201);

  const empty = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken).send({ body: '' });
  assert.equal(empty.status, 400);
});

test('deleting the original leaves the quote standing, marked unavailable', async () => {
  const author = await helpers.signedUpAgent(app, 'vanishing');
  const quoter = await helpers.signedUpAgent(app, 'stillhere');

  const original = await author.post('/api/tweets').set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'This will be deleted' });
  const id = original.body.tweet.id;
  const quote = await quoter.post('/api/tweets').set('X-CSRF-Token', quoter.csrfToken)
    .send({ body: 'Quoting while it lasts', quote_of: String(id) });

  await author.post(`/tweets/${id}/delete`).type('form').send({ _csrf: author.csrfToken });

  const page = await quoter.get(quote.body.tweet.permalink);
  assert.match(page.text, /Quoting while it lasts/, 'the quote survives');
  assert.match(page.text, /This Tweet is unavailable/);
  assert.ok(!page.text.includes('This will be deleted'));
});

test('the retweet control is a dropdown that still works without JavaScript', async () => {
  const agent = await helpers.signedUpAgent(app, 'dropdownuser');
  const created = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'Retweet me' });
  const id = created.body.tweet.id;

  const home = await agent.get('/home');
  assert.match(home.text, /class="menu menu-retweet"/);
  // The toggle is a real link, so the control is not dead before the script
  // loads or for anyone without it.
  assert.match(home.text, new RegExp(`href="/tweets/${id}/retweet" data-menu-toggle`));
  assert.match(home.text, new RegExp(`href="/compose\\?quote=${id}"`));

  const chooser = await agent.get(`/tweets/${id}/retweet`);
  assert.equal(chooser.status, 200);
  assert.match(chooser.text, new RegExp(`action="/tweets/${id}/retweet"`));
  assert.match(chooser.text, new RegExp(`href="/compose\\?quote=${id}"`));
});

test('someone who both retweets and favorites appears once in the faces row', async () => {
  const author = await helpers.signedUpAgent(app, 'faceauthor');
  const both = await helpers.signedUpAgent(app, 'didboth');
  const onlyFav = await helpers.signedUpAgent(app, 'onlyfaved');

  const created = await author.post('/api/tweets').set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'Engagement goes here' });
  const id = created.body.tweet.id;

  await both.post(`/api/tweets/${id}/retweet`).set('X-CSRF-Token', both.csrfToken);
  await both.post(`/api/tweets/${id}/favorite`).set('X-CSRF-Token', both.csrfToken);
  await onlyFav.post(`/api/tweets/${id}/favorite`).set('X-CSRF-Token', onlyFav.csrfToken);

  const page = await author.get(`/faceauthor/status/${id}`);
  const faces = page.text.slice(page.text.indexOf('class="permalink-faces"'));
  const row = faces.slice(0, faces.indexOf('</div>'));

  const appearances = (row.match(/@didboth/g) || []).length;
  // Two attributes carry the handle - title and alt - so one face is two hits.
  assert.equal(appearances, 2, 'the person who did both should be drawn once');
  assert.equal((row.match(/@onlyfaved/g) || []).length, 2);

  // The counts themselves still count both actions separately.
  assert.match(page.text, /<b>1<\/b> RETWEETS/);
  assert.match(page.text, /<b>2<\/b> FAVORITES/);
});
