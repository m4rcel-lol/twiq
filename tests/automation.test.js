'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let app;

test.before(async () => {
  await helpers.prepare();
  app = helpers.createApp();
});
test.beforeEach(async () => helpers.truncate());
test.after(async () => helpers.close());

const PASSWORD = 'correct horse battery';

async function claim(agent, username, password) {
  return agent.post('/settings/automation').type('form')
    .send({ _csrf: agent.csrfToken, username, password });
}

test('naming an operator needs that account\'s own password', async () => {
  const bot = await helpers.signedUpAgent(app, 'thebot');
  await helpers.signedUpAgent(app, 'theoperator');

  const wrong = await claim(bot, 'theoperator', 'not the password');
  assert.equal(wrong.status, 302);
  const refused = await bot.get('/settings/automation');
  assert.ok(!refused.text.includes('Automated by'), 'the claim must not stick');

  const right = await claim(bot, 'theoperator', PASSWORD);
  assert.equal(right.status, 302);
  const saved = await bot.get('/settings/automation');
  assert.match(saved.text, /Automated by/);
  assert.match(saved.text, /@theoperator/);
});

test('the label shows on the profile and beside every Tweet', async () => {
  const bot = await helpers.signedUpAgent(app, 'labelbot');
  await helpers.signedUpAgent(app, 'labelrunner');
  await bot.post('/api/tweets').set('X-CSRF-Token', bot.csrfToken).send({ body: 'Beep' });
  await claim(bot, 'labelrunner', PASSWORD);

  const profile = await bot.get('/labelbot');
  assert.match(profile.text, /class="profile-automated"/);
  assert.match(profile.text, /Automated by\s*<a href="\/labelrunner">@labelrunner<\/a>/);

  // The robot mark rides with the display name wherever a Tweet is shown.
  assert.match(profile.text, /class="automated-badge"[^>]*aria-label="Automated account"/);
  const home = await bot.get('/home');
  assert.match(home.text, /class="automated-badge"/);
});

test('an unclaimed account carries no robot mark anywhere', async () => {
  const plain = await helpers.signedUpAgent(app, 'plainaccount');
  await plain.post('/api/tweets').set('X-CSRF-Token', plain.csrfToken).send({ body: 'Typed by hand' });

  const profile = await plain.get('/plainaccount');
  assert.ok(!profile.text.includes('automated-badge'));
  assert.ok(!profile.text.includes('profile-automated'));
});

test('a wrong password and an unknown account are refused the same way', async () => {
  const bot = await helpers.signedUpAgent(app, 'enumbot');
  await helpers.signedUpAgent(app, 'realoperator');

  // The flash is read once, so each attempt is collected straight away.
  const attempt = async (username) => {
    const res = await claim(bot, username, 'wrong');
    const page = await bot.get('/settings/automation');
    const flash = /<div class="flash[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(page.text);
    return { status: res.status, message: flash ? flash[1].trim() : '' };
  };

  const wrongPassword = await attempt('realoperator');
  const noSuchAccount = await attempt('nobodyhere');

  // Same status and the same words, so the form cannot be used to find out
  // which usernames exist.
  assert.equal(wrongPassword.status, noSuchAccount.status);
  assert.match(wrongPassword.message, /did not match an account/);
  assert.equal(wrongPassword.message, noSuchAccount.message);
});

test('an account cannot declare itself automated by itself', async () => {
  const lonely = await helpers.signedUpAgent(app, 'lonelybot');
  await claim(lonely, 'lonelybot', PASSWORD);
  const page = await lonely.get('/settings/automation');
  assert.match(page.text, /cannot be automated by itself/);
  assert.ok(!page.text.includes('class="automation-current"'));
});

test('the label can be removed without any password at all', async () => {
  const bot = await helpers.signedUpAgent(app, 'freebot');
  await helpers.signedUpAgent(app, 'freerunner');
  await claim(bot, 'freerunner', PASSWORD);
  assert.match((await bot.get('/settings/automation')).text, /automation-current/);

  await bot.post('/settings/automation/clear').type('form').send({ _csrf: bot.csrfToken });
  const after = await bot.get('/settings/automation');
  assert.ok(!after.text.includes('automation-current'));
  assert.ok(!(await bot.get('/freebot')).text.includes('profile-automated'));
});

test('the claim never reaches the log, and grants no access either way', async () => {
  const bot = await helpers.signedUpAgent(app, 'quietbot');
  const runner = await helpers.signedUpAgent(app, 'quietrunner');
  await claim(bot, 'quietrunner', PASSWORD);

  // Naming someone does not let either account act as the other.
  const asBot = await bot.get('/settings/account');
  assert.match(asBot.text, /quietbot/);
  assert.ok(!asBot.text.includes('quietrunner@'), 'the bot sees its own account only');

  // And the operator's own session is untouched by being named.
  const asRunner = await runner.get('/settings/automation');
  assert.ok(!asRunner.text.includes('automation-current'));
});
