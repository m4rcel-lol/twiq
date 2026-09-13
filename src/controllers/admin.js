'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const db = require('../config/db');
const userModel = require('../models/user');
const tweetModel = require('../models/tweet');
const mediaModel = require('../models/media');
const adminModel = require('../models/admin');
const moderation = require('../models/moderation');
const trendsService = require('../services/trends');
const statusModel = require('../models/status');
const settingsService = require('../services/settings');
const storage = require('../services/storage');
const present = require('../services/present');
const tokenModel = require('../models/token');
const chart = require('../utils/chart');
const format = require('../utils/format');
const schemas = require('../validators/schemas');
const { notFound, forbidden, badRequest } = require('../utils/errors');

const NAV = [
  { key: 'overview', label: 'Overview', href: '/admin' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'content', label: 'Content', href: '/admin/content' },
  { key: 'reports', label: 'Reports', href: '/admin/reports' },
  { key: 'trends', label: 'Trends', href: '/admin/trends' },
  { key: 'status', label: 'Status page', href: '/admin/status' },
  { key: 'system', label: 'System', href: '/admin/system', adminOnly: true },
  { key: 'audit', label: 'Audit log', href: '/admin/audit' },
];

function render(res, req, view, section, extra = {}) {
  const item = NAV.find((n) => n.key === section);
  return res.render(`admin/${view}`, {
    title: `${item ? item.label : 'Control panel'} | ${config.brand.name} control panel`,
    nav: null,
    noindex: true,
    bodyClass: 'page-admin',
    adminNav: NAV.filter((n) => !n.adminOnly || req.user.role === 'admin'),
    section,
    isAdmin: req.user.role === 'admin',
    ...extra,
  });
}

/** Destructive and configuration actions are administrators only. */
function requireAdmin(req) {
  if (req.user.role !== 'admin') throw forbidden('That action requires an administrator.');
}

async function audit(req, action, extra = {}) {
  await moderation.audit({ actorId: req.user.id, action, ip: req.ip, ...extra });
}

function back(req, fallback) {
  const referer = req.get('referer');
  if (referer && referer.startsWith(config.baseUrl)) return referer.slice(config.baseUrl.length) || fallback;
  return fallback;
}

// ============================================================== overview ===

exports.overview = async (req, res) => {
  const [headline, active, series, mostActive, reports, auditRows, sessions, drift, settings] =
    await Promise.all([
      adminModel.headline(),
      adminModel.activeUsers(),
      adminModel.dailySeries(30),
      adminModel.mostActive(7, 6),
      moderation.listReports({ status: 'open', limit: 6 }),
      moderation.auditLogs({ limit: 8 }),
      adminModel.sessionStats(),
      adminModel.counterDrift(),
      settingsService.all(),
    ]);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rows = series.map((row) => {
    const date = new Date(row.day);
    return {
      // Only three ticks are drawn, so they can afford a month.
      label: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
      signups: row.signups,
      tweets: row.tweets,
    };
  });

  return render(res, req, 'overview', 'overview', {
    headline,
    active,
    sessions,
    reports,
    audit: auditRows,
    mostActive: mostActive.map((row) => ({ ...row, avatarUrl: present.compactUser(row).avatarUrl })),
    driftCount: drift.length,
    settings,
    deltas: {
      users: format.delta(headline.users_7d, headline.users_prev_7d),
      tweets: format.delta(headline.tweets_7d, headline.tweets_prev_7d),
    },
    activityChart: chart.lineChart(rows, {
      x: 'label',
      series: [
        { key: 'tweets', name: 'Tweets', className: 'chart-a' },
        { key: 'signups', name: 'Signups', className: 'chart-b' },
      ],
    }),
    tweetSpark: chart.sparkline(rows.map((r) => r.tweets), { className: 'chart-a' }),
    signupSpark: chart.sparkline(rows.map((r) => r.signups), { className: 'chart-b' }),
  });
};

// ================================================================= users ===

exports.users = async (req, res) => {
  const term = String(req.query.q || '').trim();
  const role = String(req.query.role || 'any');
  const status = String(req.query.status || 'any');
  const sort = String(req.query.sort || 'created');
  const page = Math.max(0, Number(req.query.page || 0) || 0);
  const perPage = 50;

  const { rows, total } = await adminModel.searchUsers({
    term, role, status, sort, limit: perPage, offset: page * perPage,
  });

  return render(res, req, 'users', 'users', {
    users: rows,
    total,
    term,
    role,
    status,
    sort,
    page,
    perPage,
    hasMore: (page + 1) * perPage < total,
  });
};

async function loadTarget(req) {
  const target = await userModel.findByUsername(req.params.username);
  if (!target) throw notFound('That account does not exist.');
  return target;
}

exports.userDetail = async (req, res) => {
  const target = await loadTarget(req);
  const detail = await adminModel.userDetail(target.id);
  return render(res, req, 'user', 'users', {
    account: detail.account,
    profile: present.user(detail.account),
    settings: detail.settings,
    targetTheme: detail.theme,
    recentTweets: detail.recentTweets,
    reportsAgainst: detail.reportsAgainst,
    reportsByCount: detail.reportsByCount,
    logins: detail.logins,
    auditTrail: detail.audit,
    activeSessions: detail.activeSessions,
    isSelf: Number(detail.account.id) === Number(req.user.id),
  });
};

exports.suspendUser = async (req, res) => {
  const target = await loadTarget(req);
  if (target.role === 'admin') throw forbidden('Administrators cannot be suspended from here.');
  const reason = String(req.body.reason || '').trim().slice(0, 500) || 'Violation of the Twiq rules';
  await userModel.setSuspended(target.id, true, reason);
  const signedOut = await adminModel.purgeUserSessions(target.id);
  await audit(req, 'admin.user.suspend', {
    targetType: 'user', targetId: target.id,
    metadata: { username: String(target.username), reason, sessions_ended: signedOut },
  });
  logger.warn({ adminId: req.user.id, targetId: target.id }, 'account suspended');
  req.flash('success', `@${target.username} is suspended and signed out of ${signedOut} session(s).`);
  return res.redirect(back(req, '/admin/users'));
};

exports.unsuspendUser = async (req, res) => {
  const target = await loadTarget(req);
  await userModel.setSuspended(target.id, false, null);
  await audit(req, 'admin.user.unsuspend', {
    targetType: 'user', targetId: target.id, metadata: { username: String(target.username) },
  });
  req.flash('success', `@${target.username} is no longer suspended.`);
  return res.redirect(back(req, '/admin/users'));
};

exports.deleteUser = async (req, res) => {
  requireAdmin(req);
  const target = await loadTarget(req);
  if (Number(target.id) === Number(req.user.id)) throw badRequest('Delete your own account from settings.');
  if (target.role === 'admin') throw forbidden('Administrators cannot be deleted from here.');
  if (String(req.body.confirm || '') !== String(target.username)) {
    throw badRequest(`Type the username "${target.username}" to confirm this deletion.`);
  }
  await audit(req, 'admin.user.delete', {
    targetType: 'user', targetId: target.id,
    metadata: { username: String(target.username), tweets: target.tweet_count },
  });
  await userModel.remove(target.id);
  logger.warn({ adminId: req.user.id, targetId: target.id }, 'account deleted by admin');
  req.flash('success', `@${target.username} and all of their content were deleted.`);
  return res.redirect('/admin/users');
};

exports.setRole = async (req, res) => {
  requireAdmin(req);
  const target = await loadTarget(req);
  const role = ['user', 'moderator', 'admin'].includes(req.body.role) ? req.body.role : null;
  if (!role) throw badRequest('Unknown role.');
  if (Number(target.id) === Number(req.user.id)) throw badRequest('You cannot change your own role.');
  await userModel.setRole(target.id, role);
  await audit(req, 'admin.user.role', {
    targetType: 'user', targetId: target.id,
    metadata: { username: String(target.username), from: target.role, to: role },
  });
  req.flash('success', `@${target.username} is now a ${role}.`);
  return res.redirect(back(req, '/admin/users'));
};

exports.setVerified = async (req, res) => {
  requireAdmin(req);
  const target = await loadTarget(req);
  const verified = String(req.body.verified) === 'true';
  await userModel.setVerified(target.id, verified);
  await audit(req, 'admin.user.verify', {
    targetType: 'user', targetId: target.id,
    metadata: { username: String(target.username), verified },
  });
  req.flash('success', `@${target.username} is ${verified ? 'now verified' : 'no longer verified'}.`);
  return res.redirect(back(req, '/admin/users'));
};

exports.signOutUser = async (req, res) => {
  const target = await loadTarget(req);
  const count = await adminModel.purgeUserSessions(target.id);
  await audit(req, 'admin.user.sign_out', {
    targetType: 'user', targetId: target.id,
    metadata: { username: String(target.username), sessions_ended: count },
  });
  req.flash('success', `Ended ${count} session(s) for @${target.username}.`);
  return res.redirect(back(req, `/admin/users/${target.username}`));
};

/** Mint a reset link a moderator can hand to somebody locked out. */
exports.resetLink = async (req, res) => {
  requireAdmin(req);
  const target = await loadTarget(req);
  const token = await tokenModel.createPasswordReset(target.id);
  await audit(req, 'admin.user.reset_link', {
    targetType: 'user', targetId: target.id, metadata: { username: String(target.username) },
  });
  logger.warn({ adminId: req.user.id, targetId: target.id }, 'password reset link issued by admin');
  // Shown once, never stored - the database only holds its hash.
  req.flash('success',
    `One-time reset link for @${target.username}, valid for ${tokenModel.RESET_TTL_MINUTES} minutes: ` +
    `${config.baseUrl}/reset-password?token=${token}`);
  return res.redirect(`/admin/users/${target.username}`);
};

// =============================================================== content ===

exports.content = async (req, res) => {
  const term = String(req.query.q || '').trim();
  const author = String(req.query.author || '').trim();
  const filter = String(req.query.filter || 'any');
  const sort = String(req.query.sort || 'recent');
  const page = Math.max(0, Number(req.query.page || 0) || 0);
  const perPage = 40;

  const { rows, total } = await adminModel.searchTweets({
    term, author, filter, sort, limit: perPage, offset: page * perPage,
  });

  return render(res, req, 'content', 'content', {
    tweets: rows,
    total,
    term,
    author,
    filter,
    sort,
    page,
    perPage,
    hasMore: (page + 1) * perPage < total,
  });
};

exports.deleteTweet = async (req, res) => {
  const id = Number(req.params.id);
  const removed = await tweetModel.remove(id, req.user.id, { force: true });
  await audit(req, 'admin.tweet.delete', {
    targetType: 'tweet', targetId: id, metadata: { author_id: removed.user_id },
  });
  logger.warn({ adminId: req.user.id, tweetId: id }, 'tweet removed by moderator');
  req.flash('success', 'That Tweet was removed.');
  return res.redirect(back(req, '/admin/content'));
};

// =============================================================== reports ===

exports.reports = async (req, res) => {
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status)
    ? req.query.status
    : 'open';
  const rows = await moderation.listReports({ status, limit: 100 });
  const counts = await db.one(`
    SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
           count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
           count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
      FROM reports
  `);
  return render(res, req, 'reports', 'reports', { reports: rows, status, counts });
};

exports.resolveReport = async (req, res) => {
  const id = Number(req.params.id);
  const status = ['resolved', 'dismissed'].includes(req.body.status) ? req.body.status : 'resolved';
  await moderation.resolveReport(id, req.user.id, status);
  await audit(req, `admin.report.${status}`, { targetType: 'report', targetId: id });
  return res.redirect(back(req, '/admin/reports'));
};

// ================================================================ trends ===

exports.trends = async (req, res) => {
  const [rows, computed, scopes] = await Promise.all([
    trendsService.all(),
    trendsService.computeGlobal(15),
    trendsService.scopes(),
  ]);
  return render(res, req, 'trends', 'trends', { trends: rows, computed, scopes });
};

exports.saveTrend = async (req, res) => {
  const parsed = schemas.trendInput.safeParse(req.body);
  if (!parsed.success) throw badRequest(schemas.formatErrors(parsed.error).first);
  const tag = parsed.data.tag.replace(/^#/, '');
  await trendsService.upsertManual({
    scopeType: parsed.data.scope_type,
    scopeName: parsed.data.scope_name,
    tag,
    query: parsed.data.query || `#${tag}`,
    volume: parsed.data.volume,
    position: parsed.data.position,
  });
  await audit(req, 'admin.trend.save', { targetType: 'trend', targetId: tag, metadata: parsed.data });
  req.flash('success', `#${tag} is pinned to ${parsed.data.scope_name}.`);
  return res.redirect('/admin/trends');
};

exports.deleteTrend = async (req, res) => {
  await trendsService.removeTrend(Number(req.params.id));
  await audit(req, 'admin.trend.delete', { targetType: 'trend', targetId: req.params.id });
  return res.redirect('/admin/trends');
};

exports.refreshTrends = async (req, res) => {
  const rows = await trendsService.refreshGlobal();
  await audit(req, 'admin.trend.refresh', { metadata: { computed: rows.length } });
  req.flash('success', `Worldwide trends recomputed - ${rows.length} tag(s).`);
  return res.redirect('/admin/trends');
};

// =========================================================== status page ===

exports.status = async (req, res) => {
  const [components, active, scheduled, incidents, settings] = await Promise.all([
    statusModel.components(),
    statusModel.activeIncidents(),
    statusModel.scheduledIncidents(),
    statusModel.allIncidents(40),
    settingsService.all(),
  ]);
  const overall = statusModel.overall(components, {
    maintenance: Boolean(settings.maintenance),
    activeCount: active.length,
  });

  return render(res, req, 'status', 'status', {
    components,
    open: active.concat(scheduled),
    incidents,
    overall,
    labels: statusModel.LABELS,
    componentStatuses: statusModel.COMPONENT_STATUSES,
    incidentStatuses: statusModel.INCIDENT_STATUSES,
    scheduledStatuses: statusModel.SCHEDULED_STATUSES,
    impacts: statusModel.IMPACTS,
  });
};

exports.setComponentStatus = async (req, res) => {
  const id = Number(req.params.id);
  const component = await statusModel.setComponentStatus(id, String(req.body.status || ''));
  await audit(req, 'admin.status.component', {
    targetType: 'status_component', targetId: id,
    metadata: { name: component.name, status: component.status },
  });
  req.flash('success', `${component.name} is now "${statusModel.LABELS[component.status]}".`);
  return res.redirect('/admin/status');
};

exports.addComponent = async (req, res) => {
  const component = await statusModel.createComponent({
    name: req.body.name,
    description: req.body.description,
    position: Number(req.body.position) || 0,
  });
  await audit(req, 'admin.status.component_add', {
    targetType: 'status_component', targetId: component.id, metadata: { name: component.name },
  });
  req.flash('success', `Added "${component.name}" to the status page.`);
  return res.redirect('/admin/status');
};

exports.removeComponent = async (req, res) => {
  requireAdmin(req);
  const id = Number(req.params.id);
  const component = await statusModel.componentById(id);
  if (!component) throw notFound('That component does not exist.');
  await statusModel.removeComponent(id);
  await audit(req, 'admin.status.component_remove', {
    targetType: 'status_component', targetId: id, metadata: { name: component.name },
  });
  req.flash('success', `Removed "${component.name}".`);
  return res.redirect('/admin/status');
};

exports.allClear = async (req, res) => {
  const count = await statusModel.allClear();
  await audit(req, 'admin.status.all_clear', { metadata: { components_reset: count } });
  req.flash('success', count === 0
    ? 'Everything was already operational.'
    : `Set ${count} component(s) back to operational.`);
  return res.redirect('/admin/status');
};

exports.createIncident = async (req, res) => {
  const isScheduled = ['on', 'true', '1'].includes(String(req.body.is_scheduled));
  const componentIds = []
    .concat(req.body.components || [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  const incident = await statusModel.createIncident({
    title: req.body.title,
    status: String(req.body.status || (isScheduled ? 'scheduled' : 'investigating')),
    impact: String(req.body.impact || 'minor'),
    body: req.body.body,
    componentIds,
    authorId: req.user.id,
    isScheduled,
    scheduledFor: req.body.scheduled_for || null,
    scheduledUntil: req.body.scheduled_until || null,
    componentStatus: req.body.component_status || null,
  });

  await audit(req, 'admin.status.incident_open', {
    targetType: 'status_incident', targetId: incident.id,
    metadata: { title: incident.title, impact: incident.impact, scheduled: isScheduled },
  });
  logger.warn({ adminId: req.user.id, incidentId: incident.id }, 'status incident opened');
  req.flash('success', `Published "${incident.title}" to the status page.`);
  return res.redirect('/admin/status');
};

exports.addIncidentUpdate = async (req, res) => {
  const id = Number(req.params.id);
  const next = await statusModel.addUpdate(id, {
    status: String(req.body.status || ''),
    body: req.body.body,
    authorId: req.user.id,
    componentStatus: req.body.component_status || null,
  });
  await audit(req, 'admin.status.incident_update', {
    targetType: 'status_incident', targetId: id, metadata: { status: next },
  });
  req.flash('success', `Update posted. The incident is now "${next}".`);
  return res.redirect('/admin/status');
};

exports.deleteIncident = async (req, res) => {
  requireAdmin(req);
  const id = Number(req.params.id);
  const incident = await statusModel.incidentById(id);
  if (!incident) throw notFound('That incident does not exist.');
  await statusModel.removeIncident(id);
  await audit(req, 'admin.status.incident_delete', {
    targetType: 'status_incident', targetId: id, metadata: { title: incident.title },
  });
  req.flash('success', 'That incident was removed from the status page.');
  return res.redirect('/admin/status');
};

// ================================================================ system ===

exports.system = async (req, res) => {
  requireAdmin(req);
  const [settings, storageStats, dbStats, sessions, migrations, drift] = await Promise.all([
    settingsService.all(),
    adminModel.storageStats(),
    adminModel.databaseStats(),
    adminModel.sessionStats(),
    adminModel.migrationStatus(),
    adminModel.counterDrift(),
  ]);

  return render(res, req, 'system', 'system', {
    settings,
    storageStats,
    dbStats,
    sessions,
    migrations,
    drift,
    runtime: {
      node: process.version,
      env: config.nodeEnv,
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage().rss,
      pid: process.pid,
      baseUrl: config.baseUrl,
      tweetMaxLength: config.brand.tweetMaxLength,
      uploadMax: config.uploads.maxSize,
      storageDriver: config.uploads.driver,
      websockets: config.features.websockets,
      pool: { total: db.pool.totalCount, idle: db.pool.idleCount, waiting: db.pool.waitingCount },
    },
  });
};

exports.updateSettings = async (req, res) => {
  requireAdmin(req);
  const registrationOpen = ['on', 'true', '1'].includes(String(req.body.registration_open));
  const readOnly = ['on', 'true', '1'].includes(String(req.body.read_only));
  const maintenance = ['on', 'true', '1'].includes(String(req.body.maintenance));
  const maintenanceMessage = String(req.body.maintenance_message || '').trim().slice(0, 280);
  // Fall back to the service's own default rather than repeating a literal
  // here, which is how this drifted to /help after the status page landed.
  const statusFallback = settingsService.DEFAULTS.status_url;
  const statusUrl = String(req.body.status_url || statusFallback).trim().slice(0, 200) || statusFallback;
  const announcement = String(req.body.announcement || '').trim().slice(0, 280);
  const level = ['info', 'warning', 'critical'].includes(req.body.announcement_level)
    ? req.body.announcement_level
    : 'info';

  await settingsService.set('registration_open', registrationOpen, req.user.id);
  await settingsService.set('read_only', readOnly, req.user.id);
  await settingsService.set('maintenance', maintenance, req.user.id);
  await settingsService.set('maintenance_message', maintenanceMessage, req.user.id);
  await settingsService.set('status_url', statusUrl, req.user.id);
  await settingsService.set('announcement', announcement, req.user.id);
  await settingsService.set('announcement_level', level, req.user.id);

  await audit(req, 'admin.system.settings', {
    metadata: {
      registration_open: registrationOpen,
      read_only: readOnly,
      maintenance,
      announcement_length: announcement.length,
      announcement_level: level,
    },
  });
  logger.warn(
    { adminId: req.user.id, registrationOpen, readOnly, maintenance },
    'system settings changed'
  );
  req.flash('success', 'System settings saved.');
  return res.redirect('/admin/system');
};

const MAINTENANCE = {
  async recount(req) {
    const n = await adminModel.recountAll();
    return { message: `Recounted ${n} account(s) whose totals had drifted.`, metadata: { updated: n } };
  },
  async sessions(req) {
    const n = await adminModel.purgeExpiredSessions();
    return { message: `Removed ${n} expired session(s).`, metadata: { removed: n } };
  },
  async logins(req) {
    const n = await adminModel.pruneLoginAttempts(30);
    return { message: `Pruned ${n} sign-in attempt record(s) older than 30 days.`, metadata: { removed: n } };
  },
  async media(req) {
    // Unreferenced uploads older than a day: the file goes, then the row.
    const orphans = await mediaModel.orphans(24, 500);
    let removed = 0;
    for (const row of orphans) {
      await storage.remove(row.storage_key);
      await mediaModel.remove(row.id);
      removed += 1;
    }
    return { message: `Deleted ${removed} unreferenced upload(s).`, metadata: { removed } };
  },
  async trends(req) {
    const rows = await trendsService.refreshGlobal();
    return { message: `Recomputed ${rows.length} worldwide trend(s).`, metadata: { computed: rows.length } };
  },
};

exports.runMaintenance = async (req, res) => {
  requireAdmin(req);
  const task = String(req.params.task || '');
  const run = MAINTENANCE[task];
  if (!run) throw notFound('Unknown maintenance task.');
  const result = await run(req);
  await audit(req, `admin.maintenance.${task}`, { metadata: result.metadata });
  logger.info({ adminId: req.user.id, task, ...result.metadata }, 'maintenance task run');
  req.flash('success', result.message);
  return res.redirect('/admin/system');
};

// ============================================================= audit log ===

exports.audit = async (req, res) => {
  const actor = String(req.query.actor || '').trim();
  const action = String(req.query.action || '').trim();
  const page = Math.max(0, Number(req.query.page || 0) || 0);
  const perPage = 100;
  const { rows, actions } = await adminModel.auditLog({
    actor, action, limit: perPage + 1, offset: page * perPage,
  });
  const hasMore = rows.length > perPage;
  return render(res, req, 'audit', 'audit', {
    logs: hasMore ? rows.slice(0, perPage) : rows,
    actions,
    actor,
    action,
    page,
    hasMore,
  });
};

exports.NAV = NAV;
exports.MAINTENANCE_TASKS = Object.keys(MAINTENANCE);
