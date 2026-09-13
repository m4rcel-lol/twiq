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

const meta = (html, attr, name) => {
  const re = new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`);
  const m = re.exec(html);
  return m ? m[1] : null;
};
const og = (html, name) => meta(html, 'property', name);
const tw = (html, name) => meta(html, 'name', name);

test('a Tweet card names the author and quotes what they wrote', async () => {
  const author = await helpers.signedUpAgent(app, 'cardauthor', { displayName: 'Card Author' });
  const created = await author.post('/api/tweets').set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'The words that should appear in the card' });

  const page = await author.get(created.body.tweet.permalink);

  // The author is the title and the Tweet is the description - the other way
  // round reads as a headline nobody chose.
  assert.equal(og(page.text, 'og:title'), 'Card Author (@cardauthor)');
  assert.equal(og(page.text, 'og:description'), 'The words that should appear in the card');
  assert.equal(tw(page.text, 'twitter:title'), 'Card Author (@cardauthor)');
  assert.match(page.text, /<meta name="theme-color" content="#[0-9a-fA-F]{6}">/);
});

test('a Tweet with a photo asks for the large card, one without does not', async () => {
  const agent = await helpers.signedUpAgent(app, 'cardphoto');
  const plain = await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken)
    .send({ body: 'no picture here' });
  const page = await agent.get(plain.body.tweet.permalink);
  // Falls back to the avatar, which belongs in a small card, not a banner.
  assert.equal(tw(page.text, 'twitter:card'), 'summary');
  assert.ok(og(page.text, 'og:image'), 'there should still be an image');
});

test('the oEmbed link is declared and answers with the engagement line', async () => {
  const request = require('supertest');
  const author = await helpers.signedUpAgent(app, 'oembedauthor', { displayName: 'Oembed Author' });
  const fan = await helpers.signedUpAgent(app, 'oembedfan');
  const created = await author.post('/api/tweets').set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'worth a favorite' });
  const id = created.body.tweet.id;
  await fan.post(`/api/tweets/${id}/favorite`).set('X-CSRF-Token', fan.csrfToken);
  await fan.post(`/api/tweets/${id}/retweet`).set('X-CSRF-Token', fan.csrfToken);

  const page = await author.get(created.body.tweet.permalink);
  const link = /<link rel="alternate" type="application\/json\+oembed"\s*\n?\s*href="([^"]+)"/.exec(page.text);
  assert.ok(link, 'the page should declare its oEmbed endpoint');

  const url = link[1].replace(/^https?:\/\/[^/]+/, '').replace(/&amp;/g, '&');
  const res = await request(app).get(url);
  assert.equal(res.status, 200);
  assert.equal(res.body.author_name, 'Oembed Author (@oembedauthor)');
  // Open Graph has nowhere to put this, which is why oEmbed is here at all.
  assert.equal(res.body.provider_name, '1 Retweet  ·  1 Favorite');
});

test('a protected account is not given a card at all', async () => {
  const request = require('supertest');
  const shy = await helpers.signedUpAgent(app, 'shyaccount');
  const created = await shy.post('/api/tweets').set('X-CSRF-Token', shy.csrfToken)
    .send({ body: 'for followers only' });
  // dm_policy is required by the schema; without it the form is rejected.
  const saved = await shy.post('/settings/privacy').type('form')
    .send({ _csrf: shy.csrfToken, is_protected: 'on', dm_policy: 'followers' });
  assert.equal(saved.status, 302);

  const page = await shy.get(created.body.tweet.permalink);
  assert.ok(!page.text.includes('json+oembed'), 'no oEmbed link for a protected account');

  // The card is moot anyway: a chat client fetches anonymously, and the page
  // itself is closed to anyone who is not an approved follower.
  const stranger = await request(app).get(created.body.tweet.permalink);
  assert.equal(stranger.status, 403);

  const direct = await request(app).get(`/oembed?url=${encodeURIComponent(created.body.tweet.permalink)}`);
  assert.equal(direct.status, 404, 'and the endpoint refuses it directly too');
});

test('oEmbed refuses anything that is not a Tweet or a profile', async () => {
  const request = require('supertest');
  for (const url of ['/settings/account', '/admin', '/does/not/exist', 'https://example.com/x']) {
    const res = await request(app).get(`/oembed?url=${encodeURIComponent(url)}`);
    assert.equal(res.status, 404, `${url} should not be embeddable`);
  }
  assert.equal((await request(app).get('/oembed')).status, 400);
});

test('a profile card carries the avatar and what the account amounts to', async () => {
  const request = require('supertest');
  const agent = await helpers.signedUpAgent(app, 'cardprofile', { displayName: 'Card Profile' });
  await agent.post('/api/tweets').set('X-CSRF-Token', agent.csrfToken).send({ body: 'one' });

  const page = await request(app).get('/cardprofile');
  assert.equal(og(page.text, 'og:title'), 'Card Profile (@cardprofile)');
  assert.equal(tw(page.text, 'twitter:card'), 'summary');

  const res = await request(app).get(`/oembed?url=${encodeURIComponent('/cardprofile')}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.provider_name, '1 Tweet  ·  0 followers', 'and it pluralises');
});
