'use strict';

const present = require('./present');
const trendsService = require('./trends');
const suggestService = require('./suggest');
const userModel = require('../models/user');

/**
 * The left column that every signed-in page shares: mini profile,
 * Who to follow and Trends.
 */
async function build(req, { whoToFollowPage = 0, whoToFollowLimit = 3 } = {}) {
  const viewer = req.user;
  const settings = viewer ? await userModel.getSettings(viewer.id) : null;
  const scope = {
    type: settings ? settings.trend_scope_type : 'global',
    name: settings ? settings.trend_scope_name : 'Worldwide',
  };

  const [suggestions, trends, scopes] = await Promise.all([
    suggestService.whoToFollow(viewer ? viewer.id : null, {
      limit: whoToFollowLimit,
      page: whoToFollowPage,
    }),
    trendsService.forScope({ scopeType: scope.type, scopeName: scope.name, limit: 10 }),
    trendsService.scopes(),
  ]);

  return {
    viewer: viewer ? present.user(viewer) : null,
    whoToFollow: suggestions.map((row) => ({
      ...present.compactUser(row),
      bio: row.bio || '',
      mutualCount: Number(row.mutual_count || 0),
      mutualNames: (row.mutual_names || []).filter(Boolean),
    })),
    whoToFollowPage,
    trends,
    trendScope: scope,
    trendScopes: scopes,
  };
}

module.exports = { build };
