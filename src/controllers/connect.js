'use strict';

const config = require('../config/env');
const notificationModel = require('../models/notification');
const present = require('../services/present');
const sidebar = require('../services/sidebar');
const { decodeCursor, encodeCursor } = require('../utils/cursor');

/** GET /connect (and /notifications, which redirects here). */
exports.index = async (req, res) => {
  const filter = req.query.filter === 'mentions' ? 'mentions' : 'all';
  const cursor = decodeCursor(req.query.cursor);
  const page = await notificationModel.list(req.user.id, { filter, cursor, limit: 25 });
  const items = page.items.map((row) => present.notification(row, { viewerId: req.user.id }));
  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null;

  if (req.query.partial === '1') {
    return res.render('partials/notification-items', {
      layout: false,
      notifications: items,
      nextCursor,
      timelineUrl: `/connect?filter=${filter}`,
    });
  }

  if (!cursor) await notificationModel.markAllRead(req.user.id);

  const side = await sidebar.build(req);
  return res.render('notifications/index', {
    title: `Connect | ${config.brand.name}`,
    nav: 'connect',
    noindex: true,
    bodyClass: 'page-connect',
    notifications: items,
    filter,
    nextCursor,
    timelineUrl: `/connect?filter=${filter}`,
    side,
  });
};

/** Small JSON poll for the unread badge. */
exports.unreadCount = async (req, res) => {
  const count = await notificationModel.unreadCount(req.user.id);
  return res.json({ count });
};
