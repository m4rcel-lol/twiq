'use strict';

const config = require('../config/env');
const tweetModel = require('../models/tweet');
const userModel = require('../models/user');
const present = require('../services/present');
const sidebar = require('../services/sidebar');
const { decodeCursor, encodeCursor } = require('../utils/cursor');

/** GET /search?q= - Tweets, people and hashtags in one 2014-style results page. */
exports.index = async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 140);
  const mode = ['all', 'people'].includes(req.query.mode) ? req.query.mode : 'all';
  const viewerId = req.user ? req.user.id : null;

  if (!q) {
    return res.render('search/index', {
      title: `Search | ${config.brand.name}`,
      nav: null,
      bodyClass: 'page-search',
      q,
      mode,
      tweets: [],
      people: [],
      nextCursor: null,
      timelineUrl: '/search',
      side: req.user ? await sidebar.build(req) : null,
      isHashtag: false,
    });
  }

  const cursor = decodeCursor(req.query.cursor);
  const [tweetPage, people] = await Promise.all([
    mode === 'people'
      ? Promise.resolve({ items: [], nextCursor: null })
      : tweetModel.searchTimeline(q, { viewerId, cursor, limit: 20 }),
    userModel.search(q, { viewerId, limit: mode === 'people' ? 30 : 3 }),
  ]);

  const tweets = present.tweets(tweetPage.items, { viewerId });
  const nextCursor = tweetPage.nextCursor
    ? encodeCursor(tweetPage.nextCursor.at, tweetPage.nextCursor.id)
    : null;
  const timelineUrl = `/search?q=${encodeURIComponent(q)}&mode=${mode}`;

  if (req.query.partial === '1') {
    return res.render('partials/timeline-items', { layout: false, tweets, nextCursor, timelineUrl });
  }

  return res.render('search/index', {
    title: `${q} | ${config.brand.name} Search`,
    description: `Tweets and people matching ${q} on ${config.brand.name}.`,
    canonical: `${config.baseUrl}/search?q=${encodeURIComponent(q)}`,
    noindex: true,
    nav: null,
    bodyClass: 'page-search',
    q,
    mode,
    isHashtag: q.startsWith('#'),
    tweets,
    people: people.map((row) => present.user(row)),
    nextCursor,
    timelineUrl,
    side: req.user ? await sidebar.build(req) : null,
  });
};
