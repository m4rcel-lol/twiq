'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const userModel = require('../models/user');
const tweetModel = require('../models/tweet');
const graphModel = require('../models/graph');
const listModel = require('../models/list');
const present = require('../services/present');
const embedService = require('../services/embed');
const sidebar = require('../services/sidebar');
const suggest = require('../services/suggest');
const realtime = require('../services/realtime');
const { decodeCursor, encodeCursor, pageSize } = require('../utils/cursor');
const { notFound, badRequest } = require('../utils/errors');
const { wantsJson } = require('../middleware/auth');

/** Load the profile owner and the viewer's relationship with them. */
async function loadProfile(req) {
  const owner = await userModel.findByUsername(req.params.username);
  if (!owner) throw notFound('Sorry, that page does not exist.');
  const viewerId = req.user ? req.user.id : null;
  const relationship = await graphModel.relationship(viewerId, owner.id);
  const canView = await graphModel.canViewTweets(viewerId, owner);
  return { owner, relationship, canView, viewerId };
}

/** Shared header data for every profile sub-page. */
async function profileChrome(req, { owner, relationship, viewerId }) {
  const [theme, photos, followedBy, lists, suggestions] = await Promise.all([
    userModel.getProfileSettings(owner.id),
    tweetModel.userMedia(owner.id, { limit: 6 }),
    graphModel.followedBy(owner.id, viewerId, 2),
    listModel.forOwner(owner.id, { viewerId }),
    suggest.whoToFollow(viewerId, { limit: 3 }),
  ]);

  return {
    profile: present.user(owner, { relationship }),
    // The profile owner's own decoration. Deliberately not called `theme`:
    // that local is the viewer's light/dark choice, and a render local
    // overrides res.locals, so naming this one `theme` left every profile
    // page with data-theme="[object Object]" and no dark mode at all.
    ownerTheme: theme
      ? {
          accent: theme.accent_color,
          background: theme.background_color,
          backgroundUrl: theme.background_path ? present.mediaUrl(theme.background_path) : null,
          tile: theme.background_tile,
        }
      : null,
    photos: photos.map(present.mediaThumb),
    followedBy: {
      users: followedBy.users.map(present.compactUser),
      total: followedBy.total,
    },
    lists: lists.map(present.list),
    suggestions: suggestions.map((row) => ({
      ...present.compactUser(row),
      bio: row.bio || '',
      mutualCount: Number(row.mutual_count || 0),
      mutualNames: (row.mutual_names || []).filter(Boolean),
    })),
    isOwner: viewerId != null && Number(viewerId) === Number(owner.id),
  };
}

function seo(owner, extra = {}) {
  return {
    title: `${owner.display_name} (@${owner.username}) | ${config.brand.name}`,
    description: owner.bio
      ? owner.bio.slice(0, 200)
      : `The latest Tweets from ${owner.display_name} (@${owner.username}) on ${config.brand.name}.`,
    canonical: `${config.baseUrl}/${owner.username}`,
    ogType: 'profile',
    // Protected and suspended accounts get no card, the same as no index.
    embed: owner.is_protected || owner.is_suspended ? null : embedService.forProfile(present.user(owner)),
    noindex: owner.is_protected || owner.is_suspended,
    ...extra,
  };
}

/** GET /:username (plus ?tab=replies|media) */
exports.show = async (req, res) => {
  const { owner, relationship, canView, viewerId } = await loadProfile(req);
  const tab = ['tweets', 'replies', 'media'].includes(req.query.tab) ? req.query.tab : 'tweets';
  const mode = tab === 'replies' ? 'replies' : tab === 'media' ? 'media' : 'tweets';

  const chrome = await profileChrome(req, { owner, relationship, viewerId });
  let tweets = [];
  let nextCursor = null;
  let pinned = null;

  if (canView && !owner.is_suspended) {
    const limit = pageSize(req.query.count, 20, 40);
    const cursor = decodeCursor(req.query.cursor);
    const [page, threshold, pinnedRow] = await Promise.all([
      tweetModel.userTimeline(owner.id, { viewerId, mode, cursor, limit }),
      tweetModel.bestTweetThreshold(owner.id),
      cursor || mode !== 'tweets' ? Promise.resolve(null) : tweetModel.pinnedTweet(owner.id, viewerId),
    ]);
    tweets = present.tweets(page.items, { viewerId, bestThreshold: threshold });
    nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null;
    if (pinnedRow) {
      pinned = present.tweet(pinnedRow, { viewerId, bestThreshold: threshold });
      pinned.isPinned = true;
      tweets = tweets.filter((t) => t.id !== pinned.id);
    }
  }

  const timelineUrl = `/${owner.username}${tab === 'tweets' ? '' : `?tab=${tab}`}`;

  if (req.query.partial === '1') {
    return res.render('partials/timeline-items', {
      layout: false,
      tweets,
      nextCursor,
      timelineUrl,
    });
  }

  return res.render('profile/show', {
    ...seo(owner),
    nav: viewerId && Number(viewerId) === Number(owner.id) ? 'me' : null,
    bodyClass: 'page-profile',
    ...chrome,
    tab,
    tweets,
    pinned,
    nextCursor,
    timelineUrl,
    canView,
    side: req.user ? await sidebar.build(req) : null,
  });
};

/** GET /:username/media */
exports.media = async (req, res) => {
  req.query.tab = 'media';
  return exports.show(req, res);
};

/** GET /:username/favorites */
exports.favorites = async (req, res) => {
  const { owner, relationship, canView, viewerId } = await loadProfile(req);
  const chrome = await profileChrome(req, { owner, relationship, viewerId });
  let tweets = [];
  let nextCursor = null;
  if (canView) {
    const cursor = decodeCursor(req.query.cursor);
    const page = await tweetModel.favoritesTimeline(owner.id, { viewerId, cursor, limit: 20 });
    tweets = present.tweets(page.items, { viewerId });
    nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null;
  }
  const timelineUrl = `/${owner.username}/favorites`;
  if (req.query.partial === '1') {
    return res.render('partials/timeline-items', { layout: false, tweets, nextCursor, timelineUrl });
  }
  return res.render('profile/favorites', {
    ...seo(owner, { title: `Tweets favorited by ${owner.display_name} (@${owner.username}) | ${config.brand.name}` }),
    nav: null,
    bodyClass: 'page-profile',
    ...chrome,
    tab: 'favorites',
    tweets,
    nextCursor,
    timelineUrl,
    canView,
  });
};

function peopleList(kind) {
  return async (req, res) => {
    const { owner, relationship, canView, viewerId } = await loadProfile(req);
    const chrome = await profileChrome(req, { owner, relationship, viewerId });
    const page = Math.max(0, Number(req.query.page || 0) || 0);
    const perPage = 20;
    const rows = canView
      ? await graphModel[kind](owner.id, { viewerId, limit: perPage + 1, offset: page * perPage })
      : [];
    const hasMore = rows.length > perPage;
    return res.render('profile/people', {
      ...seo(owner, {
        title: `People ${kind === 'followers' ? 'following' : 'followed by'} ${owner.display_name} (@${owner.username}) | ${config.brand.name}`,
      }),
      nav: null,
      bodyClass: 'page-profile',
      ...chrome,
      tab: kind,
      people: (hasMore ? rows.slice(0, perPage) : rows).map((row) => present.user(row)),
      page,
      hasMore,
      canView,
      listUrl: `/${owner.username}/${kind}`,
    });
  };
}

exports.followers = peopleList('followers');
exports.following = peopleList('following');

/** GET /:username/lists */
exports.lists = async (req, res) => {
  const { owner, relationship, viewerId } = await loadProfile(req);
  const chrome = await profileChrome(req, { owner, relationship, viewerId });
  return res.render('profile/lists', {
    ...seo(owner, { title: `Lists by ${owner.display_name} (@${owner.username}) | ${config.brand.name}` }),
    nav: null,
    bodyClass: 'page-profile',
    ...chrome,
    tab: 'lists',
  });
};

function backTo(req, fallback) {
  const referer = req.get('referer');
  if (referer && referer.startsWith(config.baseUrl)) return referer.slice(config.baseUrl.length) || fallback;
  return fallback;
}

/** POST /:username/follow */
exports.follow = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  const result = await graphModel.follow(req.user.id, target);
  realtime.publish(target.id, { type: 'notification' });
  logger.info({ userId: req.user.id, targetId: target.id, state: result.state }, 'follow');
  if (wantsJson(req)) {
    const relationship = await graphModel.relationship(req.user.id, target.id);
    return res.json({ username: String(target.username), ...relationship });
  }
  return res.redirect(backTo(req, `/${target.username}`));
};

/** POST /:username/unfollow */
exports.unfollow = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  await graphModel.unfollow(req.user.id, target.id);
  if (wantsJson(req)) {
    const relationship = await graphModel.relationship(req.user.id, target.id);
    return res.json({ username: String(target.username), ...relationship });
  }
  return res.redirect(backTo(req, `/${target.username}`));
};

exports.block = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  await graphModel.block(req.user.id, target.id);
  logger.info({ userId: req.user.id, targetId: target.id }, 'block');
  if (wantsJson(req)) return res.json({ blocking: true });
  req.flash('success', `@${target.username} is blocked.`);
  return res.redirect(`/${target.username}`);
};

exports.unblock = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  await graphModel.unblock(req.user.id, target.id);
  if (wantsJson(req)) return res.json({ blocking: false });
  req.flash('success', `@${target.username} is unblocked.`);
  return res.redirect(backTo(req, `/${target.username}`));
};

exports.mute = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  await graphModel.mute(req.user.id, target.id);
  if (wantsJson(req)) return res.json({ muting: true });
  req.flash('success', `@${target.username} is muted. Their Tweets will not appear in your timeline.`);
  return res.redirect(backTo(req, `/${target.username}`));
};

exports.unmute = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  await graphModel.unmute(req.user.id, target.id);
  if (wantsJson(req)) return res.json({ muting: false });
  return res.redirect(backTo(req, `/${target.username}`));
};

/** GET /settings/requests - pending follow requests for a protected account. */
exports.followRequests = async (req, res) => {
  const requests = await graphModel.pendingRequests(req.user.id);
  return res.render('profile/requests', {
    title: `Follower requests | ${config.brand.name}`,
    nav: 'me',
    noindex: true,
    requests: requests.map((row) => present.user(row)),
    side: await sidebar.build(req),
  });
};

exports.approveRequest = async (req, res) => {
  const requester = await userModel.findByUsername(req.params.username);
  if (!requester) throw notFound('That account does not exist.');
  await graphModel.approveRequest(req.user.id, requester.id);
  realtime.publish(requester.id, { type: 'notification' });
  if (wantsJson(req)) return res.json({ approved: true });
  return res.redirect('/settings/requests');
};

exports.denyRequest = async (req, res) => {
  const requester = await userModel.findByUsername(req.params.username);
  if (!requester) throw notFound('That account does not exist.');
  await graphModel.denyRequest(req.user.id, requester.id);
  if (wantsJson(req)) return res.json({ approved: false });
  return res.redirect('/settings/requests');
};

/** GET /:username/report */
exports.showReport = async (req, res) => {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  if (Number(target.id) === Number(req.user.id)) throw badRequest('You cannot report yourself.');
  return res.render('tweet/report', {
    layout: 'layouts/minimal',
    title: `Report @${target.username} | ${config.brand.name}`,
    bodyClass: 'page-auth',
    tweet: null,
    targetUser: present.user(target),
  });
};

exports.loadProfile = loadProfile;
exports.profileChrome = profileChrome;
