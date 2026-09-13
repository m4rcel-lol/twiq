'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const userModel = require('../models/user');
const graphModel = require('../models/graph');
const moderation = require('../models/moderation');
const tokenModel = require('../models/token');
const present = require('../services/present');
const storage = require('../services/storage');
const mailer = require('../services/mailer');
const passwordService = require('../services/password');
const schemas = require('../validators/schemas');
const { badRequest, forbidden } = require('../utils/errors');

const SECTIONS = [
  { key: 'account', label: 'Account', href: '/settings/account' },
  { key: 'profile', label: 'Profile', href: '/settings/profile' },
  { key: 'password', label: 'Password', href: '/settings/password' },
  { key: 'privacy', label: 'Security and privacy', href: '/settings/privacy' },
  { key: 'notifications', label: 'Notifications', href: '/settings/notifications' },
  { key: 'design', label: 'Design', href: '/settings/design' },
  { key: 'automation', label: 'Automation', href: '/settings/automation' },
  { key: 'blocked', label: 'Blocked accounts', href: '/settings/blocked' },
  { key: 'muted', label: 'Muted accounts', href: '/settings/muted' },
];

function renderSection(res, section, view, extra = {}) {
  return res.render(`settings/${view}`, {
    title: `${SECTIONS.find((s) => s.key === section).label} | ${config.brand.name}`,
    nav: null,
    noindex: true,
    bodyClass: 'page-settings',
    sections: SECTIONS,
    section,
    errors: null,
    ...extra,
  });
}

exports.index = (req, res) => res.redirect('/settings/account');

/* ------------------------------------------------------------------------
   Automation
   ------------------------------------------------------------------------
   An account can name the person who runs it, and that name is then shown
   beside its Tweets and on its profile. Anyone could otherwise pin the
   label on a stranger, so the claim is only accepted when whoever sets it
   can supply the named account's own password - the same proof signing in
   would need.
   ------------------------------------------------------------------------ */

exports.automation = async (req, res) => {
  const me = await userModel.findById(req.user.id);
  return renderSection(res, 'automation', 'automation', {
    automatedBy: me.automated_by_username || null,
  });
};

exports.updateAutomation = async (req, res) => {
  const parsed = schemas.automationUpdate.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/automation');
  }
  const { username, password } = parsed.data;

  const operator = await userModel.findForAuth(username);
  // An unknown name still burns a verification, so a wrong guess cannot be
  // told apart from a right name with a wrong password.
  const ok = operator
    ? await passwordService.verify(operator.password_hash, password)
    : await passwordService.fakeVerify(password);

  if (!ok || !operator) {
    logger.warn({ userId: req.user.id, username }, 'automation claim refused');
    req.flash('error', 'That username and password did not match an account.');
    return res.redirect('/settings/automation');
  }
  if (Number(operator.id) === Number(req.user.id)) {
    req.flash('error', 'An account cannot be automated by itself.');
    return res.redirect('/settings/automation');
  }
  if (operator.is_suspended) {
    req.flash('error', 'That account is suspended.');
    return res.redirect('/settings/automation');
  }

  await userModel.setAutomatedBy(req.user.id, operator.id);
  logger.info({ userId: req.user.id, operatorId: operator.id }, 'account marked automated');
  req.flash('success', `This account is now labelled as automated by @${operator.username}.`);
  return res.redirect('/settings/automation');
};

/** Removing the label needs no proof: leaving is always allowed. */
exports.clearAutomation = async (req, res) => {
  await userModel.setAutomatedBy(req.user.id, null);
  logger.info({ userId: req.user.id }, 'automation label removed');
  req.flash('success', 'This account is no longer labelled as automated.');
  return res.redirect('/settings/automation');
};

exports.account = async (req, res) => {
  const [settings, user] = await Promise.all([
    userModel.getSettings(req.user.id),
    userModel.findById(req.user.id),
  ]);
  return renderSection(res, 'account', 'account', {
    settings,
    account: { ...present.user(user), email: user.email, emailVerified: Boolean(user.email_verified_at) },
  });
};

exports.updateAccount = async (req, res) => {
  const parsed = schemas.accountUpdate.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/account');
  }
  const { username, email, is_protected: isProtected, language, timezone } = parsed.data;

  if (username !== String(req.user.username).toLowerCase()) {
    if (await userModel.usernameTaken(username)) {
      req.flash('error', 'That username is already taken.');
      return res.redirect('/settings/account');
    }
    await userModel.updateProfile(req.user.id, {});
    await require('../config/db').query(
      'UPDATE users SET username = $2, updated_at = now() WHERE id = $1',
      [req.user.id, username]
    );
    await moderation.audit({
      actorId: req.user.id,
      action: 'account.username_change',
      targetType: 'user',
      targetId: req.user.id,
      metadata: { from: String(req.user.username), to: username },
      ip: req.ip,
    });
  }

  if (email !== String(req.user.email).toLowerCase()) {
    await userModel.updateEmail(req.user.id, email);
    const token = await tokenModel.createEmailVerification(req.user.id, email);
    await mailer.sendEmailVerification({ username, email }, token);
    req.flash('success', 'Check your new email address to confirm the change.');
  }

  await userModel.updateProfile(req.user.id, { is_protected: Boolean(isProtected) });
  await userModel.updateSettings(req.user.id, { language, timezone });
  req.flash('success', 'Your account settings were saved.');
  return res.redirect('/settings/account');
};

exports.resendVerification = async (req, res) => {
  const user = await userModel.findById(req.user.id);
  if (user.email_verified_at) {
    req.flash('success', 'That address is already confirmed.');
    return res.redirect('/settings/account');
  }
  const token = await tokenModel.createEmailVerification(user.id, user.email);
  await mailer.sendEmailVerification(user, token);
  req.flash('success', 'We sent another confirmation email.');
  return res.redirect('/settings/account');
};

exports.profile = async (req, res) => {
  const user = await userModel.findById(req.user.id);
  return renderSection(res, 'profile', 'profile', { profile: present.user(user) });
};

exports.updateProfile = async (req, res) => {
  const parsed = schemas.profileUpdate.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/profile');
  }
  await userModel.updateProfile(req.user.id, {
    display_name: parsed.data.display_name,
    bio: parsed.data.bio,
    location: parsed.data.location,
    website: parsed.data.website,
  });
  req.flash('success', 'Your profile was saved.');
  return res.redirect('/settings/profile');
};

async function replaceImage(req, kind) {
  if (!req.file) throw badRequest('Choose an image to upload.');
  const info = storage.validateUpload(req.file.buffer, req.file.mimetype, { videos: false });
  const key = await storage.save(req.file.buffer, { prefix: kind, ext: info.ext });
  const previous =
    kind === 'avatar' ? await userModel.setAvatar(req.user.id, key) : await userModel.setHeader(req.user.id, key);
  if (previous) await storage.remove(previous);
  logger.info({ userId: req.user.id, kind }, 'profile image updated');
}

exports.updateAvatar = async (req, res) => {
  await replaceImage(req, 'avatar');
  req.flash('success', 'Your profile photo was updated.');
  return res.redirect('/settings/profile');
};

exports.updateHeader = async (req, res) => {
  await replaceImage(req, 'header');
  req.flash('success', 'Your header image was updated.');
  return res.redirect('/settings/profile');
};

exports.removeHeader = async (req, res) => {
  const previous = await userModel.setHeader(req.user.id, null);
  if (previous) await storage.remove(previous);
  req.flash('success', 'Your header image was removed.');
  return res.redirect('/settings/profile');
};

exports.password = (req, res) => renderSection(res, 'password', 'password', {});

exports.updatePassword = async (req, res) => {
  const parsed = schemas.passwordChange.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/password');
  }
  const hash = await userModel.getPasswordHash(req.user.id);
  if (!(await passwordService.verify(hash, parsed.data.current_password))) {
    logger.warn({ userId: req.user.id }, 'password change rejected: wrong current password');
    req.flash('error', 'Your current password is not correct.');
    return res.redirect('/settings/password');
  }
  await userModel.changePassword(req.user.id, parsed.data.new_password);
  await moderation.audit({
    actorId: req.user.id,
    action: 'account.password_change',
    targetType: 'user',
    targetId: req.user.id,
    ip: req.ip,
  });
  logger.info({ userId: req.user.id }, 'password changed');
  // Keep this session signed in, drop every other one.
  const userId = req.user.id;
  return req.session.regenerate((err) => {
    if (err) return res.redirect('/login');
    req.session.userId = userId;
    req.session.flash = [{ type: 'success', message: 'Your password was changed.' }];
    return req.session.save(() => res.redirect('/settings/password'));
  });
};

exports.privacy = async (req, res) => {
  const [settings, user] = await Promise.all([
    userModel.getSettings(req.user.id),
    userModel.findById(req.user.id),
  ]);
  return renderSection(res, 'privacy', 'privacy', { settings, profile: present.user(user) });
};

exports.updatePrivacy = async (req, res) => {
  const parsed = schemas.privacyUpdate.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/privacy');
  }
  await userModel.updateProfile(req.user.id, { is_protected: Boolean(parsed.data.is_protected) });
  await userModel.updateSettings(req.user.id, {
    dm_policy: parsed.data.dm_policy,
    discoverable_by_email: Boolean(parsed.data.discoverable_by_email),
    show_sensitive_media: Boolean(parsed.data.show_sensitive_media),
  });
  req.flash('success', 'Your privacy settings were saved.');
  return res.redirect('/settings/privacy');
};

exports.notifications = async (req, res) => {
  const settings = await userModel.getSettings(req.user.id);
  return renderSection(res, 'notifications', 'notifications', { settings });
};

exports.updateNotifications = async (req, res) => {
  const parsed = schemas.notificationsUpdate.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/notifications');
  }
  await userModel.updateSettings(req.user.id, {
    notify_follows: Boolean(parsed.data.notify_follows),
    notify_mentions: Boolean(parsed.data.notify_mentions),
    notify_replies: Boolean(parsed.data.notify_replies),
    notify_retweets: Boolean(parsed.data.notify_retweets),
    notify_favorites: Boolean(parsed.data.notify_favorites),
    notify_messages: Boolean(parsed.data.notify_messages),
  });
  req.flash('success', 'Your notification settings were saved.');
  return res.redirect('/settings/notifications');
};

exports.design = async (req, res) => {
  const theme = await userModel.getProfileSettings(req.user.id);
  return renderSection(res, 'design', 'design', {
    // Named `design`, not `theme`: a render local of that name overrides the
    // viewer's light/dark choice in res.locals and breaks the whole page.
    design: {
      accent: theme.accent_color,
      background: theme.background_color,
      backgroundUrl: theme.background_path ? present.mediaUrl(theme.background_path) : null,
      tile: theme.background_tile,
      mode: theme.theme || 'light',
    },
  });
};

exports.updateDesign = async (req, res) => {
  const parsed = schemas.designUpdate.safeParse(req.body);
  if (!parsed.success) {
    req.flash('error', schemas.formatErrors(parsed.error).first);
    return res.redirect('/settings/design');
  }
  const fields = {
    accent_color: parsed.data.accent_color,
    background_color: parsed.data.background_color,
    background_tile: Boolean(parsed.data.background_tile),
    theme: THEMES.includes(req.body.theme) ? req.body.theme : 'light',
  };
  if (req.file) {
    const info = storage.validateUpload(req.file.buffer, req.file.mimetype, { videos: false });
    const key = await storage.save(req.file.buffer, { prefix: 'background', ext: info.ext });
    const current = await userModel.getProfileSettings(req.user.id);
    if (current && current.background_path) await storage.remove(current.background_path);
    fields.background_path = key;
  }
  await userModel.updateProfileSettings(req.user.id, fields);
  req.flash('success', 'Your design settings were saved.');
  return res.redirect('/settings/design');
};

const THEMES = ['system', 'light', 'dark'];

/**
 * The one-click switch in the account menu. It only moves between light and
 * dark; "follow my system" stays a deliberate choice in Design settings.
 */
exports.toggleTheme = async (req, res) => {
  const current = await userModel.getProfileSettings(req.user.id);
  const next = (current && current.theme) === 'dark' ? 'light' : 'dark';
  await userModel.updateProfileSettings(req.user.id, { theme: next });
  const referer = req.get('referer');
  const back = referer && referer.startsWith(config.baseUrl)
    ? referer.slice(config.baseUrl.length) || '/home'
    : '/home';
  return res.redirect(back);
};

exports.removeBackground = async (req, res) => {
  const current = await userModel.getProfileSettings(req.user.id);
  if (current && current.background_path) await storage.remove(current.background_path);
  await userModel.updateProfileSettings(req.user.id, { background_path: null });
  req.flash('success', 'Your background image was removed.');
  return res.redirect('/settings/design');
};

exports.blocked = async (req, res) => {
  const rows = await graphModel.blockedUsers(req.user.id);
  return renderSection(res, 'blocked', 'people', {
    people: rows.map((row) => present.user(row)),
    emptyMessage: 'You have not blocked anybody.',
    actionLabel: 'Unblock',
    actionPath: (username) => `/${username}/unblock`,
  });
};

exports.muted = async (req, res) => {
  const rows = await graphModel.mutedUsers(req.user.id);
  return renderSection(res, 'muted', 'people', {
    people: rows.map((row) => present.user(row)),
    emptyMessage: 'You have not muted anybody.',
    actionLabel: 'Unmute',
    actionPath: (username) => `/${username}/unmute`,
  });
};

/** POST /settings/account/delete - irreversible, so it asks for the password. */
exports.deleteAccount = async (req, res) => {
  const hash = await userModel.getPasswordHash(req.user.id);
  if (!(await passwordService.verify(hash, String(req.body.password || '')))) {
    throw forbidden('Enter your current password to delete your account.');
  }
  const userId = req.user.id;
  const username = String(req.user.username);
  await moderation.audit({
    actorId: userId,
    action: 'account.delete',
    targetType: 'user',
    targetId: userId,
    metadata: { username },
    ip: req.ip,
  });
  await userModel.remove(userId);
  logger.info({ userId, username }, 'account deleted by owner');
  return req.session.destroy(() => {
    res.clearCookie(config.session.name);
    res.redirect('/');
  });
};

exports.SECTIONS = SECTIONS;
