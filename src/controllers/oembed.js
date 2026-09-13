'use strict';

/**
 * GET /oembed?url=...
 *
 * Chat clients that find the <link rel="alternate" type="application/json+oembed">
 * on a page fetch this and render `author_name` and `provider_name` as the
 * two small lines above the card. Open Graph has nowhere to put an
 * engagement summary, so that is what this endpoint exists to carry.
 *
 * It reads only public data and answers for Tweets and profiles; anything
 * else is a 404 rather than a guess.
 */

const config = require('../config/env');
const tweetModel = require('../models/tweet');
const userModel = require('../models/user');
const present = require('../services/present');
const embed = require('../services/embed');
const { notFound, badRequest } = require('../utils/errors');

const USERNAME = /^[A-Za-z0-9_]{1,15}$/;

function parseTarget(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw), config.baseUrl);
  } catch {
    return null;
  }
  const status = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(parsed.pathname);
  if (status) return { kind: 'tweet', username: status[1], id: Number(status[2]) };
  const profile = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(parsed.pathname);
  if (profile && USERNAME.test(profile[1])) return { kind: 'profile', username: profile[1] };
  return null;
}

exports.show = async (req, res) => {
  if (!req.query.url) throw badRequest('An url is required.');
  const target = parseTarget(req.query.url);
  if (!target) throw notFound('Nothing to embed at that address.');

  let card;
  if (target.kind === 'tweet') {
    const row = await tweetModel.findById(target.id, null);
    if (!row) throw notFound('That Tweet does not exist.');
    const author = await userModel.findById(row.user_id);
    // A protected account's Tweets are not public, so they get no card.
    if (!author || author.is_protected || author.is_suspended) throw notFound('That Tweet is not public.');
    if (String(author.username).toLowerCase() !== target.username.toLowerCase()) {
      throw notFound('That Tweet does not exist.');
    }
    card = embed.forTweet(present.tweet(row, { viewerId: null }));
  } else {
    const account = await userModel.findByUsername(target.username);
    if (!account || account.is_suspended) throw notFound('No such account.');
    if (account.is_protected) throw notFound('That account is protected.');
    card = embed.forProfile(present.user(account));
  }

  res.type('application/json+oembed');
  return res.json({
    version: '1.0',
    type: 'link',
    // The line above the title, and the smaller one above that.
    author_name: card.author,
    author_url: card.authorUrl,
    provider_name: card.provider || config.brand.name,
    provider_url: card.url,
    title: card.title,
    cache_age: 300,
  });
};

exports.parseTarget = parseTarget;
