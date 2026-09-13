'use strict';

const db = require('../config/db');
const { badRequest, notFound } = require('../utils/errors');

/**
 * The status page: component health and incidents.
 *
 * Component status is a single column per component. Incidents carry a
 * running log of updates, so the public page can show what was known when
 * rather than only the latest word.
 */

const COMPONENT_STATUSES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'];
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];
const SCHEDULED_STATUSES = ['scheduled', 'in_progress', 'completed'];
const IMPACTS = ['none', 'minor', 'major', 'critical'];

/** Worst first - this ordering decides the headline on the public page. */
const SEVERITY = {
  major_outage: 4,
  partial_outage: 3,
  degraded: 2,
  maintenance: 1,
  operational: 0,
};

const LABELS = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Under maintenance',
};

const HEADLINES = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  partial_outage: 'Partial system outage',
  major_outage: 'Major system outage',
  maintenance: 'Maintenance in progress',
};

// ----------------------------------------------------------- components --

async function components() {
  return db.many('SELECT * FROM status_components ORDER BY position, id');
}

async function componentById(id) {
  return db.one('SELECT * FROM status_components WHERE id = $1', [id]);
}

async function setComponentStatus(id, status) {
  if (!COMPONENT_STATUSES.includes(status)) throw badRequest('Unknown component status.');
  const row = await db.one(
    'UPDATE status_components SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status]
  );
  if (!row) throw notFound('That component does not exist.');
  return row;
}

async function createComponent({ name, description = '', position = 0 }) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw badRequest('Give the component a name.');
  return db.one(
    `INSERT INTO status_components (name, description, position)
     VALUES ($1, $2, $3) RETURNING *`,
    [clean, String(description || '').trim().slice(0, 160), position]
  );
}

async function updateComponent(id, { name, description, position }) {
  return db.one(
    `UPDATE status_components
        SET name = COALESCE($2, name),
            description = COALESCE($3, description),
            position = COALESCE($4, position),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, name ? String(name).trim().slice(0, 60) : null,
     description === undefined ? null : String(description).trim().slice(0, 160),
     position === undefined ? null : position]
  );
}

async function removeComponent(id) {
  await db.query('DELETE FROM status_components WHERE id = $1', [id]);
}

/** Reset everything to operational - the "all clear" button. */
async function allClear() {
  const result = await db.query(
    `UPDATE status_components SET status = 'operational', updated_at = now()
      WHERE status <> 'operational'`
  );
  return result.rowCount;
}

// ------------------------------------------------------------ incidents --

const INCIDENT_SELECT = `
  SELECT i.*, u.username AS created_by_username,
         COALESCE(c.names, ARRAY[]::text[]) AS component_names,
         COALESCE(c.ids, ARRAY[]::bigint[]) AS component_ids
    FROM status_incidents i
    LEFT JOIN users u ON u.id = i.created_by
    LEFT JOIN LATERAL (
      SELECT array_agg(sc.name ORDER BY sc.position) AS names,
             array_agg(sc.id ORDER BY sc.position) AS ids
        FROM status_incident_components sic
        JOIN status_components sc ON sc.id = sic.component_id
       WHERE sic.incident_id = i.id
    ) c ON true
`;

async function withUpdates(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r.id));
  const updates = await db.many(
    `SELECT u.*, a.username AS author_username
       FROM status_incident_updates u
       LEFT JOIN users a ON a.id = u.author_id
      WHERE u.incident_id = ANY($1::bigint[])
      ORDER BY u.created_at DESC, u.id DESC`,
    [ids]
  );
  const byIncident = new Map(ids.map((id) => [id, []]));
  for (const update of updates) byIncident.get(Number(update.incident_id)).push(update);
  return rows.map((row) => ({ ...row, updates: byIncident.get(Number(row.id)) || [] }));
}

/** Anything unresolved, newest first. */
async function activeIncidents() {
  const rows = await db.many(
    `${INCIDENT_SELECT} WHERE i.resolved_at IS NULL AND i.is_scheduled = false
      ORDER BY i.started_at DESC`
  );
  return withUpdates(rows);
}

/** Upcoming or running maintenance windows. */
async function scheduledIncidents() {
  const rows = await db.many(
    `${INCIDENT_SELECT}
      WHERE i.is_scheduled = true AND i.resolved_at IS NULL
        AND (i.scheduled_until IS NULL OR i.scheduled_until > now() - interval '1 day')
      ORDER BY i.scheduled_for ASC NULLS LAST`
  );
  return withUpdates(rows);
}

async function recentIncidents(days = 14) {
  const rows = await db.many(
    `${INCIDENT_SELECT}
      WHERE i.resolved_at IS NOT NULL
        AND i.resolved_at > now() - (($1)::text || ' days')::interval
      ORDER BY i.started_at DESC`,
    [days]
  );
  return withUpdates(rows);
}

async function allIncidents(limit = 60) {
  const rows = await db.many(`${INCIDENT_SELECT} ORDER BY i.started_at DESC LIMIT $1`, [limit]);
  return withUpdates(rows);
}

async function incidentById(id) {
  const rows = await db.many(`${INCIDENT_SELECT} WHERE i.id = $1`, [id]);
  const withThem = await withUpdates(rows);
  return withThem[0] || null;
}

/**
 * Open an incident. The first update is written in the same transaction, so
 * an incident is never published without an explanation attached.
 */
async function createIncident({
  title, status = 'investigating', impact = 'minor', body, componentIds = [],
  authorId = null, isScheduled = false, scheduledFor = null, scheduledUntil = null,
  componentStatus = null,
}) {
  const clean = String(title || '').trim().slice(0, 120);
  if (!clean) throw badRequest('Give the incident a title.');
  const message = String(body || '').trim().slice(0, 2000);
  if (!message) throw badRequest('Write what is happening.');

  const allowed = isScheduled ? SCHEDULED_STATUSES : INCIDENT_STATUSES;
  if (!allowed.includes(status)) throw badRequest('Unknown incident status.');
  if (!IMPACTS.includes(impact)) throw badRequest('Unknown impact.');

  return db.transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO status_incidents
         (title, status, impact, is_scheduled, scheduled_for, scheduled_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clean, status, impact, isScheduled, scheduledFor, scheduledUntil, authorId]
    );
    const incident = inserted.rows[0];

    for (const componentId of componentIds) {
      await client.query(
        `INSERT INTO status_incident_components (incident_id, component_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [incident.id, componentId]
      );
      if (componentStatus && COMPONENT_STATUSES.includes(componentStatus)) {
        await client.query(
          'UPDATE status_components SET status = $2, updated_at = now() WHERE id = $1',
          [componentId, componentStatus]
        );
      }
    }

    await client.query(
      `INSERT INTO status_incident_updates (incident_id, status, body, author_id)
       VALUES ($1, $2, $3, $4)`,
      [incident.id, status, message, authorId]
    );
    return incident;
  });
}

/** Post an update. Moving to a resolved state closes the incident. */
async function addUpdate(incidentId, { status, body, authorId = null, componentStatus = null }) {
  const message = String(body || '').trim().slice(0, 2000);
  if (!message) throw badRequest('Write an update.');

  return db.transaction(async (client) => {
    const found = await client.query('SELECT * FROM status_incidents WHERE id = $1', [incidentId]);
    const incident = found.rows[0];
    if (!incident) throw notFound('That incident does not exist.');

    const allowed = incident.is_scheduled ? SCHEDULED_STATUSES : INCIDENT_STATUSES;
    const next = allowed.includes(status) ? status : incident.status;
    const closing = next === 'resolved' || next === 'completed';

    await client.query(
      `UPDATE status_incidents
          SET status = $2,
              resolved_at = CASE WHEN $3 THEN COALESCE(resolved_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [incidentId, next, closing]
    );
    await client.query(
      `INSERT INTO status_incident_updates (incident_id, status, body, author_id)
       VALUES ($1, $2, $3, $4)`,
      [incidentId, next, message, authorId]
    );

    // Closing an incident puts the components it touched back to operational,
    // unless the operator asked for something else.
    const target = closing ? (componentStatus || 'operational') : componentStatus;
    if (target && COMPONENT_STATUSES.includes(target)) {
      await client.query(
        `UPDATE status_components SET status = $2, updated_at = now()
          WHERE id IN (SELECT component_id FROM status_incident_components WHERE incident_id = $1)`,
        [incidentId, target]
      );
    }
    return next;
  });
}

async function removeIncident(id) {
  await db.query('DELETE FROM status_incidents WHERE id = $1', [id]);
}

// -------------------------------------------------------------- overall --

/**
 * The headline. Maintenance mode outranks component health, because if the
 * site is down that is the only thing a reader needs to know.
 */
function overall(componentRows, { maintenance = false, activeCount = 0 } = {}) {
  if (maintenance) {
    return { key: 'maintenance', label: HEADLINES.maintenance, severity: SEVERITY.maintenance };
  }
  let worst = 'operational';
  for (const row of componentRows) {
    if (SEVERITY[row.status] > SEVERITY[worst]) worst = row.status;
  }
  if (worst === 'operational' && activeCount > 0) {
    return { key: 'degraded', label: 'Investigating an issue', severity: SEVERITY.degraded };
  }
  return { key: worst, label: HEADLINES[worst], severity: SEVERITY[worst] };
}

module.exports = {
  COMPONENT_STATUSES,
  INCIDENT_STATUSES,
  SCHEDULED_STATUSES,
  IMPACTS,
  LABELS,
  HEADLINES,
  SEVERITY,
  components,
  componentById,
  setComponentStatus,
  createComponent,
  updateComponent,
  removeComponent,
  allClear,
  activeIncidents,
  scheduledIncidents,
  recentIncidents,
  allIncidents,
  incidentById,
  createIncident,
  addUpdate,
  removeIncident,
  overall,
};
