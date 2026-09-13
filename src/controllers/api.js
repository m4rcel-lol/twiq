'use strict';

/**
 * A small internal JSON API.
 *
 * It is authenticated with the same session cookie as the site and protected
 * by the same CSRF token, which is what the progressive-enhancement front end
 * uses. It is deliberately small: enough for a future client, not a second
 * implementation of the whole product.
 */

const tweetModel = require('../models/tweet');
const userModel = require('../models/user');
const graphModel = require('../models/graph');
const notificationModel = require('../models/notification');
const messageModel = require('../models/message');
const present = require('../services/present');
const trendsService = require('../services/trends');
const suggest = require('../services/suggest');
const schemas = require('../validators/schemas');
const { decodeCursor, encodeCursor, pageSize } = require('../utils/cursor');
const { notFound, forbidden, badRequest } = require('../utils/errors');

exports.me = async (req, res) => {
  res.json({ user: present.user(req.user) });
};

exports.getUser = async (req, res) => {
  const user = await userModel.findByUsername(req.params.username);
  if (!user || user.is_suspended) throw notFound('No such account.');
  const relationship = req.user ? await graphModel.relationship(req.user.id, user.id) : null;
  res.json({ user: present.user(user, { relationship }) });
};

exports.getUserTweets = async (req, res) => {
  const user = await userModel.findByUsername(req.params.username);
  if (!user || user.is_suspended) throw notFound('No such account.');
  const viewerId = req.user ? req.user.id : null;
  if (!(await graphModel.canViewTweets(viewerId, user))) throw forbidden('These Tweets are protected.');
  const page = await tweetModel.userTimeline(user.id, {
    viewerId,
    mode: req.query.mode === 'replies' ? 'replies' : 'tweets',
    cursor: decodeCursor(req.query.cursor),
    limit: pageSize(req.query.count, 20, 50),
  });
  res.json({
    tweets: present.tweets(page.items, { viewerId }),
    next_cursor: page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null,
  });
};

exports.getTweet = async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  const row = await tweetModel.findById(Number(req.params.id), viewerId);
  if (!row) throw notFound('No such Tweet.');
  const author = await userModel.findByUsername(row.author_username);
  if (!(await graphModel.canViewTweets(viewerId, author))) throw forbidden('That Tweet is protected.');
  res.json({ tweet: present.tweet(row, { viewerId }) });
};

exports.homeTimeline = async (req, res) => {
  const page = await tweetModel.homeTimeline(req.user.id, {
    cursor: decodeCursor(req.query.cursor),
    limit: pageSize(req.query.count, 20, 50),
  });
  res.json({
    tweets: present.tweets(page.items, { viewerId: req.user.id }),
    next_cursor: page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null,
  });
};

exports.createTweet = async (req, res) => {
  const parsed = schemas.composeTweet.safeParse(req.body);
  if (!parsed.success) throw badRequest(schemas.formatErrors(parsed.error).first);
  const created = await tweetModel.create({
    userId: req.user.id,
    body: parsed.data.body,
    mediaIds: parsed.data.media_ids,
    inReplyToTweetId: parsed.data.in_reply_to,
    quotedTweetId: parsed.data.quote_of,
  });
  const row = await tweetModel.findById(created.id, req.user.id);
  res.status(201).json({ tweet: present.tweet(row, { viewerId: req.user.id }) });
};

exports.deleteTweet = async (req, res) => {
  await tweetModel.remove(Number(req.params.id), req.user.id, {
    force: req.user.role === 'admin' || req.user.role === 'moderator',
  });
  res.json({ deleted: true });
};

function interaction(fn) {
  return async (req, res) => {
    const id = Number(req.params.id);
    const raw = await tweetModel.findRaw(id);
    if (!raw) throw notFound('No such Tweet.');
    const author = await userModel.findById(raw.user_id);
    if (!(await graphModel.canViewTweets(req.user.id, author))) throw forbidden();
    const result = await fn(req.user.id, id);
    res.json({ id, ...result });
  };
}

exports.favorite = interaction((userId, id) => tweetModel.favorite(userId, id));
exports.unfavorite = interaction((userId, id) => tweetModel.unfavorite(userId, id));
exports.retweet = interaction((userId, id) => tweetModel.retweet(userId, id));
exports.unretweet = interaction((userId, id) => tweetModel.unretweet(userId, id));

exports.follow = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('No such account.');
  const result = await graphModel.follow(req.user.id, target);
  res.json({ username: String(target.username), ...result });
};

exports.unfollow = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('No such account.');
  await graphModel.unfollow(req.user.id, target.id);
  res.json({ username: String(target.username), state: 'not_following' });
};

exports.search = async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 140);
  if (!q) return res.json({ tweets: [], users: [] });
  const viewerId = req.user ? req.user.id : null;
  const [tweets, users] = await Promise.all([
    tweetModel.searchTimeline(q, { viewerId, limit: 20 }),
    userModel.search(q, { viewerId, limit: 10 }),
  ]);
  return res.json({
    tweets: present.tweets(tweets.items, { viewerId }),
    users: users.map((row) => present.user(row)),
  });
};

/** Type-ahead for the top bar search box. */
exports.typeahead = async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 1) return res.json({ users: [] });
  const users = await userModel.search(q, { viewerId: req.user ? req.user.id : null, limit: 6 });
  return res.json({
    users: users.map((row) => ({
      username: String(row.username),
      displayName: row.display_name,
      avatarUrl: present.user(row).avatarUrl,
      isVerified: Boolean(row.is_verified),
    })),
  });
};

exports.trends = async (req, res) => {
  const trends = await trendsService.forScope({
    scopeType: ['global', 'country', 'city'].includes(req.query.scope_type) ? req.query.scope_type : 'global',
    scopeName: String(req.query.scope_name || 'Worldwide').slice(0, 60),
    limit: 10,
  });
  res.json({ trends });
};

exports.whoToFollow = async (req, res) => {
  const rows = await suggest.whoToFollow(req.user.id, {
    limit: 3,
    page: Math.min(Number(req.query.page || 0) || 0, 40),
  });
  res.json({
    users: rows.map((row) => ({
      ...present.compactUser(row),
      bio: row.bio || '',
      mutualCount: Number(row.mutual_count || 0),
    })),
  });
};

exports.badges = async (req, res) => {
  const [notifications, messages] = await Promise.all([
    notificationModel.unreadCount(req.user.id),
    messageModel.totalUnread(req.user.id),
  ]);
  res.json({ notifications, messages });
};
