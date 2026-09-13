'use strict';

const config = require('../config/env');
const statusModel = require('../models/status');
const settingsService = require('../services/settings');
const format = require('../utils/format');

/**
 * The public status page. It stays reachable while the rest of the site is
 * in maintenance mode - a status page that goes down with the service is
 * worth nothing.
 */

function present(incident) {
  return {
    ...incident,
    startedLong: format.longTimestamp(incident.started_at),
    startedShort: format.shortTimestamp(incident.started_at),
    resolvedLong: incident.resolved_at ? format.longTimestamp(incident.resolved_at) : null,
    scheduledForLong: incident.scheduled_for ? format.longTimestamp(incident.scheduled_for) : null,
    scheduledUntilLong: incident.scheduled_until ? format.longTimestamp(incident.scheduled_until) : null,
    updates: (incident.updates || []).map((update) => ({
      ...update,
      timeLong: format.longTimestamp(update.created_at),
      timeShort: format.shortTimestamp(update.created_at),
    })),
  };
}

async function load() {
  const [components, active, scheduled, recent, settings] = await Promise.all([
    statusModel.components(),
    statusModel.activeIncidents(),
    statusModel.scheduledIncidents(),
    statusModel.recentIncidents(14),
    settingsService.all(),
  ]);
  const overall = statusModel.overall(components, {
    maintenance: Boolean(settings.maintenance),
    activeCount: active.length,
  });
  return { components, active, scheduled, recent, settings, overall };
}

exports.show = async (req, res) => {
  const { components, active, scheduled, recent, settings, overall } = await load();

  return res.render('status/index', {
    title: `${overall.label} | ${config.brand.name} Status`,
    description: `Current status of ${config.brand.name}: ${overall.label}.`,
    canonical: `${config.baseUrl}/status`,
    nav: null,
    bodyClass: 'page-status',
    overall,
    components,
    labels: statusModel.LABELS,
    active: active.map(present),
    scheduled: scheduled.map(present),
    recent: recent.map(present),
    maintenance: Boolean(settings.maintenance),
    checkedAt: format.longTimestamp(new Date()),
  });
};

/** A small machine-readable feed, for anyone watching from outside. */
exports.json = async (req, res) => {
  const { components, active, scheduled, overall } = await load();
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({
    status: { indicator: overall.key, description: overall.label },
    components: components.map((c) => ({
      id: Number(c.id),
      name: c.name,
      status: c.status,
      updated_at: c.updated_at,
    })),
    incidents: active.map((i) => ({
      id: Number(i.id),
      title: i.title,
      status: i.status,
      impact: i.impact,
      started_at: i.started_at,
      components: i.component_names,
      latest_update: i.updates[0] ? i.updates[0].body : null,
    })),
    scheduled_maintenance: scheduled.map((i) => ({
      id: Number(i.id),
      title: i.title,
      status: i.status,
      scheduled_for: i.scheduled_for,
      scheduled_until: i.scheduled_until,
    })),
    page: { name: `${config.brand.name} Status`, url: `${config.baseUrl}/status` },
    updated_at: new Date().toISOString(),
  });
};
