'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const userModel = require('../models/user');
const tokenModel = require('../models/token');
const moderation = require('../models/moderation');
const password = require('../services/password');
const mailer = require('../services/mailer');
const schemas = require('../validators/schemas');
const { badRequest, tooMany } = require('../utils/errors');

const MAX_FAILURES = 8;

function renderRegister(res, { values = {}, errors = null, status = 200, closed = false } = {}) {
  return res.status(status).render('auth/register', {
    layout: 'layouts/minimal',
    title: `Sign up | ${config.brand.name}`,
    description: `Join ${config.brand.name} - ${config.brand.tagline}`,
    bodyClass: 'page-auth',
    values,
    errors,
    closed,
  });
}

function renderLogin(res, { values = {}, errors = null, status = 200, redirect = '' } = {}) {
  return res.status(status).render('auth/login', {
    layout: 'layouts/minimal',
    title: `Sign in | ${config.brand.name}`,
    description: `Sign in to ${config.brand.name}.`,
    bodyClass: 'page-auth',
    values,
    errors,
    redirect,
  });
}

/** Only same-origin relative paths are ever used as a post-login redirect. */
function safeRedirect(target, fallback = '/home') {
  if (typeof target !== 'string' || target.length === 0) return fallback;
  if (!target.startsWith('/') || target.startsWith('//')) return fallback;
  if (target.startsWith('/login') || target.startsWith('/register')) return fallback;
  return target;
}

exports.showRegister = (req, res) => {
  // Sign-ups can be closed from the control panel; show that rather than a
  // form that will refuse whatever is typed into it.
  if (!config.features.registration || res.locals.registrationEnabled === false) {
    return renderRegister(res, { status: 403, closed: true });
  }
  return renderRegister(res, { values: {} });
};

exports.register = async (req, res) => {
  // The control panel can close sign-ups without a redeploy; the environment
  // flag remains the hard switch underneath it.
  if (!config.features.registration || res.locals.registrationEnabled === false) {
    return renderRegister(res, { status: 403, closed: true });
  }
  if (req.validationErrors) {
    return renderRegister(res, { status: 400, values: req.body, errors: req.validationErrors });
  }

  const { username, display_name: displayName, email, password: plain } = req.valid;

  const [usernameTaken, emailTaken] = await Promise.all([
    userModel.usernameTaken(username),
    userModel.emailTaken(email),
  ]);
  if (usernameTaken || emailTaken) {
    return renderRegister(res, {
      status: 409,
      values: { username, display_name: displayName, email },
      errors: {
        fields: {
          ...(usernameTaken ? { username: 'That username is already taken.' } : {}),
          ...(emailTaken ? { email: 'That email address is already registered.' } : {}),
        },
        messages: [
          ...(usernameTaken ? ['That username is already taken.'] : []),
          ...(emailTaken ? ['That email address is already registered.'] : []),
        ],
      },
    });
  }

  const created = await userModel.create({ username, displayName, email, plainPassword: plain });
  logger.info({ userId: created.id, username: created.username }, 'account created');
  await moderation.audit({
    actorId: created.id,
    action: 'account.register',
    targetType: 'user',
    targetId: created.id,
    ip: req.ip,
  });

  const token = await tokenModel.createEmailVerification(created.id, email);
  await mailer.sendEmailVerification({ username: created.username, email }, token);

  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err }, 'session regeneration failed after registration');
      return res.redirect('/login');
    }
    req.session.userId = created.id;
    req.flash('success', `Welcome to ${config.brand.name}, @${created.username}. Check your email to confirm your address.`);
    return req.session.save(() => res.redirect('/home'));
  });
  return undefined;
};

exports.showLogin = (req, res) =>
  renderLogin(res, { redirect: safeRedirect(req.query.redirect, '') });

exports.login = async (req, res) => {
  const redirect = safeRedirect(req.body.redirect || req.query.redirect, '/home');
  if (req.validationErrors) {
    return renderLogin(res, {
      status: 400,
      values: { identifier: req.body.identifier },
      errors: req.validationErrors,
      redirect,
    });
  }
  const { identifier, password: plain, remember } = req.valid;

  const failures = await userModel.recentFailures(identifier);
  if (failures >= MAX_FAILURES) {
    await userModel.recordLoginAttempt({ identifier, ip: req.ip, succeeded: false });
    logger.warn({ identifier, ip: req.ip }, 'login blocked: too many recent failures');
    throw tooMany('Too many failed sign-in attempts for this account. Please wait 15 minutes.');
  }

  const account = await userModel.findForAuth(identifier);
  // Unknown accounts still burn a hash verification so timing does not leak.
  const ok = account
    ? await password.verify(account.password_hash, plain)
    : await password.fakeVerify(plain);

  if (!ok || !account) {
    await userModel.recordLoginAttempt({ identifier, ip: req.ip, succeeded: false });
    logger.warn({ identifier, ip: req.ip }, 'failed sign-in');
    return renderLogin(res, {
      status: 401,
      values: { identifier },
      errors: { messages: ['The username, email or password you entered is incorrect.'], fields: {} },
      redirect,
    });
  }

  if (account.is_suspended) {
    await userModel.recordLoginAttempt({ identifier, ip: req.ip, succeeded: false });
    return renderLogin(res, {
      status: 403,
      values: { identifier },
      errors: {
        messages: [
          account.suspended_reason
            ? `This account is suspended: ${account.suspended_reason}`
            : 'This account is suspended.',
        ],
        fields: {},
      },
      redirect,
    });
  }

  await userModel.recordLoginAttempt({ identifier, ip: req.ip, succeeded: true });
  await userModel.markLogin(account.id);

  const returnTo = safeRedirect(req.session.returnTo, redirect);
  return req.session.regenerate((err) => {
    if (err) {
      logger.error({ err }, 'session regeneration failed at login');
      return res.redirect('/login');
    }
    req.session.userId = account.id;
    if (remember) {
      req.session.cookie.maxAge = config.session.ttlHours * 60 * 60 * 1000;
    } else {
      req.session.cookie.expires = false; // browser-session cookie
    }
    logger.info({ userId: account.id, username: account.username }, 'sign-in');
    return req.session.save(() => res.redirect(returnTo));
  });
};

exports.logout = (req, res) => {
  const userId = req.user && req.user.id;
  req.session.destroy((err) => {
    if (err) logger.error({ err }, 'failed to destroy session on logout');
    res.clearCookie(config.session.name);
    if (userId) logger.info({ userId }, 'sign-out');
    res.redirect('/');
  });
};

exports.showForgotPassword = (req, res) =>
  res.render('auth/forgot-password', {
    layout: 'layouts/minimal',
    title: `Reset your password | ${config.brand.name}`,
    bodyClass: 'page-auth',
    sent: false,
    errors: null,
  });

exports.requestPasswordReset = async (req, res) => {
  const parsed = schemas.passwordResetRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('auth/forgot-password', {
      layout: 'layouts/minimal',
      title: `Reset your password | ${config.brand.name}`,
      bodyClass: 'page-auth',
      sent: false,
      errors: schemas.formatErrors(parsed.error),
    });
  }
  const account = await userModel.findForAuth(parsed.data.identifier);
  if (account) {
    const token = await tokenModel.createPasswordReset(account.id);
    await mailer.sendPasswordReset(account, token);
    logger.info({ userId: account.id }, 'password reset requested');
  } else {
    logger.info({ ip: req.ip }, 'password reset requested for unknown account');
  }
  // The same response either way, so the form cannot enumerate accounts.
  return res.render('auth/forgot-password', {
    layout: 'layouts/minimal',
    title: `Reset your password | ${config.brand.name}`,
    bodyClass: 'page-auth',
    sent: true,
    errors: null,
  });
};

exports.showResetPassword = (req, res) =>
  res.render('auth/reset-password', {
    layout: 'layouts/minimal',
    title: `Choose a new password | ${config.brand.name}`,
    bodyClass: 'page-auth',
    token: String(req.query.token || ''),
    errors: null,
  });

exports.resetPassword = async (req, res) => {
  const parsed = schemas.passwordResetComplete.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('auth/reset-password', {
      layout: 'layouts/minimal',
      title: `Choose a new password | ${config.brand.name}`,
      bodyClass: 'page-auth',
      token: String(req.body.token || ''),
      errors: schemas.formatErrors(parsed.error),
    });
  }
  const userId = await tokenModel.consumePasswordReset(parsed.data.token);
  if (!userId) {
    return res.status(400).render('auth/reset-password', {
      layout: 'layouts/minimal',
      title: `Choose a new password | ${config.brand.name}`,
      bodyClass: 'page-auth',
      token: '',
      errors: { messages: ['That reset link has expired or has already been used.'], fields: {} },
    });
  }
  await userModel.changePassword(userId, parsed.data.password);
  await moderation.audit({ actorId: userId, action: 'account.password_reset', targetType: 'user', targetId: userId, ip: req.ip });
  logger.info({ userId }, 'password reset completed');
  req.flash('success', 'Your password has been changed. You can sign in now.');
  return res.redirect('/login');
};

exports.verifyEmail = async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) throw badRequest('That confirmation link is not valid.');
  const result = await tokenModel.consumeEmailVerification(token);
  if (!result) {
    req.flash('error', 'That confirmation link has expired or has already been used.');
    return res.redirect(req.user ? '/settings/account' : '/login');
  }
  req.flash('success', 'Your email address is confirmed.');
  return res.redirect(req.user ? '/settings/account' : '/login');
};

exports.safeRedirect = safeRedirect;
