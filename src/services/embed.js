'use strict';

/**
 * Link-preview metadata.
 *
 * When a Twiq URL is pasted into a chat client, that client fetches the page
 * and renders a card from its metadata. Open Graph alone gives a small, dull
 * one, so each page also declares a Twitter card type, a theme colour for
 * the stripe most clients draw down the side, and an oEmbed endpoint.
 *
 * oEmbed is what buys the two small lines above the card title: clients read
 * `author_name` and `provider_name` from it. That is where the engagement
 * summary goes, since there is nowhere in Open Graph to put it.
 */

const config = require('../config/env');

const absolute = (path) => (path ? `${config.baseUrl}${path}` : null);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3 replies · 12 Retweets · 300 Favorites", trimmed of the empty parts. */
function engagementLine(counts) {
  const parts = [];
  if (counts.replies > 0) parts.push(plural(counts.replies, 'reply', 'replies'));
  if (counts.retweets > 0) parts.push(plural(counts.retweets, 'Retweet', 'Retweets'));
  if (counts.favorites > 0) parts.push(plural(counts.favorites, 'Favorite', 'Favorites'));
  if (counts.quotes > 0) parts.push(plural(counts.quotes, 'quote', 'quotes'));
  return parts.join('  ·  ');
}

function byline(author) {
  return `${author.displayName} (@${author.username})`;
}

/**
 * A Tweet's card. The title is the author and the description is what they
 * actually wrote - the other way round reads as a headline nobody chose.
 */
function forTweet(tweet) {
  const photo = tweet.media.find((item) => !item.isVideo) || null;
  const video = tweet.media.find((item) => item.isVideo) || null;

  return {
    card: video ? 'player' : photo ? 'summary_large_image' : 'summary',
    title: byline(tweet.author),
    description: tweet.snippet || `A Tweet by @${tweet.author.username}`,
    url: tweet.absoluteUrl,
    image: photo
      ? { url: absolute(photo.url), alt: photo.alt || `Photo attached to a Tweet by @${tweet.author.username}` }
      : { url: absolute(tweet.author.avatarUrl), alt: `@${tweet.author.username}` },
    video: video ? { url: absolute(video.url), mime: video.mime || 'video/mp4' } : null,
    // Shown by clients that read oEmbed; there is no Open Graph field for it.
    provider: engagementLine(tweet.counts),
    author: byline(tweet.author),
    authorUrl: absolute(tweet.author.profileUrl),
    oembed: `${config.baseUrl}/oembed?url=${encodeURIComponent(tweet.absoluteUrl)}`,
  };
}

/** A profile's card: the avatar, the bio, and what the account amounts to. */
function forProfile(profile) {
  const counts = profile.counts || {};
  const summary = [
    plural(counts.tweets || 0, 'Tweet', 'Tweets'),
    plural(counts.followers || 0, 'follower', 'followers'),
  ].join('  ·  ');

  return {
    card: 'summary',
    title: byline(profile),
    description: profile.bio || `${profile.displayName} is on ${config.brand.name}.`,
    url: absolute(profile.profileUrl),
    image: { url: absolute(profile.avatarUrl), alt: `@${profile.username}` },
    video: null,
    provider: summary,
    author: byline(profile),
    authorUrl: absolute(profile.profileUrl),
    oembed: `${config.baseUrl}/oembed?url=${encodeURIComponent(absolute(profile.profileUrl))}`,
  };
}

module.exports = { forTweet, forProfile, engagementLine, absolute };
