'use strict';

/**
 * GET /instance - what this installation is, and who is responsible for it.
 *
 * Public on purpose: someone deciding whether to sign up should be able to
 * see who runs the place, how it is configured and what the rules are
 * without making an account first. Everything here is either configuration
 * or a count of public rows - no e-mail addresses, and none of the
 * moderation figures the control panel shows.
 */

const pkg = require('../../package.json');
const config = require('../config/env');
const instanceModel = require('../models/instance');
const present = require('../services/present');
const settingsService = require('../services/settings');
const format = require('../utils/format');

const megabytes = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

exports.show = async (req, res) => {
  const [stats, staffRows, settings] = await Promise.all([
    instanceModel.publicStats(),
    instanceModel.staff(),
    settingsService.all(),
  ]);

  const people = staffRows.map((row) => ({
    ...present.compactUser(row),
    bio: row.bio || '',
    role: row.role,
    isOfficial: row.is_official === true,
  }));

  return res.render('instance/index', {
    title: `About this ${config.brand.name} instance | ${config.brand.name}`,
    description:
      `Who runs this ${config.brand.name} instance, how it is configured, and how big it is.`,
    canonical: `${config.baseUrl}/instance`,
    nav: null,
    bodyClass: 'page-instance',
    stats: {
      accounts: format.fullCount(stats.accounts),
      tweets: format.fullCount(stats.tweets),
      uploads: format.fullCount(stats.uploads),
      activeThisWeek: format.fullCount(stats.active_this_week),
      opened: stats.opened ? format.joinedDate(stats.opened) : null,
    },
    official: people.find((person) => person.isOfficial) || null,
    staff: people.filter((person) => !person.isOfficial),
    // Only the settings that change what a member can actually do here.
    setup: {
      registrationOpen: Boolean(settings.registration_open),
      readOnly: Boolean(settings.read_only),
      tweetMaxLength: config.brand.tweetMaxLength,
      bioMaxLength: config.brand.bioMaxLength,
      uploadMaxSize: megabytes(config.uploads.maxSize),
      liveUpdates: Boolean(config.features.websockets),
      statusUrl: settings.status_url || settingsService.DEFAULTS.status_url,
    },
    software: {
      name: config.brand.name,
      version: pkg.version,
      license: pkg.license,
      source: (pkg.repository && pkg.repository.url) || null,
      node: process.version,
    },
  });
};
