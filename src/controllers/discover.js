'use strict';

const config = require('../config/env');
const tweetModel = require('../models/tweet');
const present = require('../services/present');
const sidebar = require('../services/sidebar');
const suggest = require('../services/suggest');
const trendsService = require('../services/trends');

/** GET /discover - trending tags, popular Tweets and people to follow. */
exports.index = async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  const [popular, suggestions, trends, side] = await Promise.all([
    tweetModel.popularTimeline({ viewerId, limit: 12 }),
    suggest.suggestions(viewerId, { limit: 9 }),
    trendsService.forScope({ limit: 10 }),
    req.user ? sidebar.build(req) : Promise.resolve(null),
  ]);

  return res.render('discover/index', {
    title: `Discover | ${config.brand.name}`,
    description: `Find new accounts, trends and the Tweets people are talking about on ${config.brand.name}.`,
    canonical: `${config.baseUrl}/discover`,
    nav: 'discover',
    bodyClass: 'page-discover',
    popular: present.tweets(popular.items, { viewerId }),
    suggestions: suggestions.map((row) => ({
      ...present.compactUser(row),
      bio: row.bio || '',
      mutualCount: Number(row.mutual_count || 0),
      mutualNames: (row.mutual_names || []).filter(Boolean),
    })),
    trends,
    side,
  });
};
