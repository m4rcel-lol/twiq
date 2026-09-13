'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const tweetModel = require('../models/tweet');
const userModel = require('../models/user');
const graphModel = require('../models/graph');
const mediaModel = require('../models/media');
const moderation = require('../models/moderation');
const present = require('../services/present');
const sidebar = require('../services/sidebar');
const storage = require('../services/storage');
const realtime = require('../services/realtime');
const announce = require('../services/announce');
const schemas = require('../validators/schemas');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const { wantsJson } = require('../middleware/auth');

function backTo(req, fallback = '/home') {
  const referer = req.get('referer');
  if (referer && referer.startsWith(config.baseUrl)) return referer.slice(config.baseUrl.length) || fallback;
  if (referer && referer.startsWith('/')) return referer;
  return fallback;
}

/** POST /tweets - create a Tweet or a reply. */
exports.create = async (req, res) => {
  const parsed = schemas.composeTweet.safeParse(req.body);
  if (!parsed.success) {
    const formatted = schemas.formatErrors(parsed.error);
    if (wantsJson(req)) throw badRequest(formatted.first);
    req.flash('error', formatted.first);
    return res.redirect(backTo(req));
  }

  const created = await tweetModel.create({
    userId: req.user.id,
    body: parsed.data.body,
    mediaIds: parsed.data.media_ids,
    inReplyToTweetId: parsed.data.in_reply_to,
    quotedTweetId: parsed.data.quote_of,
  });

  logger.info({ userId: req.user.id, tweetId: created.id }, 'tweet created');

  const hydrated = await tweetModel.findById(created.id, req.user.id);
  const view = present.tweet(hydrated, { viewerId: req.user.id });

  await announce.tweetCreated({
    tweetId: created.id,
    authorId: req.user.id,
    username: view.author.username,
  });

  if (wantsJson(req)) {
    const html = await new Promise((resolve, reject) => {
      res.render('partials/tweet', { layout: false, tweet: view, context: 'timeline' }, (err, out) =>
        err ? reject(err) : resolve(out)
      );
    });
    return res.status(201).json({ tweet: { id: view.id, permalink: view.permalink }, html });
  }

  req.flash('success', 'Your Tweet was posted.');
  return res.redirect(parsed.data.in_reply_to || parsed.data.quote_of ? view.permalink : backTo(req, '/home'));
};

/** GET /:username/status/:id - the permalink page. */
exports.show = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound('That Tweet does not exist.');

  const row = await tweetModel.findById(id, req.user ? req.user.id : null);
  if (!row) throw notFound('That Tweet does not exist.');

  const author = await userModel.findByUsername(row.author_username);
  if (!author) throw notFound('That Tweet does not exist.');
  if (String(req.params.username).toLowerCase() !== String(author.username).toLowerCase()) {
    return res.redirect(301, `/${author.username}/status/${id}`);
  }
  if (!(await graphModel.canViewTweets(req.user ? req.user.id : null, author))) {
    throw forbidden('These Tweets are protected. Only approved followers can see them.');
  }

  const viewerId = req.user ? req.user.id : null;
  const [thread, favorites, retweeters, side, relationship] = await Promise.all([
    tweetModel.conversation(id, viewerId),
    tweetModel.favoritedBy(id, 12),
    tweetModel.retweetedBy(id, 12),
    req.user ? sidebar.build(req) : Promise.resolve(null),
    viewerId ? graphModel.relationship(viewerId, author.id) : Promise.resolve(null),
  ]);

  const tweet = present.tweet(row, { viewerId });
  return res.render('tweet/show', {
    title: `${author.display_name} on ${config.brand.name}: "${tweet.snippet}"`,
    description: tweet.snippet,
    canonical: tweet.absoluteUrl,
    ogType: 'article',
    ogImage: tweet.media.length > 0 && !tweet.media[0].isVideo ? `${config.baseUrl}${tweet.media[0].url}` : null,
    noindex: author.is_protected,
    nav: null,
    bodyClass: 'page-permalink',
    tweet,
    author: present.user(author, { relationship }),
    ancestors: present.tweets(thread.ancestors, { viewerId }),
    replies: present.tweets(thread.replies, { viewerId }),
    // One row of the people who engaged, retweeters first. Someone who both
    // retweeted and favorited is one person, so they appear once - the two
    // lists overlap and concatenating them showed such a face twice.
    faces: uniqueBy(
      retweeters.map(present.compactUser).concat(favorites.map(present.compactUser)),
      (person) => person.id
    ).slice(0, 18),
    side,
  });
};

/** First occurrence wins, so the earlier list keeps its order. */
function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** POST /tweets/:id/delete */
exports.destroy = async (req, res) => {
  const id = Number(req.params.id);
  const isStaff = req.user.role === 'admin' || req.user.role === 'moderator';
  const removed = await tweetModel.remove(id, req.user.id, { force: isStaff });
  if (isStaff && Number(removed.user_id) !== Number(req.user.id)) {
    await moderation.audit({
      actorId: req.user.id,
      action: 'tweet.delete',
      targetType: 'tweet',
      targetId: id,
      metadata: { author_id: removed.user_id },
      ip: req.ip,
    });
  }
  logger.info({ userId: req.user.id, tweetId: id }, 'tweet deleted');
  if (wantsJson(req)) return res.json({ deleted: true, id });
  req.flash('success', 'Your Tweet was deleted.');
  return res.redirect(backTo(req, `/${req.user.username}`));
};

function interaction(action) {
  return async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound('That Tweet does not exist.');

    const raw = await tweetModel.findRaw(id);
    if (!raw) throw notFound('That Tweet no longer exists.');
    const author = await userModel.findById(raw.user_id);
    if (!(await graphModel.canViewTweets(req.user.id, author))) {
      throw forbidden('You cannot interact with that Tweet.');
    }

    const result = await action(req.user.id, id);
    if (result.retweeted === true) {
      await announce.retweeted({
        userId: req.user.id, username: req.user.username, notifyUserId: result.notifyUserId,
      });
    } else if (result.notifyUserId) {
      realtime.publish(result.notifyUserId, { type: 'notification' });
    }

    if (wantsJson(req)) return res.json({ id, ...result });
    return res.redirect(backTo(req));
  };
}

exports.favorite = interaction((userId, id) => tweetModel.favorite(userId, id));
exports.unfavorite = interaction((userId, id) => tweetModel.unfavorite(userId, id));
exports.retweet = interaction((userId, id) => tweetModel.retweet(userId, id));
exports.unretweet = interaction((userId, id) => tweetModel.unretweet(userId, id));

exports.pin = async (req, res) => {
  await tweetModel.pin(req.user.id, Number(req.params.id));
  if (wantsJson(req)) return res.json({ pinned: true });
  req.flash('success', 'That Tweet is pinned to your profile.');
  return res.redirect(backTo(req, `/${req.user.username}`));
};

exports.unpin = async (req, res) => {
  await tweetModel.unpin(req.user.id);
  if (wantsJson(req)) return res.json({ pinned: false });
  req.flash('success', 'That Tweet is no longer pinned.');
  return res.redirect(backTo(req, `/${req.user.username}`));
};

/** POST /media - used by the composer's photo button. */
exports.uploadMedia = async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload.');
  const info = storage.validateUpload(req.file.buffer, req.file.mimetype);
  const key = await storage.save(req.file.buffer, { prefix: 'media', ext: info.ext });
  const record = await mediaModel.create({
    userId: req.user.id,
    kind: info.kind,
    storageKey: key,
    mimeType: info.mime,
    byteSize: info.size,
    altText: String(req.body.alt_text || '').slice(0, 420),
  });
  logger.info({ userId: req.user.id, mediaId: record.id, kind: info.kind }, 'media uploaded');
  return res.status(201).json({
    media: {
      id: Number(record.id),
      kind: record.kind,
      url: storage.urlFor(record.storage_key),
      isVideo: record.kind === 'video',
    },
  });
};

/**
 * GET /tweets/:id/retweet - the retweet-or-quote chooser.
 *
 * The dropdown in the Tweet actions is a link to this page, so the control
 * works before any JavaScript has run and for anyone without it. With
 * JavaScript the click is intercepted and the menu opens instead.
 */
exports.retweetChoice = async (req, res) => {
  const id = Number(req.params.id);
  const row = await tweetModel.findById(id, req.user.id);
  if (!row) throw notFound('That Tweet does not exist.');
  const view = present.tweet(row, { viewerId: req.user.id });
  return res.render('tweet/retweet', {
    layout: 'layouts/minimal',
    title: `Retweet or quote | ${config.brand.name}`,
    bodyClass: 'page-auth',
    noindex: true,
    tweet: view,
  });
};

/** GET /tweets/:id/report and POST - the "Report Tweet" flow. */
exports.showReport = async (req, res) => {
  const id = Number(req.params.id);
  const row = await tweetModel.findById(id, req.user.id);
  if (!row) throw notFound('That Tweet does not exist.');
  return res.render('tweet/report', {
    layout: 'layouts/minimal',
    title: `Report a Tweet | ${config.brand.name}`,
    bodyClass: 'page-auth',
    tweet: present.tweet(row, { viewerId: req.user.id }),
    targetUser: null,
  });
};

exports.submitReport = async (req, res) => {
  const parsed = schemas.reportInput.safeParse(req.body);
  if (!parsed.success) throw badRequest(schemas.formatErrors(parsed.error).first);

  let targetUserId = null;
  if (parsed.data.username) {
    const target = await userModel.findByUsername(parsed.data.username);
    if (target) targetUserId = target.id;
  }
  let targetTweetId = null;
  if (parsed.data.tweet_id) {
    const tweet = await tweetModel.findRaw(parsed.data.tweet_id);
    if (tweet) {
      targetTweetId = tweet.id;
      if (!targetUserId) targetUserId = tweet.user_id;
    }
  }
  if (!targetTweetId && !targetUserId) throw badRequest('There is nothing to report.');

  await moderation.createReport({
    reporterId: req.user.id,
    targetUserId,
    targetTweetId,
    category: parsed.data.category,
    details: parsed.data.details,
  });
  logger.info({ userId: req.user.id, targetUserId, targetTweetId, category: parsed.data.category }, 'report filed');

  if (wantsJson(req)) return res.json({ reported: true });
  req.flash('success', 'Thanks - your report has been sent to the Twiq moderators.');
  return res.redirect(backTo(req));
};

exports.backTo = backTo;
