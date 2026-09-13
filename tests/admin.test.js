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
  // system_settings is deliberately not truncated with the rest, so a test
  // that flips a switch would otherwise leak into the next one.
  const db = require('../src/config/db');
  await db.query(
    `DELETE FROM system_settings WHERE key IN
       ('registration_open', 'read_only', 'announcement', 'announcement_level',
        'maintenance', 'maintenance_message', 'status_url')`
  );
  require('../src/services/settings').invalidate();
});
test.after(async () => helpers.close());

/** Sign up, promote, and return an agent with a current CSRF token. */
async function staffAgent(app_, username, role) {
  const agent = await helpers.signedUpAgent(app_, username);
  const db = require('../src/config/db');
  await db.query('UPDATE users SET role = $2 WHERE username = $1', [username, role]);
  const page = await agent.get('/admin');
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  if (match) agent.csrfToken = match[1];
  return agent;
}

// --------------------------------------------------------------- access ---

test('the panel is invisible to ordinary members and open to staff', async () => {
  const member = await helpers.signedUpAgent(app, 'plainmember');
  for (const path of ['/admin', '/admin/users', '/admin/content', '/admin/audit']) {
    const denied = await member.get(path);
    assert.equal(denied.status, 404, `${path} should look like it does not exist`);
  }

  const mod = await staffAgent(app, 'modperson2', 'moderator');
  for (const path of ['/admin', '/admin/users', '/admin/content', '/admin/reports', '/admin/trends', '/admin/audit']) {
    const ok = await mod.get(path);
    assert.equal(ok.status, 200, `${path} should open for a moderator`);
  }
});

test('the System page and its actions are administrators only', async () => {
  const mod = await staffAgent(app, 'modperson3', 'moderator');
  await helpers.signedUpAgent(app, 'sometarget');

  assert.equal((await mod.get('/admin/system')).status, 404);
  assert.equal((await mod.get('/admin')).text.includes('/admin/system'), false,
    'the System link should not be offered to a moderator');

  const settings = await mod.post('/admin/system/settings').type('form')
    .send({ _csrf: mod.csrfToken, registration_open: 'on' });
  assert.equal(settings.status, 404);

  const maintenance = await mod.post('/admin/system/maintenance/recount').type('form')
    .send({ _csrf: mod.csrfToken });
  assert.equal(maintenance.status, 404);

  // Role changes and deletions are admin-only even though the page is not.
  const role = await mod.post('/admin/users/sometarget/role').type('form')
    .send({ _csrf: mod.csrfToken, role: 'admin' });
  assert.equal(role.status, 403);
});

// ---------------------------------------------------------------- people ---

test('the user table filters, and every filter is parameterised', async () => {
  const admin = await staffAgent(app, 'panadmin', 'admin');
  await helpers.signedUpAgent(app, 'quietone');
  const loud = await helpers.signedUpAgent(app, 'loudone');
  await loud.post('/api/tweets').set('X-CSRF-Token', loud.csrfToken).send({ body: 'hello' });

  const db = require('../src/config/db');
  await db.query(`UPDATE users SET is_suspended = true WHERE username = 'quietone'`);

  const suspended = await admin.get('/admin/users?status=suspended');
  assert.match(suspended.text, /@quietone/);
  assert.ok(!suspended.text.includes('>@loudone<'));

  const byName = await admin.get('/admin/users?q=loud');
  assert.match(byName.text, /@loudone/);
  assert.ok(!byName.text.includes('>@quietone<'));

  // A quote in the search term must not break out of the query.
  const injection = await admin.get(`/admin/users?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(injection.status, 200);
  assert.match(injection.text, /No accounts match those filters/);

  // An unknown sort key falls back rather than reaching the SQL.
  const badSort = await admin.get('/admin/users?sort=id;DROP%20TABLE%20users');
  assert.equal(badSort.status, 200);
  const stillThere = await db.one('SELECT count(*)::int AS n FROM users');
  assert.ok(stillThere.n >= 3);
});

test('suspending an account ends its sessions and is written to the audit log', async () => {
  const admin = await staffAgent(app, 'suspendadmin', 'admin');
  const victim = await helpers.signedUpAgent(app, 'suspendvictim');

  assert.equal((await victim.get('/home')).status, 200);

  const done = await admin.post('/admin/users/suspendvictim/suspend').type('form')
    .send({ _csrf: admin.csrfToken, reason: 'Spam' });
  assert.equal(done.status, 302);

  const out = await victim.get('/home');
  assert.equal(out.status, 302);
  assert.match(out.headers.location, /^\/login/);

  const detail = await admin.get('/admin/users/suspendvictim');
  assert.match(detail.text, /Suspended: Spam/);

  const audit = await admin.get('/admin/audit?action=admin.user.suspend');
  assert.match(audit.text, /admin.user.suspend/);
  assert.match(audit.text, /suspendvictim/);
});

test('deleting an account requires the username typed back', async () => {
  const admin = await staffAgent(app, 'deleteadmin', 'admin');
  await helpers.signedUpAgent(app, 'deleteme');

  const wrong = await admin.post('/admin/users/deleteme/delete')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken, confirm: 'not-the-name' });
  assert.equal(wrong.status, 400);

  const userModel = require('../src/models/user');
  assert.ok(await userModel.findByUsername('deleteme'), 'the account should survive a wrong confirmation');

  const right = await admin.post('/admin/users/deleteme/delete').type('form')
    .send({ _csrf: admin.csrfToken, confirm: 'deleteme' });
  assert.equal(right.status, 302);
  assert.equal(await userModel.findByUsername('deleteme'), null);
});

test('an administrator cannot change their own role or suspend another administrator', async () => {
  const admin = await staffAgent(app, 'selfadmin', 'admin');
  await staffAgent(app, 'otheradmin', 'admin');

  const self = await admin.post('/admin/users/selfadmin/role')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken, role: 'user' });
  assert.equal(self.status, 400);

  const other = await admin.post('/admin/users/otheradmin/suspend')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken });
  assert.equal(other.status, 403);
});

// --------------------------------------------------------------- content ---

test('the content browser filters and can remove a Tweet', async () => {
  const admin = await staffAgent(app, 'contentadmin', 'admin');
  const author = await helpers.signedUpAgent(app, 'contentauthor');
  const created = await author.post('/api/tweets')
    .set('X-CSRF-Token', author.csrfToken)
    .send({ body: 'a very distinctive sentence' });

  const found = await admin.get('/admin/content?q=distinctive');
  assert.match(found.text, /a very distinctive sentence/);

  const byAuthor = await admin.get('/admin/content?author=contentauthor');
  assert.match(byAuthor.text, /a very distinctive sentence/);

  const removed = await admin.post(`/admin/tweets/${created.body.tweet.id}/delete`)
    .type('form').send({ _csrf: admin.csrfToken });
  assert.equal(removed.status, 302);

  const gone = await admin.get('/admin/content?q=distinctive');
  assert.ok(!gone.text.includes('a very distinctive sentence'));
});

// ---------------------------------------------------------------- system ---

test('closing sign-ups takes effect without a restart', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'gateadmin', 'admin');

  assert.equal((await request(app).get('/register')).status, 200);

  await admin.post('/admin/system/settings').type('form')
    .send({ _csrf: admin.csrfToken, announcement: '', announcement_level: 'info' });

  const closed = await request(app).get('/register');
  assert.equal(closed.status, 403);
  assert.match(closed.text, /not accepting new accounts/);

  const refused = await helpers.agentFor(app);
  const attempt = await helpers.register(refused, { username: 'toolate' });
  assert.equal(attempt.status, 403);

  // And the landing page stops advertising a form it would refuse.
  const landing = await request(app).get('/');
  assert.ok(!landing.text.includes('Sign up for Twiq'));

  await admin.post('/admin/system/settings').type('form')
    .send({ _csrf: admin.csrfToken, registration_open: 'on', announcement: '', announcement_level: 'info' });
  assert.equal((await request(app).get('/register')).status, 200);
});

test('read-only mode pauses writing without closing the site', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'roadmin', 'admin');
  const member = await helpers.signedUpAgent(app, 'romember');

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', read_only: 'on',
    announcement: '', announcement_level: 'info',
  });

  // Reading is untouched, and the banner explains why.
  const home = await member.get('/home');
  assert.equal(home.status, 200);
  assert.match(home.text, /read-only at the moment/);
  assert.equal((await request(app).get('/')).status, 200);

  const blocked = await member.post('/tweets')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: member.csrfToken, body: 'should not post' });
  assert.equal(blocked.status, 503);

  // Staff stay able to act, and signing out still works.
  const staffPost = await admin.post('/tweets').type('form')
    .send({ _csrf: admin.csrfToken, body: 'moderators are exempt' });
  assert.equal(staffPost.status, 302);
  assert.equal((await member.post('/logout').type('form').send({ _csrf: member.csrfToken })).status, 302);

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', announcement: '', announcement_level: 'info',
  });
});

test('an announcement appears on every page and is escaped', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'bannaradmin', 'admin');

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken,
    registration_open: 'on',
    announcement: 'Maintenance <b>tonight</b> at 23:00 UTC.',
    announcement_level: 'critical',
  });

  for (const path of ['/', '/login', '/discover']) {
    const page = await request(app).get(path);
    assert.match(page.text, /announcement-critical/, `${path} should carry the banner`);
    assert.match(page.text, /Maintenance &lt;b&gt;tonight&lt;\/b&gt;/, 'the banner must be escaped');
    assert.ok(!page.text.includes('Maintenance <b>tonight</b>'));
  }

  await admin.post('/admin/system/settings').type('form')
    .send({ _csrf: admin.csrfToken, registration_open: 'on', announcement: '', announcement_level: 'info' });
  assert.ok(!(await request(app).get('/')).text.includes('announcement-critical'));
});

test('the recount tool repairs counters that have drifted', async () => {
  const db = require('../src/config/db');
  const admin = await staffAgent(app, 'countadmin', 'admin');
  const member = await helpers.signedUpAgent(app, 'countmember');
  await member.post('/api/tweets').set('X-CSRF-Token', member.csrfToken).send({ body: 'one' });
  await member.post('/api/tweets').set('X-CSRF-Token', member.csrfToken).send({ body: 'two' });

  // Simulate a counter left behind by a crash mid-transaction.
  await db.query(`UPDATE users SET tweet_count = 99 WHERE username = 'countmember'`);

  const before = await admin.get('/admin/system');
  assert.match(before.text, /account.? currently adrift/);

  const fixed = await admin.post('/admin/system/maintenance/recount').type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(fixed.status, 302);

  const row = await db.one(`SELECT tweet_count FROM users WHERE username = 'countmember'`);
  assert.equal(row.tweet_count, 2);

  const after = await admin.get('/admin/system');
  assert.match(after.text, /Everything is in step/);
});

test('an unknown maintenance task is refused', async () => {
  const admin = await staffAgent(app, 'taskadmin', 'admin');
  const response = await admin.post('/admin/system/maintenance/drop-everything')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: admin.csrfToken });
  assert.equal(response.status, 404);
});

test('every panel action needs a CSRF token', async () => {
  const admin = await staffAgent(app, 'csrfadmin', 'admin');
  await helpers.signedUpAgent(app, 'csrftarget');

  const paths = [
    '/admin/users/csrftarget/suspend',
    '/admin/users/csrftarget/role',
    '/admin/system/settings',
    '/admin/system/maintenance/recount',
  ];
  for (const path of paths) {
    const response = await admin.post(path).type('form').send({ role: 'admin' });
    assert.equal(response.status, 403, `${path} should refuse a tokenless post`);
  }
});

// ----------------------------------------------------------- maintenance ---

test('maintenance mode takes the site down with a 503 and the notice page', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'downadmin', 'admin');
  const member = await helpers.signedUpAgent(app, 'downmember');

  assert.equal((await request(app).get('/')).status, 200);

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', maintenance: 'on',
    status_url: '/help', announcement: '', announcement_level: 'info',
  });

  for (const path of ['/', '/home', '/downmember', '/discover', '/search?q=x']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 503, `${path} should be closed`);
    assert.match(response.text, /is currently down for maintenance/);
    assert.equal(response.headers['retry-after'], '600');
  }

  // A signed-in member is closed out too, not just anonymous visitors.
  const shutOut = await member.get('/home');
  assert.equal(shutOut.status, 503);

  // Asserted, so a request that never landed says so here rather than
  // reappearing as an unexplained 503 on the line below.
  const reopened = await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', announcement: '', announcement_level: 'info',
  });
  assert.equal(reopened.status, 302, 'the settings form should have been accepted');
  assert.equal((await request(app).get('/')).status, 200);
});

test('signing in, the panel and the health check survive maintenance mode', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'lockadmin', 'admin');

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', maintenance: 'on',
    status_url: '/help', announcement: '', announcement_level: 'info',
  });

  // Without these three, maintenance mode would be a locked door with the key
  // inside: no way to sign in and turn it off, and a container the health
  // check declares dead.
  assert.equal((await request(app).get('/login')).status, 200);
  assert.equal((await request(app).get('/healthz')).status, 200);
  assert.equal((await admin.get('/admin/system')).status, 200);

  // Staff keep seeing the real site, with a banner saying why.
  const home = await admin.get('/home');
  assert.equal(home.status, 200);
  assert.match(home.text, /Maintenance mode is on/);

  // And an administrator can still sign in from scratch while it is on.
  const fresh = await helpers.agentFor(app);
  const signedIn = await fresh.post('/login').type('form')
    .send({ _csrf: fresh.csrfToken, identifier: 'lockadmin', password: 'correct horse battery' });
  assert.equal(signedIn.status, 302);

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', announcement: '', announcement_level: 'info',
  });
});

test('the maintenance page carries the notice, the links and no product chrome', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'copyadmin', 'admin');

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', maintenance: 'on',
    status_url: 'https://status.example.com', announcement: '', announcement_level: 'info',
  });

  const page = await request(app).get('/');
  assert.match(page.text, /<h1>Twiq is currently down for maintenance\.<\/h1>/);
  assert.match(page.text, /We expect to be back shortly/);
  assert.match(page.text, /href="https:\/\/status\.example\.com"><strong>Twiq Status<\/strong>/);
  assert.match(page.text, /Thanks for your patience!/);
  // The template writes the entity, not the literal character.
  assert.match(page.text, new RegExp(`&copy; ${new Date().getUTCFullYear()} Twiq`));
  for (const link of ['/about', '/help', '/terms', '/privacy']) {
    assert.match(page.text, new RegExp(`href="${link}"`), `the footer should link ${link}`);
  }
  assert.match(page.text, /Back home/);
  assert.match(page.text, /maintenance-art/);
  assert.match(page.text, /noindex, nofollow/);

  // None of the ordinary chrome leaks onto it.
  assert.ok(!page.text.includes('class="topbar"'));
  assert.ok(!page.text.includes('data-compose-modal'));

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', announcement: '', announcement_level: 'info',
  });
});

test('a custom maintenance message replaces the default line and is escaped', async () => {
  const request = require('supertest');
  const admin = await staffAgent(app, 'msgadmin', 'admin');

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', maintenance: 'on',
    maintenance_message: 'Back at 23:00 UTC <b>sharp</b>.',
    announcement: '', announcement_level: 'info',
  });

  const page = await request(app).get('/');
  assert.match(page.text, /Back at 23:00 UTC &lt;b&gt;sharp&lt;\/b&gt;\./);
  assert.ok(!page.text.includes('Back at 23:00 UTC <b>sharp</b>'));
  assert.ok(!page.text.includes('We expect to be back shortly'));

  await admin.post('/admin/system/settings').type('form').send({
    _csrf: admin.csrfToken, registration_open: 'on', maintenance_message: '',
    announcement: '', announcement_level: 'info',
  });
});

test('only an administrator can take the site down', async () => {
  const request = require('supertest');
  const mod = await staffAgent(app, 'modcannot', 'moderator');

  const attempt = await mod.post('/admin/system/settings').type('form')
    .send({ _csrf: mod.csrfToken, maintenance: 'on' });
  assert.equal(attempt.status, 404);
  assert.equal((await request(app).get('/')).status, 200);
});
