'use strict';

const config = require('../config/env');
const storage = require('./storage');
const text = require('./text');
const format = require('../utils/format');

/**
 * View models. Controllers hand database rows to these functions and the
 * templates only ever see presentation-ready values, so no template has to
 * know about column names, storage keys or escaping rules.
 */

const DEFAULT_AVATAR = '/images/default-avatar.svg';
const DEFAULT_HEADER = '/images/default-header.svg';

function mediaUrl(key) {
  return key ? storage.urlFor(key) : null;
}

function user(row, { relationship = null } = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: row.display_name,
    bio: row.bio || '',
    bioHtml: row.bio ? text.renderBioHtml(row.bio) : '',
    location: row.location || '',
    website: row.website || '',
    websiteLabel: format.displayUrl(row.website),
    avatarUrl: mediaUrl(row.avatar_path) || DEFAULT_AVATAR,
    headerUrl: mediaUrl(row.header_path) || DEFAULT_HEADER,
    hasHeader: Boolean(row.header_path),
    isVerified: Boolean(row.is_verified),
    // A verified administrator's tick is red; everyone else's is the accent.
    isAdmin: row.role === 'admin',
    isOfficial: row.is_official === true,
    isProtected: Boolean(row.is_protected),
    isSuspended: Boolean(row.is_suspended),
    isAutomated: Boolean(row.automated_by_user_id),
    automatedBy: row.automated_by_username
      ? { username: String(row.automated_by_username), profileUrl: `/${row.automated_by_username}` }
      : null,
    role: row.role || 'user',
    isStaff: row.role === 'admin' || row.role === 'moderator',
    counts: {
      tweets: Number(row.tweet_count || 0),
      following: Number(row.following_count || 0),
      followers: Number(row.follower_count || 0),
      favorites: Number(row.favorite_count || 0),
      lists: Number(row.list_count || 0),
    },
    joined: row.created_at ? format.joinedDate(row.created_at) : '',
    joinedIso: row.created_at ? format.isoDate(row.created_at) : '',
    profileUrl: `/${row.username}`,
    viewerFollows: row.viewer_follows === true,
    followsViewer: row.follows_viewer === true,
    relationship,
  };
}

function compactUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: row.display_name,
    avatarUrl: mediaUrl(row.avatar_path) || DEFAULT_AVATAR,
    isVerified: Boolean(row.is_verified),
    isAdmin: row.role === 'admin',
    isOfficial: row.is_official === true,
    profileUrl: `/${row.username}`,
  };
}

function media(item) {
  return {
    id: Number(item.id),
    kind: item.kind,
    url: mediaUrl(item.key || item.storage_key),
    mime: item.mime || item.mime_type || '',
    alt: item.alt || item.alt_text || '',
    isVideo: item.kind === 'video',
  };
}

function tweet(row, { viewerId = null, bestThreshold = Number.POSITIVE_INFINITY, now = new Date() } = {}) {
  if (!row) return null;
  const engagement =
    Number(row.favorite_count || 0) + Number(row.retweet_count || 0) * 2 + Number(row.reply_count || 0);
  const attachments = Array.isArray(row.media) ? row.media.map(media) : [];
  return {
    id: Number(row.id),
    body: row.body,
    html: text.renderTweetHtml(row.body),
    snippet: text.plainSnippet(row.body),
    createdAt: row.created_at,
    timeShort: format.shortTimestamp(row.created_at, now),
    timeLong: format.longTimestamp(row.created_at),
    timeIso: format.isoDate(row.created_at),
    author: {
      id: Number(row.user_id),
      username: String(row.author_username),
      displayName: row.author_display_name,
      avatarUrl: mediaUrl(row.author_avatar_path) || DEFAULT_AVATAR,
      isVerified: Boolean(row.author_is_verified),
      isAdmin: row.author_is_admin === true,
      isOfficial: row.author_is_official === true,
      isProtected: Boolean(row.author_is_protected),
      isAutomated: Boolean(row.author_is_automated),
      profileUrl: `/${row.author_username}`,
    },
    permalink: `/${row.author_username}/status/${row.id}`,
    absoluteUrl: `${config.baseUrl}/${row.author_username}/status/${row.id}`,
    replyTo: row.reply_to_username
      ? { username: String(row.reply_to_username), tweetId: Number(row.in_reply_to_tweet_id) }
      : null,
    isReply: Boolean(row.in_reply_to_tweet_id),
    // How far under the focused Tweet this reply sits, on a permalink page.
    // Zero everywhere else, and capped by the view, not here.
    threadDepth: Number(row.thread_depth || 0),
    counts: {
      replies: Number(row.reply_count || 0),
      retweets: Number(row.retweet_count || 0),
      favorites: Number(row.favorite_count || 0),
      quotes: Number(row.quote_count || 0),
    },
    // The Tweet this one quotes, rendered as a card inside it. One level
    // only - a quote of a quote shows the card it points at, no deeper.
    quoted: row.quoted_row ? tweet(row.quoted_row, { viewerId, now }) : null,
    // It was quoted, but the original is deleted or out of view.
    quotedUnavailable: Boolean(row.quoted_tweet_id && !row.quoted_row),
    engagement,
    // Only a profile owner's own Tweets are enlarged, never a retweet.
    isBest: engagement >= bestThreshold && !row.retweeter_username,
    isPinned: row.is_pinned === true,
    viewerFavorited: row.viewer_favorited === true,
    viewerRetweeted: row.viewer_retweeted === true,
    isOwn: viewerId != null && Number(viewerId) === Number(row.user_id),
    retweetedBy: row.retweeter_username
      ? { username: String(row.retweeter_username), displayName: row.retweeter_display_name }
      : null,
    media: attachments,
    hasMedia: attachments.length > 0,
  };
}

function tweets(rows, options = {}) {
  const now = new Date();
  return (rows || []).map((row) => tweet(row, { ...options, now }));
}

function notification(row, options = {}) {
  return {
    id: Number(row.id),
    type: row.type,
    createdAt: row.created_at,
    timeShort: format.shortTimestamp(row.created_at),
    timeIso: format.isoDate(row.created_at),
    isUnread: !row.read_at,
    actor: {
      id: Number(row.actor_id),
      username: String(row.actor_username),
      displayName: row.actor_display_name,
      avatarUrl: mediaUrl(row.actor_avatar_path) || DEFAULT_AVATAR,
      isVerified: Boolean(row.actor_is_verified),
      isAdmin: row.actor_is_admin === true,
      isOfficial: row.actor_is_official === true,
      bio: row.actor_bio || '',
      profileUrl: `/${row.actor_username}`,
    },
    viewerFollowsActor: row.viewer_follows_actor === true,
    tweet: row.tweet ? tweet(row.tweet, options) : null,
  };
}

function conversationSummary(row, viewerId) {
  return {
    id: Number(row.id),
    other: {
      id: Number(row.other_id),
      username: String(row.other_username),
      displayName: row.other_display_name,
      avatarUrl: mediaUrl(row.other_avatar_path) || DEFAULT_AVATAR,
      isVerified: Boolean(row.other_is_verified),
      isAdmin: row.other_is_admin === true,
      isOfficial: row.other_is_official === true,
      profileUrl: `/${row.other_username}`,
    },
    lastBody: row.last_has_media && !row.last_body ? 'Sent a photo' : text.plainSnippet(row.last_body || '', 80),
    lastFromViewer: Number(row.last_sender_id) === Number(viewerId),
    unreadCount: Number(row.unread_count || 0),
    timeShort: format.shortTimestamp(row.last_message_at),
    timeIso: format.isoDate(row.last_message_at),
    url: `/messages/${row.id}`,
  };
}

function message(row, viewerId) {
  return {
    id: Number(row.id),
    body: row.body,
    html: row.body ? text.renderTweetHtml(row.body) : '',
    createdAt: row.created_at,
    timeShort: format.shortTimestamp(row.created_at),
    timeLong: format.longTimestamp(row.created_at),
    timeIso: format.isoDate(row.created_at),
    isOwn: Number(row.sender_id) === Number(viewerId),
    sender: {
      id: Number(row.sender_id),
      username: String(row.sender_username),
      displayName: row.sender_display_name,
      avatarUrl: mediaUrl(row.sender_avatar_path) || DEFAULT_AVATAR,
      profileUrl: `/${row.sender_username}`,
    },
    media: row.media_id
      ? media({ id: row.media_id, kind: row.media_kind, key: row.media_key })
      : null,
    sharedTweetId: row.shared_tweet_id ? Number(row.shared_tweet_id) : null,
  };
}

function list(row) {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description || '',
    isPrivate: Boolean(row.is_private),
    memberCount: Number(row.member_count || 0),
    ownerUsername: row.owner_username ? String(row.owner_username) : null,
    ownerDisplayName: row.owner_display_name || null,
    ownerAvatarUrl: mediaUrl(row.owner_avatar_path) || DEFAULT_AVATAR,
    url: `/lists/${row.id}`,
    createdAt: row.created_at,
  };
}

function mediaThumb(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    url: mediaUrl(row.storage_key),
    alt: row.alt_text || '',
    tweetUrl: `/${row.username}/status/${row.tweet_id}`,
    isVideo: row.kind === 'video',
  };
}

module.exports = {
  DEFAULT_AVATAR,
  DEFAULT_HEADER,
  mediaUrl,
  user,
  compactUser,
  tweet,
  tweets,
  media,
  mediaThumb,
  notification,
  conversationSummary,
  message,
  list,
};
