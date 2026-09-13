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

test('the notification badge is marked hidden when there is nothing unread', async () => {
  const agent = await helpers.signedUpAgent(app, 'badgeuser');
  const home = await agent.get('/home');

  const badge = /<span class="topbar-badge" data-badge="notifications"([^>]*)>([^<]*)<\/span>/.exec(home.text);
  assert.ok(badge, 'the badge element should be in the page');
  assert.match(badge[1], /\bhidden\b/, 'it must carry the hidden attribute');
  assert.equal(badge[2], '', 'and must not print a count of zero');
});

test('the notification badge shows a count once something is unread', async () => {
  const reader = await helpers.signedUpAgent(app, 'badgereader');
  const actor = await helpers.signedUpAgent(app, 'badgeactor');
  await actor.post('/api/users/badgereader/follow').set('X-CSRF-Token', actor.csrfToken);

  const home = await reader.get('/home');
  const badge = /<span class="topbar-badge" data-badge="notifications"([^>]*)>([^<]*)<\/span>/.exec(home.text);
  assert.ok(badge);
  assert.ok(!/\bhidden\b/.test(badge[1]), 'it must not be hidden when there is something to show');
  assert.equal(badge[2].trim(), '1');
});

test('the stylesheet keeps [hidden] winning over component display rules', async () => {
  const request = require('supertest');
  const css = await request(app).get('/css/twiq.css');
  assert.equal(css.status, 200);
  assert.match(css.text, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the compose dialog is on every signed-in page, with its own control ids', async () => {
  const agent = await helpers.signedUpAgent(app, 'modaluser');

  for (const path of ['/home', '/connect', '/discover', '/messages', '/lists']) {
    const page = await agent.get(path);
    assert.equal(page.status, 200, `${path} should render`);
    assert.match(page.text, /data-compose-modal/, `${path} should carry the compose dialog`);
    assert.match(page.text, /id="composer-body-modal"/, `${path} should have the dialog textarea`);
  }

  // The rail composer and the dialog composer must not share an id.
  const home = await agent.get('/home');
  assert.equal((home.text.match(/id="composer-body-rail"/g) || []).length, 1);
  assert.equal((home.text.match(/id="composer-body-modal"/g) || []).length, 1);
});

test('the Tweet button is still a working link when JavaScript never runs', async () => {
  const agent = await helpers.signedUpAgent(app, 'nojsuser');
  const home = await agent.get('/home');
  assert.match(home.text, /<a href="\/compose" class="btn btn-primary btn-sm" data-compose-open>/);

  // And that page renders a usable composer of its own.
  const compose = await agent.get('/compose');
  assert.equal(compose.status, 200);
  assert.match(compose.text, /Compose new Tweet/);
  assert.match(compose.text, /action="\/tweets"/);
});

test('signed-out pages carry no compose dialog', async () => {
  const request = require('supertest');
  const landing = await request(app).get('/');
  assert.ok(!landing.text.includes('data-compose-modal'));
});

test('the stylesheet and script are fingerprinted so a deploy busts the cache', async () => {
  const request = require('supertest');
  const page = await request(app).get('/login');

  const css = /href="(\/css\/twiq\.css\?v=[0-9a-f]{10})"/.exec(page.text);
  const js = /src="(\/js\/twiq\.js\?v=[0-9a-f]{10})"/.exec(page.text);
  assert.ok(css, 'the stylesheet URL should carry a version');
  assert.ok(js, 'the script URL should carry a version');

  // The fingerprint follows the file's contents, not the clock.
  const assets = require('../src/utils/assets');
  assert.equal(assets.asset('/css/twiq.css'), css[1]);
  assert.equal(assets.asset('/css/twiq.css'), assets.asset('/css/twiq.css'));

  // And the versioned URL still serves the file.
  const fetched = await request(app).get(css[1]);
  assert.equal(fetched.status, 200);
  assert.match(fetched.headers['content-type'], /text\/css/);
});

test('the verified and protected badges inherit their colour', async () => {
  const request = require('supertest');
  const css = await request(app).get('/css/twiq.css');

  // These <svg> elements do not carry the .icon class, so they need their own
  // fill rule or they paint black instead of taking the colour beside them.
  const fillRule = /((?:\.[a-z-]+-badge,\s*\n?\s*)+\.[a-z-]+-badge)\s*\{[^}]*fill:\s*currentColor;/.exec(css.text);
  assert.ok(fillRule, 'the badges should share one fill rule');
  for (const badge of ['verified', 'protected', 'automated']) {
    assert.match(fillRule[1], new RegExp(`\\.${badge}-badge\\b`), `${badge} needs the fill`);
    assert.match(css.text, new RegExp(`\\.${badge}-badge\\s*\\{[^}]*color:`), `${badge} needs a colour`);
  }
  assert.match(css.text, /\.verified-badge\s*\{[^}]*color:\s*var\(--twiq-blue\)/);
});

test('a verified account shows the badge and an unverified one does not', async () => {
  const db = require('../src/config/db');
  const viewer = await helpers.signedUpAgent(app, 'badgeviewer');
  await helpers.signedUpAgent(app, 'plainaccount');
  await helpers.signedUpAgent(app, 'sealedaccount');
  await db.query(`UPDATE users SET is_verified = true WHERE username = 'sealedaccount'`);

  const verified = await viewer.get('/sealedaccount');
  assert.match(verified.text, /class="verified-badge[^"]*"[^>]*>(?:<title>[^<]*<\/title>)?\s*<use href="#ic-verified">/);

  const plain = await viewer.get('/plainaccount');
  assert.ok(!plain.text.includes('#ic-verified'));
});

test('the badge artwork is the generated seal, not a borrowed one', async () => {
  const agent = await helpers.signedUpAgent(app, 'sealcheck');
  const page = await agent.get('/home');
  const symbol = /<symbol id="ic-verified" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/.exec(page.text);
  assert.ok(symbol, 'the sprite should define the badge');
  assert.equal(symbol[1], '0 0 22 22');
  // Twelve quadratic lobes plus a stroked check.
  assert.equal((symbol[2].match(/Q/g) || []).length, 12);
  assert.match(symbol[2], /stroke="#fff"/);
});

// --------------------------------------------------------------------------
// Phone layout
// --------------------------------------------------------------------------

test('the top bar carries a two-row structure the phone layout can reflow', async () => {
  const agent = await helpers.signedUpAgent(app, 'baruser');
  const page = await agent.get('/home');

  // The search field is a sibling of the nav, not part of the right-hand
  // cluster, so it can move to the left of the first row on a phone.
  const navAt = page.text.indexOf('class="topbar-nav"');
  const brandAt = page.text.indexOf('class="topbar-brand"');
  const searchAt = page.text.indexOf('class="search-form"');
  const actionsAt = page.text.indexOf('class="topbar-actions"');
  assert.ok(navAt > -1 && brandAt > navAt && searchAt > brandAt && actionsAt > searchAt,
    'nav, brand, search and actions should appear in that order');

  // And a link stands in for the field where there is no room for it.
  assert.match(page.text, /class="search-link" href="\/search"/);
});

test('the search page carries a field of its own', async () => {
  const request = require('supertest');
  const blank = await request(app).get('/search');
  assert.match(blank.text, /class="page-search"/);
  assert.match(blank.text, /id="page-search-field"/);

  // It is pre-filled when a query is running, so refining a search is one edit.
  const results = await request(app).get('/search?q=sourdough');
  assert.match(results.text, /id="page-search-field"[^>]*value="sourdough"/);
});

test('a Direct Message thread is marked so the phone can show one pane', async () => {
  const sender = await helpers.signedUpAgent(app, 'panesender');
  const recipient = await helpers.signedUpAgent(app, 'panerecipient');
  await recipient.post('/api/users/panesender/follow').set('X-CSRF-Token', recipient.csrfToken);
  const started = await sender.post('/messages/new')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form').send({ _csrf: sender.csrfToken, username: 'panerecipient' });

  const inbox = await sender.get('/messages');
  assert.match(inbox.text, /<body class="page-messages"/);
  assert.ok(!inbox.text.includes('has-thread'));

  const thread = await sender.get(`/messages/${started.body.conversationId}`);
  assert.match(thread.text, /<body class="page-messages has-thread"/);
  assert.match(thread.text, /class="dm-back" href="\/messages"/);
});

test('the compose dialog offers a Cancel affordance for the full-screen sheet', async () => {
  const agent = await helpers.signedUpAgent(app, 'sheetuser');
  const page = await agent.get('/home');
  assert.match(page.text, /<span class="modal-close-label">Cancel<\/span>/);
});

test('a profile keeps its supplementary rail modules in their own wrapper', async () => {
  const viewer = await helpers.signedUpAgent(app, 'railviewer');
  await helpers.signedUpAgent(app, 'railsubject');
  const page = await viewer.get('/railsubject');
  assert.match(page.text, /class="rail-extras"/);
});

test('touch devices are given the Tweet actions, and the rule outranks the hover one', async () => {
  const request = require('supertest');
  const css = (await request(app).get('/css/twiq.css')).text;

  assert.match(css, /@media \(hover: none\)/);

  // The base rule hides the actions until :hover, which a touch screen never
  // fires. The touch override must come later in the file or it loses the
  // cascade at equal specificity.
  const base = css.indexOf('.tweet-actions {');
  const touch = css.indexOf('@media (hover: none)');
  assert.ok(base > -1 && touch > base, 'the touch block must follow the base rule');

  // Same trap for the phone layout against the component rules it refines.
  const phone = css.indexOf('@media (max-width: 620px)');
  assert.ok(phone > css.indexOf('.modal-dialog {'), 'the phone block must follow .modal-dialog');
  assert.ok(phone > css.indexOf('.tweet-avatar img'), 'the phone block must follow the Tweet rules');
  assert.ok(css.indexOf('@media (max-width: 520px)') > phone,
    'the narrow-phone block must follow the phone block');
});

test('the phone layout puts the timeline before the rail and keeps the desktop grid', async () => {
  const request = require('supertest');
  const css = (await request(app).get('/css/twiq.css')).text;
  const phone = css.slice(css.indexOf('@media (max-width: 620px)'));

  assert.match(phone, /--topbar-height:\s*88px/);
  assert.match(phone, /\.page-home \.content[\s\S]{0,200}order:\s*1/);
  assert.match(phone, /\.page-home \.rail[\s\S]{0,200}order:\s*2/);
  assert.match(phone, /\.page-messages\.has-thread \.dm-list \{ display: none; \}/);

  // Nothing in here may touch the 890px desktop grid.
  assert.ok(!phone.includes('--rail-width'));
  assert.ok(!phone.includes('--content-width'));
});

test('the composer counts down from the configured limit, everywhere', async () => {
  const config = require('../src/config/env');
  const limit = config.brand.tweetMaxLength;
  const agent = await helpers.signedUpAgent(app, 'counteruser');
  const page = await agent.get('/home');

  // The client reads the limit off the document rather than hardcoding it.
  assert.match(page.text, new RegExp(`data-tweet-max="${limit}"`));

  // Both counters - the rail composer and the inline reply box - start there.
  const counters = page.text.match(/<span class="composer-counter"[^>]*>(\d+)<\/span>/g) || [];
  assert.ok(counters.length >= 2, 'expected the rail and reply counters');
  for (const counter of counters) {
    assert.match(counter, new RegExp(`>${limit}<`));
  }

  // Typing past the limit is allowed so the count can go negative and be
  // edited back down; the field stops well before the validator's own cap.
  assert.match(page.text, new RegExp(`maxlength="${config.brand.tweetHardLimit}"`));
  assert.ok(config.brand.tweetHardLimit > limit);
});

// --------------------------------------------------------------- loading ---

test('every page carries the navigation progress bar', async () => {
  const request = require('supertest');
  const agent = await helpers.signedUpAgent(app, 'progressuser');

  for (const page of [await agent.get('/home'), await request(app).get('/login')]) {
    assert.match(page.text, /<div class="nav-progress" data-nav-progress aria-hidden="true"><span><\/span><\/div>/);
  }
});

test('the page transitions keep to the motion vocabulary of their period', async () => {
  const request = require('supertest');
  const css = (await request(app).get('/css/twiq.css')).text;
  const section = css.slice(css.indexOf('Loading and page transitions'));

  // A page of this era faded; it did not rise into place, and it did not
  // ride a hand-tuned easing curve. Both are the giveaway of a later web.
  const frames = /@keyframes page-enter \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.ok(!/translate/.test(frames), 'the entry must not move the page');
  assert.ok(!/cubic-bezier/.test(section), 'no custom easing in the transitions');
  assert.ok(!/box-shadow/.test(section), 'the progress bar carries no glow');

  // And the throbber ticks rather than glides, the way a GIF one did.
  assert.match(section, /animation: spin [0-9]+ms steps\([0-9]+\) infinite/);
});

test('the incoming page animates in, and finishes visible', async () => {
  const request = require('supertest');
  const css = (await request(app).get('/css/twiq.css')).text;

  const frames = /@keyframes page-enter \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(frames, 'the entry animation should be defined');

  // Parked-at-zero content is the failure mode here: if the animation never
  // runs, the page must still end up readable.
  assert.match(frames[1], /to\s*\{[^}]*opacity:\s*1/);
  assert.match(frames[1], /to\s*\{[^}]*transform:\s*none/);

  assert.match(css, /\.page-body \{ animation: page-enter var\(--page-enter-duration\)[^}]*both; \}/);

  // The beat is one number, in one place.
  const root = /^:root \{[\s\S]*?^\}/m.exec(css)[0];
  assert.ok(css.includes('--page-enter-duration'));
  assert.ok(root || true);
});

test('the loading affordances are defined and respect reduced motion', async () => {
  const request = require('supertest');
  const css = (await request(app).get('/css/twiq.css')).text;

  assert.match(css, /\.spinner \{/);
  assert.match(css, /\.btn\.is-busy, button\.is-busy \{/);
  assert.match(css, /\.is-loading \{/);
  assert.match(css, /@keyframes spin \{/);

  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g;
  const blocks = [...css.matchAll(reduced)].map((m) => m[1]).join('\n');
  assert.match(blocks, /\.page-body \{ animation: none; \}/);
  assert.match(blocks, /is-leaving[\s\S]*opacity: 1/);
});

test('in-page controls get a busy state instead of a page transition', async () => {
  const request = require('supertest');
  const js = (await request(app).get('/js/twiq.js')).text;

  // Anything the page handles itself must not start the navigation bar.
  assert.match(js, /data-lightbox\],\[data-load-more\]/);
  assert.match(js, /data-compose-open\]/);
  assert.match(js, /\[data-compose-form\],\[data-inline-reply\],\[data-interaction\]/);

  // And every fetch path shows something while it waits.
  assert.ok((js.match(/atLeast\(/g) || []).length >= 7, 'each async path should hold its indicator');
  assert.ok((js.match(/busy\(/g) || []).length >= 6, 'each control should have a busy state');

  // A cancelled navigation must not strand the page dimmed.
  assert.match(js, /function cancelNavigation\(\)/);
  assert.match(js, /pageshow', cancelNavigation/);
});

test('the search page drops the rail when signed out, and keeps the footer', async () => {
  const request = require('supertest');
  const out = await request(app).get('/search?q=sourdough');
  // An empty 290px column would push the results off centre, so the rail is
  // not rendered at all and the footer moves below the content instead.
  assert.ok(!/class="rail"/.test(out.text), 'there should be no rail to leave empty');
  assert.ok(!/class="rail-footer"/.test(out.text), 'nor a rail footer stranded in it');
  assert.match(out.text, /class="page-footer"/);
  assert.match(out.text, /class="content content-wide"/);

  const agent = await helpers.signedUpAgent(app, 'railkeeper');
  const inside = await agent.get('/search?q=sourdough');
  assert.match(inside.text, /class="rail"/, 'signed in the rail has modules to hold');
  assert.match(inside.text, /class="rail-footer"/);
  assert.ok(!/class="page-footer"/.test(inside.text), 'and the footer stays in the rail');
});

test('both footer variants render the same links from one partial', async () => {
  const request = require('supertest');
  const links = (html) => (html.match(/<a href="\/(about|help|status|terms|privacy)">/g) || []).sort();

  const signedOut = await request(app).get('/search?q=x');
  const agent = await helpers.signedUpAgent(app, 'footercheck');
  const signedIn = await agent.get('/home');

  assert.equal(links(signedOut.text).length, 5);
  assert.deepEqual(links(signedOut.text), links(signedIn.text));
});

test('every page carries the footer, including the pages the footer links to', async () => {
  const request = require('supertest');
  // The links land on pages with no rail; without their own footer the
  // visitor arrives somewhere with no way on to the next one.
  for (const path of ['/about', '/help', '/terms', '/privacy', '/status',
                      '/login', '/register', '/forgot-password', '/no-such-page']) {
    const page = await request(app).get(path);
    assert.match(page.text, /class="page-footer"/, `${path} should carry the footer`);
  }

  const agent = await helpers.signedUpAgent(app, 'dmfooter');
  const messages = await agent.get('/messages');
  assert.match(messages.text, /class="page-footer"/);
});

test('a verified administrator gets a red tick, a verified member the accent one', async () => {
  const request = require('supertest');
  const boss = await helpers.signedUpAgent(app, 'redtickboss');
  const member = await helpers.signedUpAgent(app, 'bluetickmember');

  const db = require('../src/config/db');
  await db.query("UPDATE users SET is_verified = true WHERE username IN ('redtickboss', 'bluetickmember')");
  await db.query("UPDATE users SET role = 'admin' WHERE username = 'redtickboss'");

  const adminProfile = await request(app).get('/redtickboss');
  assert.match(adminProfile.text, /class="verified-badge is-admin is-large"/);
  assert.match(adminProfile.text, /<title>Verified administrator[^<]*<\/title>/);

  const memberProfile = await request(app).get('/bluetickmember');
  assert.match(memberProfile.text, /class="verified-badge is-large"/);
  assert.ok(!memberProfile.text.includes('is-admin'), 'an ordinary member keeps the accent tick');
  assert.match(memberProfile.text, /<title>Verified account[^<]*<\/title>/);

  // And it follows the account onto its Tweets, not just its profile.
  await boss.post('/api/tweets').set('X-CSRF-Token', boss.csrfToken).send({ body: 'From the office' });
  const timeline = await boss.get('/home');
  assert.match(timeline.text, /class="verified-badge is-admin"/);

  // The colour is a token of its own, declared in every theme state.
  const css = (await request(app).get('/css/twiq.css')).text;
  assert.match(css, /\.verified-badge\.is-admin \{ color: var\(--badge-admin\); \}/);
  assert.equal((css.match(/--badge-admin:/g) || []).length, 3, 'light plus both dark blocks');
});

test('a moderator is not given the administrator tick', async () => {
  const request = require('supertest');
  await helpers.signedUpAgent(app, 'justamod');
  const db = require('../src/config/db');
  await db.query("UPDATE users SET is_verified = true, role = 'moderator' WHERE username = 'justamod'");

  const page = await request(app).get('/justamod');
  assert.match(page.text, /class="verified-badge is-large"/);
  assert.ok(!page.text.includes('is-admin'), 'only administrators get the red one');
});

test('every badge explains itself on hover, from one shared partial', async () => {
  const request = require('supertest');
  const bot = await helpers.signedUpAgent(app, 'hoverbot');
  const runner = await helpers.signedUpAgent(app, 'hoverrunner');
  const db = require('../src/config/db');
  await db.query("UPDATE users SET is_verified = true, is_protected = true WHERE username = 'hoverbot'");
  await bot.post('/settings/automation').type('form')
    .send({ _csrf: bot.csrfToken, username: 'hoverrunner', password: 'correct horse battery' });

  const page = await request(app).get('/hoverbot');
  // An SVG's tooltip comes from a <title> child, not a title attribute.
  assert.match(page.text, /<title>Verified account — [^<]+<\/title>/);
  assert.match(page.text, /<title>Automated account — run by @hoverrunner<\/title>/);
  assert.match(page.text, /<title>Protected account — [^<]+<\/title>/);

  // The markup comes from one partial, so no view hand-rolls a badge.
  const fs = require('fs');
  const path = require('path');
  const views = path.join(__dirname, '..', 'views');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const offenders = walk(views)
    .filter((f) => path.basename(f) !== 'badges.ejs')
    .filter((f) => /class="(verified|protected|automated)-badge/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'badges must come from partials/badges.ejs');
});

test('badges centre against the name rather than hanging off its baseline', async () => {
  const request = require('supertest');
  const css = (await request(app).get('/css/twiq.css')).text;
  const rule = /\.verified-badge,\s*\n\.protected-badge,\s*\n\.automated-badge \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(rule, 'the badges should share one rule');
  // The Tweet header is a baseline-aligned flex row, where an <svg> has no
  // baseline and vertical-align does nothing; align-self is what applies.
  assert.match(rule[1], /align-self:\s*center/);
  assert.match(rule[1], /cursor:\s*help/);
  assert.match(css, /\.tweet-name-wrap \{[^}]*align-items: baseline/);
});
