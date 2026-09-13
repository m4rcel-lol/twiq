'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let app;

test.before(async () => {
  await helpers.prepare();
  app = helpers.createApp();
});
test.beforeEach(async () => {
  await helpers.truncate();
  const db = require('../src/config/db');
  await db.query(
    `DELETE FROM system_settings WHERE key IN
       ('registration_open', 'read_only', 'announcement', 'announcement_level',
        'maintenance', 'maintenance_message', 'status_url')`
  );
  require('../src/services/settings').invalidate();
});
test.after(async () => helpers.close());

async function staffAgent(username, role) {
  const agent = await helpers.signedUpAgent(app, username);
  const db = require('../src/config/db');
  await db.query('UPDATE users SET role = $2 WHERE username = $1', [username, role]);
  const page = await agent.get('/admin/status');
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  if (match) agent.csrfToken = match[1];
  return agent;
}

async function addComponents(agent, names) {
  const ids = [];
  const statusModel = require('../src/models/status');
  for (const [index, name] of names.entries()) {
    const created = await statusModel.createComponent({ name, position: index });
    ids.push(Number(created.id));
  }
  assert.ok(agent);
  return ids;
}

// ---------------------------------------------------------------- public ---

test('the status page is public and reports all clear when nothing is wrong', async () => {
  const request = require('supertest');
  const admin = await staffAgent('statusadmin', 'admin');
  await addComponents(admin, ['Timeline', 'Direct Messages']);

  const page = await request(app).get('/status');
  assert.equal(page.status, 200);
  assert.match(page.text, /All systems operational/);
  assert.match(page.text, /Timeline/);
  assert.match(page.text, /Direct Messages/);
  assert.match(page.text, /No incidents in the last 14 days/);
});

test('status.json describes the same thing in machine-readable form', async () => {
  const request = require('supertest');
  const admin = await staffAgent('jsonadmin', 'admin');
  await addComponents(admin, ['Timeline', 'Search']);

  const feed = await request(app).get('/status.json');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.status.indicator, 'operational');
  assert.equal(feed.body.status.description, 'All systems operational');
  assert.equal(feed.body.components.length, 2);
  assert.deepEqual(feed.body.components.map((c) => c.name), ['Timeline', 'Search']);
  assert.deepEqual(feed.body.incidents, []);
  assert.match(feed.headers['cache-control'], /max-age=30/);
});

// ------------------------------------------------------------- incidents ---

test('an incident changes the headline, marks its components and resolves cleanly', async () => {
  const request = require('supertest');
  const admin = await staffAgent('lifecycleadmin', 'admin');
  const [timeline, dms] = await addComponents(admin, ['Timeline', 'Direct Messages']);

  const opened = await admin.post('/admin/status/incidents').type('form').send({
    _csrf: admin.csrfToken,
    title: 'Direct Messages are slow to send',
    body: 'We are looking into reports of slow delivery.',
    status: 'investigating',
    impact: 'major',
    components: [String(dms)],
    component_status: 'degraded',
  });
  assert.equal(opened.status, 302);

  let feed = await request(app).get('/status.json');
  assert.equal(feed.body.status.indicator, 'degraded');
  assert.equal(feed.body.incidents.length, 1);
  assert.equal(feed.body.incidents[0].title, 'Direct Messages are slow to send');
  assert.equal(feed.body.components.find((c) => c.id === dms).status, 'degraded');
  assert.equal(feed.body.components.find((c) => c.id === timeline).status, 'operational');

  const page = await request(app).get('/status');
  assert.match(page.text, /Open incidents/);
  assert.match(page.text, /We are looking into reports of slow delivery/);

  const statusModel = require('../src/models/status');
  const incidents = await statusModel.allIncidents();
  const id = incidents[0].id;

  await admin.post(`/admin/status/incidents/${id}/update`).type('form').send({
    _csrf: admin.csrfToken, status: 'identified', body: 'A queue backlog was the cause.',
  });
  feed = await request(app).get('/status.json');
  assert.equal(feed.body.incidents[0].status, 'identified');
  assert.equal(feed.body.components.find((c) => c.id === dms).status, 'degraded');

  await admin.post(`/admin/status/incidents/${id}/update`).type('form').send({
    _csrf: admin.csrfToken, status: 'resolved', body: 'The backlog is clear.',
  });

  // Resolving returns the affected components to operational on its own.
  feed = await request(app).get('/status.json');
  assert.equal(feed.body.status.indicator, 'operational');
  assert.equal(feed.body.incidents.length, 0);
  assert.equal(feed.body.components.find((c) => c.id === dms).status, 'operational');

  const after = await request(app).get('/status');
  assert.match(after.text, /Past incidents/);
  assert.match(after.text, /The backlog is clear/);
  // Every update is kept, so the page shows what was known when.
  assert.match(after.text, /A queue backlog was the cause/);
  assert.match(after.text, /We are looking into reports of slow delivery/);
});

test('scheduled maintenance is listed apart from incidents', async () => {
  const request = require('supertest');
  const admin = await staffAgent('windowadmin', 'admin');
  const [timeline] = await addComponents(admin, ['Timeline']);

  await admin.post('/admin/status/incidents').type('form').send({
    _csrf: admin.csrfToken,
    title: 'Database upgrade',
    body: 'Twiq will be read-only for about twenty minutes.',
    status: 'scheduled',
    impact: 'minor',
    is_scheduled: 'on',
    components: [String(timeline)],
  });

  const page = await request(app).get('/status');
  assert.match(page.text, /Scheduled maintenance/);
  assert.match(page.text, /Database upgrade/);
  assert.ok(!page.text.includes('Open incidents'));

  const feed = await request(app).get('/status.json');
  assert.equal(feed.body.incidents.length, 0);
  assert.equal(feed.body.scheduled_maintenance.length, 1);
  assert.equal(feed.body.scheduled_maintenance[0].title, 'Database upgrade');
});

test('an incident cannot be published without a title and a first update', async () => {
  const admin = await staffAgent('emptyadmin', 'admin');

  const noTitle = await admin.post('/admin/status/incidents')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken, title: '   ', body: 'something' });
  assert.equal(noTitle.status, 400);

  const noBody = await admin.post('/admin/status/incidents')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken, title: 'Something broke', body: '  ' });
  assert.equal(noBody.status, 400);

  const statusModel = require('../src/models/status');
  assert.equal((await statusModel.allIncidents()).length, 0);
});

test('incident text is escaped on the public page', async () => {
  const request = require('supertest');
  const admin = await staffAgent('xssstatusadmin', 'admin');

  await admin.post('/admin/status/incidents').type('form').send({
    _csrf: admin.csrfToken,
    title: '<script>alert(1)</script>',
    body: 'Broken <img src=x onerror=alert(2)>',
    status: 'investigating',
    impact: 'minor',
  });

  const page = await request(app).get('/status');
  assert.ok(!page.text.includes('<script>alert(1)</script>'));
  assert.ok(!page.text.includes('<img src=x onerror=alert(2)>'));
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ------------------------------------------------------------ components ---

test('component status can be set directly and cleared in one go', async () => {
  const request = require('supertest');
  const admin = await staffAgent('compadmin', 'admin');
  const [timeline, search] = await addComponents(admin, ['Timeline', 'Search']);

  await admin.post(`/admin/status/components/${timeline}`).type('form')
    .send({ _csrf: admin.csrfToken, status: 'major_outage' });

  let feed = await request(app).get('/status.json');
  assert.equal(feed.body.status.indicator, 'major_outage');
  assert.equal(feed.body.status.description, 'Major system outage');

  await admin.post(`/admin/status/components/${search}`).type('form')
    .send({ _csrf: admin.csrfToken, status: 'degraded' });

  // The headline reports the worst component, not the most recent change.
  feed = await request(app).get('/status.json');
  assert.equal(feed.body.status.indicator, 'major_outage');

  await admin.post('/admin/status/all-clear').type('form').send({ _csrf: admin.csrfToken });
  feed = await request(app).get('/status.json');
  assert.equal(feed.body.status.indicator, 'operational');

  const unknown = await admin.post(`/admin/status/components/${timeline}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken, status: 'on_fire' });
  assert.equal(unknown.status, 400);
});

// ---------------------------------------------------------------- access ---

test('moderators can operate the status page but not delete from it', async () => {
  const mod = await staffAgent('statusmod', 'moderator');
  const [component] = await addComponents(mod, ['Timeline']);

  assert.equal((await mod.get('/admin/status')).status, 200);

  const set = await mod.post(`/admin/status/components/${component}`).type('form')
    .send({ _csrf: mod.csrfToken, status: 'degraded' });
  assert.equal(set.status, 302);

  const published = await mod.post('/admin/status/incidents').type('form').send({
    _csrf: mod.csrfToken, title: 'Slow search', body: 'Looking into it.', status: 'investigating',
  });
  assert.equal(published.status, 302);

  const statusModel = require('../src/models/status');
  const id = (await statusModel.allIncidents())[0].id;

  const deletion = await mod.post(`/admin/status/incidents/${id}/delete`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: mod.csrfToken });
  assert.equal(deletion.status, 403);

  const componentDeletion = await mod.post(`/admin/status/components/${component}/delete`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: mod.csrfToken });
  assert.equal(componentDeletion.status, 403);
});

test('an ordinary member cannot reach the editor', async () => {
  const member = await helpers.signedUpAgent(app, 'statusnobody');
  assert.equal((await member.get('/admin/status')).status, 404);

  const attempt = await member.post('/admin/status/all-clear').type('form')
    .send({ _csrf: member.csrfToken });
  assert.equal(attempt.status, 404);
});

// ----------------------------------------------------------- maintenance ---

test('the status page stays up while the rest of the site is in maintenance', async () => {
  const request = require('supertest');
  const admin = await staffAgent('mtstatusadmin', 'admin');
  await addComponents(admin, ['Timeline']);

  const systemPage = await admin.get('/admin/system');
  const token = /name="_csrf" value="([^"]+)"/.exec(systemPage.text)[1];
  await admin.post('/admin/system/settings').type('form').send({
    _csrf: token, registration_open: 'on', maintenance: 'on',
    announcement: '', announcement_level: 'info',
  });

  // The rest of the site is closed...
  assert.equal((await request(app).get('/')).status, 503);

  // ...but a status page that goes down with the service is worth nothing.
  const page = await request(app).get('/status');
  assert.equal(page.status, 200);
  assert.match(page.text, /Maintenance in progress/);
  assert.match(page.text, /stays up while it is/);

  const feed = await request(app).get('/status.json');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.status.indicator, 'maintenance');

  // And the maintenance page points readers at it.
  const down = await request(app).get('/');
  assert.match(down.text, /href="\/status"><strong>Twiq Status<\/strong>/);

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: token, registration_open: 'on', announcement: '', announcement_level: 'info',
  });
});
