'use strict';

const config = require('../config/env');
const listModel = require('../models/list');
const userModel = require('../models/user');
const tweetModel = require('../models/tweet');
const present = require('../services/present');
const sidebar = require('../services/sidebar');
const schemas = require('../validators/schemas');
const { decodeCursor, encodeCursor } = require('../utils/cursor');
const { notFound, forbidden, badRequest } = require('../utils/errors');

/** GET /lists - your own Lists. */
exports.index = async (req, res) => {
  const rows = await listModel.forOwner(req.user.id, { viewerId: req.user.id });
  return res.render('lists/index', {
    title: `Lists | ${config.brand.name}`,
    nav: null,
    noindex: true,
    bodyClass: 'page-lists',
    lists: rows.map(present.list),
    side: await sidebar.build(req),
  });
};

exports.create = async (req, res) => {
  const parsed = schemas.listInput.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/lists');
  }
  const created = await listModel.create(req.user.id, {
    name: parsed.data.name,
    description: parsed.data.description,
    isPrivate: parsed.data.is_private,
  });
  req.flash('success', `Your List "${created.name}" was created.`);
  return res.redirect(`/lists/${created.id}`);
};

async function loadList(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound('That List does not exist.');
  const list = await listModel.findById(id);
  if (!list) throw notFound('That List does not exist.');
  const viewerId = req.user ? req.user.id : null;
  if (!listModel.canView(list, viewerId)) throw forbidden('That List is private.');
  return { list, viewerId };
}

/** GET /lists/:id - the List timeline. */
exports.show = async (req, res) => {
  const { list, viewerId } = await loadList(req);
  const cursor = decodeCursor(req.query.cursor);
  const page = await tweetModel.listTimeline(list.id, { viewerId, cursor, limit: 20 });
  const tweets = present.tweets(page.items, { viewerId });
  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.at, page.nextCursor.id) : null;
  const timelineUrl = `/lists/${list.id}`;

  if (req.query.partial === '1') {
    return res.render('partials/timeline-items', { layout: false, tweets, nextCursor, timelineUrl });
  }

  return res.render('lists/show', {
    title: `${list.name} | ${config.brand.name}`,
    description: list.description || `A Twiq List by @${list.owner_username}.`,
    canonical: `${config.baseUrl}/lists/${list.id}`,
    noindex: list.is_private,
    nav: null,
    bodyClass: 'page-lists',
    list: present.list(list),
    isOwner: viewerId != null && Number(viewerId) === Number(list.owner_id),
    tab: 'timeline',
    tweets,
    members: [],
    nextCursor,
    timelineUrl,
    side: req.user ? await sidebar.build(req) : null,
  });
};

/** GET /lists/:id/members */
exports.members = async (req, res) => {
  const { list, viewerId } = await loadList(req);
  const rows = await listModel.members(list.id, { viewerId, limit: 100 });
  return res.render('lists/show', {
    title: `${list.name} members | ${config.brand.name}`,
    noindex: list.is_private,
    nav: null,
    bodyClass: 'page-lists',
    list: present.list(list),
    isOwner: viewerId != null && Number(viewerId) === Number(list.owner_id),
    tab: 'members',
    tweets: [],
    members: rows.map((row) => present.user(row)),
    nextCursor: null,
    timelineUrl: `/lists/${list.id}`,
    side: req.user ? await sidebar.build(req) : null,
  });
};

exports.update = async (req, res) => {
  const parsed = schemas.listInput.safeParse(req.body);
  if (!parsed.success) throw badRequest(schemas.formatErrors(parsed.error).first);
  const updated = await listModel.update(Number(req.params.id), req.user.id, {
    name: parsed.data.name,
    description: parsed.data.description,
    isPrivate: parsed.data.is_private,
  });
  req.flash('success', 'Your List was updated.');
  return res.redirect(`/lists/${updated.id}`);
};

exports.destroy = async (req, res) => {
  await listModel.remove(Number(req.params.id), req.user.id);
  req.flash('success', 'That List was deleted.');
  return res.redirect('/lists');
};

exports.addMember = async (req, res) => {
  const username = String(req.body.username || '').replace(/^@/, '').trim();
  const target = await userModel.findByUsername(username);
  if (!target) throw notFound('That account does not exist.');
  await listModel.addMember(Number(req.params.id), req.user.id, target.id);
  req.flash('success', `@${target.username} was added to the List.`);
  return res.redirect(`/lists/${Number(req.params.id)}/members`);
};

exports.removeMember = async (req, res) => {
  const target = await userModel.findByUsername(String(req.params.username || ''));
  if (!target) throw notFound('That account does not exist.');
  await listModel.removeMember(Number(req.params.id), req.user.id, target.id);
  return res.redirect(`/lists/${Number(req.params.id)}/members`);
};
