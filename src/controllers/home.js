'use strict';

const config = require('../config/env');
const tweetModel = require('../models/tweet');
const userModel = require('../models/user');
const present = require('../services/present');
const sidebar = require('../services/sidebar');
const suggest = require('../services/suggest');
const trendsService = require('../services/trends');
const { decodeCursor, encodeCursor, pageSize } = require('../utils/cursor');
const { notFound } = require('../utils/errors');

/** Signed-out front page. */
exports.landing = async (req, res) => {
  if (req.user) return res.redirect('/home');
  const [popular, suggestions, trends] = await Promise.all([
    tweetModel.popularTimeline({ viewerId: null, limit: 5 }),
    suggest.whoToFollow(null, { limit: 3 }),
    trendsService.forScope({ limit: 6 }),
  ]);
  return res.render('home/landing', {
    layout: 'layouts/minimal',
    title: `${config.brand.name} - ${config.brand.tagline}`,
    description: `${config.brand.name} is where short posts travel fast. Follow people, favorite Tweets and join the conversation in ${config.brand.tweetMaxLength} characters.`,
    canonical: `${config.baseUrl}/`,
    bodyClass: 'page-landing',
    popular: present.tweets(popular.items),
    suggestions: suggestions.map((row) => ({ ...present.compactUser(row), bio: row.bio })),
    trends,
  });
};

/** The authenticated home timeline. */
exports.home = async (req, res) => {
  const limit = pageSize(req.query.count, 20, 40);
  const cursor = decodeCursor(req.query.cursor);
  const page = await tweetModel.homeTimeline(req.user.id, { cursor, limit });
  const items = present.tweets(page.items, { viewerId: req.user.id });
  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null;

  if (req.query.partial === '1') {
    return res.render('partials/timeline-items', {
      layout: false,
      tweets: items,
      nextCursor,
      timelineUrl: '/home',
    });
  }

  const side = await sidebar.build(req, { whoToFollowPage: Number(req.query.wtf || 0) || 0 });
  return res.render('home/index', {
    title: `${config.brand.name}`,
    description: `Your ${config.brand.name} timeline.`,
    nav: 'home',
    bodyClass: 'page-home',
    noindex: true,
    tweets: items,
    nextCursor,
    timelineUrl: '/home',
    side,
    // The highest id on the page - not the first row, which may be an older
    // Tweet that a followee retweeted a moment ago.
    newestId: items.reduce((max, tweet) => Math.max(max, tweet.id), 0),
  });
};

/** Stand-alone compose page - the fallback when JavaScript is unavailable. */
exports.compose = async (req, res) => {
  let replyTo = null;
  if (req.query.in_reply_to) {
    const parent = await tweetModel.findById(Number(req.query.in_reply_to), req.user.id);
    if (parent) replyTo = present.tweet(parent, { viewerId: req.user.id });
  }
  let quoting = null;
  if (req.query.quote) {
    const original = await tweetModel.findById(Number(req.query.quote), req.user.id);
    if (!original) throw notFound('The Tweet you are quoting no longer exists.');
    quoting = present.tweet(original, { viewerId: req.user.id });
  }
  const side = await sidebar.build(req);
  return res.render('home/compose', {
    title: quoting
      ? `Quote @${quoting.author.username} | ${config.brand.name}`
      : `Compose new Tweet | ${config.brand.name}`,
    nav: 'home',
    noindex: true,
    replyTo,
    quoting,
    side,
    prefill: typeof req.query.text === 'string' ? req.query.text.slice(0, config.brand.tweetMaxLength) : '',
  });
};

/** Small JSON poll used by the "N new Tweets" bar. */
exports.newCount = async (req, res) => {
  const sinceId = Number(req.query.since_id || 0);
  // `accounts` is how many people posted, not how many Tweets they wrote -
  // that is what the bar counts.
  const { count, accounts } = await tweetModel.countNewerInHome(req.user.id, sinceId);
  return res.json({ count, accounts });
};

/** "Who to follow" refresh, rendered as an HTML fragment. */
exports.refreshWhoToFollow = async (req, res) => {
  const page = Math.min(Number(req.query.page || 0) || 0, 40);
  const rows = await suggest.whoToFollow(req.user.id, { limit: 3, page });
  return res.render('partials/who-to-follow-items', {
    layout: false,
    whoToFollow: rows.map((row) => ({
      ...present.compactUser(row),
      bio: row.bio || '',
      mutualCount: Number(row.mutual_count || 0),
      mutualNames: (row.mutual_names || []).filter(Boolean),
    })),
  });
};

/** Change the Trends location. */
exports.changeTrendScope = async (req, res) => {
  const scopeType = ['global', 'country', 'city'].includes(req.body.scope_type)
    ? req.body.scope_type
    : 'global';
  const scopeName = String(req.body.scope_name || 'Worldwide').slice(0, 60);
  await userModel.updateSettings(req.user.id, {
    trend_scope_type: scopeType,
    trend_scope_name: scopeName,
  });
  req.flash('success', `Trends are now showing for ${scopeName}.`);
  return res.redirect(req.get('referer') && req.get('referer').startsWith(config.baseUrl) ? req.get('referer') : '/home');
};
