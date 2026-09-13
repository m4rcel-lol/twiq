'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const messageModel = require('../models/message');
const userModel = require('../models/user');
const tweetModel = require('../models/tweet');
const mediaModel = require('../models/media');
const present = require('../services/present');
const storage = require('../services/storage');
const realtime = require('../services/realtime');
const schemas = require('../validators/schemas');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const { wantsJson } = require('../middleware/auth');

/** GET /messages */
exports.index = async (req, res) => {
  const rows = await messageModel.conversations(req.user.id);
  const conversations = rows.map((row) => present.conversationSummary(row, req.user.id));
  return res.render('messages/index', {
    title: `Direct Messages | ${config.brand.name}`,
    nav: null,
    noindex: true,
    bodyClass: 'page-messages',
    conversations,
    conversation: null,
    messages: [],
    other: null,
    canReply: false,
    replyBlockedReason: null,
  });
};

/** GET /messages/:id */
exports.show = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound('That conversation does not exist.');
  if (!(await messageModel.isParticipant(id, req.user.id))) {
    throw forbidden('That conversation is not yours.');
  }

  const [rows, other, messageRows] = await Promise.all([
    messageModel.conversations(req.user.id),
    messageModel.otherParticipant(id, req.user.id),
    messageModel.messages(id, { limit: 50 }),
  ]);
  await messageModel.markRead(id, req.user.id);

  const permission = other
    ? await messageModel.canMessage(req.user.id, other.id)
    : { allowed: false, reason: 'That account no longer exists.' };

  return res.render('messages/index', {
    title: other ? `Direct Messages with ${other.display_name} | ${config.brand.name}` : 'Direct Messages',
    nav: null,
    noindex: true,
    // `has-thread` lets the phone layout show one pane or the other; on a
    // wide screen both are visible as before.
    bodyClass: 'page-messages has-thread',
    conversations: rows.map((row) => present.conversationSummary(row, req.user.id)),
    conversation: { id },
    messages: messageRows.map((row) => present.message(row, req.user.id)),
    other: other ? present.compactUser(other) : null,
    canReply: permission.allowed,
    replyBlockedReason: permission.allowed ? null : permission.reason,
  });
};

/** POST /messages/new - start (or reuse) a conversation with somebody. */
exports.create = async (req, res) => {
  const username = String(req.body.username || '').replace(/^@/, '').trim();
  if (!username) throw badRequest('Choose somebody to message.');
  const other = await userModel.findByUsername(username);
  if (!other) throw notFound('That account does not exist.');

  const permission = await messageModel.canMessage(req.user.id, other.id);
  if (!permission.allowed) throw forbidden(permission.reason);

  const conversationId = await messageModel.findOrCreateConversation(req.user.id, other.id);
  if (wantsJson(req)) return res.json({ conversationId, url: `/messages/${conversationId}` });
  return res.redirect(`/messages/${conversationId}`);
};

/** POST /messages/:id */
exports.send = async (req, res) => {
  const id = Number(req.params.id);
  if (!(await messageModel.isParticipant(id, req.user.id))) {
    throw forbidden('That conversation is not yours.');
  }
  const parsed = schemas.messageInput.safeParse(req.body);
  if (!parsed.success) throw badRequest(schemas.formatErrors(parsed.error).first);

  const other = await messageModel.otherParticipant(id, req.user.id);
  if (!other) throw notFound('That conversation no longer exists.');
  const permission = await messageModel.canMessage(req.user.id, other.id);
  if (!permission.allowed) throw forbidden(permission.reason);

  let mediaId = null;
  if (req.file) {
    const info = storage.validateUpload(req.file.buffer, req.file.mimetype);
    const key = await storage.save(req.file.buffer, { prefix: 'dm', ext: info.ext });
    const record = await mediaModel.create({
      userId: req.user.id,
      kind: info.kind,
      storageKey: key,
      mimeType: info.mime,
      byteSize: info.size,
    });
    mediaId = record.id;
  } else if (parsed.data.media_id) {
    const owned = await mediaModel.findOwned(parsed.data.media_id, req.user.id);
    if (owned) mediaId = owned.id;
  }

  let sharedTweetId = null;
  if (parsed.data.shared_tweet_id) {
    const tweet = await tweetModel.findRaw(parsed.data.shared_tweet_id);
    if (tweet) sharedTweetId = tweet.id;
  }

  await messageModel.send({
    conversationId: id,
    senderId: req.user.id,
    body: parsed.data.body,
    mediaId,
    sharedTweetId,
  });
  // Message contents are never logged - only that one was sent.
  logger.info({ conversationId: id, senderId: req.user.id }, 'direct message sent');
  realtime.publish(other.id, { type: 'message', conversationId: id });

  if (wantsJson(req)) {
    const rows = await messageModel.messages(id, { limit: 1 });
    return res.status(201).json({ message: rows.map((row) => present.message(row, req.user.id))[0] });
  }
  return res.redirect(`/messages/${id}`);
};

/** GET /messages/:id/poll - fetch anything newer than a known message id. */
exports.poll = async (req, res) => {
  const id = Number(req.params.id);
  if (!(await messageModel.isParticipant(id, req.user.id))) throw forbidden();
  const rows = await messageModel.messages(id, { limit: 30 });
  const sinceId = Number(req.query.since_id || 0);
  const fresh = rows.filter((row) => Number(row.id) > sinceId);
  if (fresh.length > 0) await messageModel.markRead(id, req.user.id);
  return res.json({ messages: fresh.map((row) => present.message(row, req.user.id)) });
};

/** POST /messages/:id/delete - leave the conversation. */
exports.destroy = async (req, res) => {
  const id = Number(req.params.id);
  await messageModel.leaveConversation(id, req.user.id);
  req.flash('success', 'That conversation was removed from your inbox.');
  return res.redirect('/messages');
};

/** POST /messages/:id/messages/:messageId/delete */
exports.destroyMessage = async (req, res) => {
  await messageModel.deleteMessage(Number(req.params.messageId), req.user.id);
  if (wantsJson(req)) return res.json({ deleted: true });
  return res.redirect(`/messages/${Number(req.params.id)}`);
};
