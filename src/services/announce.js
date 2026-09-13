'use strict';

/**
 * Who to nudge after something happens.
 *
 * The same events reach Twiq down two roads - the form posts in
 * controllers/tweets.js and the JSON API in controllers/api.js - and they
 * had drifted: a Tweet written through the API told nobody at all. Both now
 * call in here, so there is one answer to "who hears about this".
 *
 * Everything sent is a hint. No counts and no content travel over the
 * socket; a client that receives one asks the server what changed.
 */

const realtime = require('./realtime');
const tweetModel = require('../models/tweet');

/** Everyone the Tweet raised a notification for - reply, quote or mention. */
async function notifyMentioned(tweetId, actorId) {
  for (const userId of await tweetModel.notifiedBy(tweetId)) {
    if (Number(userId) !== Number(actorId)) realtime.publish(userId, { type: 'notification' });
  }
}

/**
 * Tell followers their timeline has moved on.
 *
 * The follower list can be long, so ask the socket who is actually
 * connected first: the query then only considers people who could receive
 * anything, and it drops anyone who has muted or blocked the author.
 */
async function notifyFollowers(authorId, username) {
  const listening = realtime.connectedUserIds();
  if (listening.length === 0) return 0;
  const followers = await tweetModel.followersAmong(authorId, listening);
  for (const followerId of followers) {
    realtime.publish(followerId, { type: 'timeline', from: username });
  }
  return followers.length;
}

/** A new Tweet: its mentions hear about it, and the author's followers do. */
async function tweetCreated({ tweetId, authorId, username }) {
  await notifyMentioned(tweetId, authorId);
  await notifyFollowers(authorId, username);
}

/** A retweet puts the Tweet into the retweeter's followers' timelines too. */
async function retweeted({ userId, username, notifyUserId }) {
  if (notifyUserId) realtime.publish(notifyUserId, { type: 'notification' });
  await notifyFollowers(userId, username);
}

module.exports = { tweetCreated, retweeted, notifyMentioned, notifyFollowers };
