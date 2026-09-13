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

async function css() {
  const request = require('supertest');
  return (await request(app).get('/css/twiq.css')).text;
}

// ----------------------------------------------------------- search box ---

test('the search field is centred in the bar rather than stretched by it', async () => {
  const sheet = await css();
  const rule = /\.search-form \{([^}]+)\}/.exec(sheet);
  assert.ok(rule, 'the search form should have a rule of its own');

  // .topbar-inner stretches its children, so the field has to centre itself
  // or it sits flush against the top edge of the 46px bar.
  assert.match(rule[1], /align-self:\s*center/);
  assert.match(rule[1], /position:\s*relative/);

  // The dropdown hangs off the bottom of the field, not a guessed offset.
  const typeahead = /\.typeahead \{([^}]+)\}/.exec(sheet);
  assert.match(typeahead[1], /top:\s*calc\(100% \+ \d+px\)/);
  assert.ok(!/\.typeahead \{[^}]*top:\s*30px/.test(sheet));

  // The submit button centres on the field at whatever height it ends up.
  const button = /\.search-form button \{([^}]+)\}/.exec(sheet);
  assert.match(button[1], /top:\s*50%/);
  assert.match(button[1], /transform:\s*translateY\(-50%\)/);
});

// ---------------------------------------------------------- dark theme ---

test('light is the default, and dark only applies when it is asked for', async () => {
  const sheet = await css();

  // The base block states light outright, so an unstamped document stays
  // light no matter what the reader's operating system prefers.
  const root = /^:root \{([\s\S]*?)^\}/m.exec(sheet)[1];
  assert.match(root, /color-scheme:\s*light/);

  // Dark needs an explicit stamp...
  assert.match(sheet, /:root\[data-theme="dark"\] \{/);
  // ...and following the system is its own stamp, not the fallback.
  assert.match(sheet, /@media \(prefers-color-scheme: dark\) \{\s*:root\[data-theme="system"\]/);

  // Nothing may darken a document that carries no stamp at all.
  assert.ok(!/:root:not\(\[data-theme="light"\]\)/.test(sheet),
    'an unstamped document must never be darkened by the media query');
});

test('every themed token is declared in the base :root block first', async () => {
  const sheet = await css();
  const root = /^:root \{([\s\S]*?)^\}/m.exec(sheet)[1];
  const dark = /:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m.exec(sheet)[1];

  const declared = new Set([...root.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const overridden = [...dark.matchAll(/(--[\w-]+):/g)].map((m) => m[1]);

  // A token that exists only inside a theme block is undefined for every
  // reader who has not chosen that theme - the classic unreadable-page bug.
  for (const token of overridden) {
    assert.ok(declared.has(token), `${token} must be declared in :root before a theme redefines it`);
  }
  assert.ok(overridden.length > 25, 'the dark theme should redefine the whole surface set');
});

test('the primary button keeps a face dark enough for its white text', async () => {
  const sheet = await css();
  // Brightening the accent for dark surfaces would otherwise drop white
  // button text to about 2.3:1, so the button face is its own token.
  assert.match(sheet, /--btn-primary-top:/);
  assert.match(sheet, /--btn-primary-bottom:/);
  const rule = /\.btn-primary \{([^}]+)\}/.exec(sheet)[1];
  assert.match(rule, /var\(--btn-primary-top\)/);
  assert.ok(!/linear-gradient\(var\(--twiq-blue\), var\(--twiq-blue-dark\)\)/.test(rule));
});

test('a signed-out visitor gets the light theme', async () => {
  const request = require('supertest');
  for (const path of ['/', '/login', '/status', '/discover']) {
    const page = await request(app).get(path);
    // No stamp means light, which is what the base block declares.
    assert.match(page.text, /<html lang="en">/, `${path} should render light`);
    assert.ok(!page.text.includes('data-theme='), `${path} should carry no theme stamp`);
  }
});

test('a member can choose a theme and it reaches the document', async () => {
  const agent = await helpers.signedUpAgent(app, 'themeuser');

  // A new account is light, and light carries no attribute.
  let page = await agent.get('/home');
  assert.match(page.text, /<html lang="en">/);
  assert.ok(!page.text.includes('data-theme='));

  await agent.post('/settings/design').type('form').send({
    _csrf: agent.csrfToken, theme: 'dark',
    accent_color: '#3fa9e0', background_color: '#f5f8fa',
  });
  page = await agent.get('/home');
  assert.match(page.text, /<html lang="en" data-theme="dark">/);

  await agent.post('/settings/design').type('form').send({
    _csrf: agent.csrfToken, theme: 'system',
    accent_color: '#3fa9e0', background_color: '#f5f8fa',
  });
  page = await agent.get('/home');
  assert.match(page.text, /<html lang="en" data-theme="system">/);

  await agent.post('/settings/design').type('form').send({
    _csrf: agent.csrfToken, theme: 'light',
    accent_color: '#3fa9e0', background_color: '#f5f8fa',
  });
  page = await agent.get('/home');
  assert.match(page.text, /<html lang="en">/);
  assert.ok(!page.text.includes('data-theme='), 'the default needs no stamp');

  // The Design page shows which one is selected.
  const design = await agent.get('/settings/design');
  assert.match(design.text, /value="light"[^>]*checked/);
});

test('an unknown theme value falls back to the light default', async () => {
  const agent = await helpers.signedUpAgent(app, 'badthemeuser');
  await agent.post('/settings/design').type('form').send({
    _csrf: agent.csrfToken, theme: 'neon',
    accent_color: '#3fa9e0', background_color: '#f5f8fa',
  });
  const page = await agent.get('/home');
  assert.match(page.text, /<html lang="en">/);

  const db = require('../src/config/db');
  const row = await db.one(
    `SELECT theme FROM profile_settings p JOIN users u ON u.id = p.user_id
      WHERE u.username = 'badthemeuser'`
  );
  assert.equal(row.theme, 'light');
});

test('a new account is created light, in the column default as well', async () => {
  const db = require('../src/config/db');
  await helpers.signedUpAgent(app, 'freshaccount');
  const row = await db.one(
    `SELECT theme FROM profile_settings p JOIN users u ON u.id = p.user_id
      WHERE u.username = 'freshaccount'`
  );
  assert.equal(row.theme, 'light');

  const column = await db.one(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'profile_settings' AND column_name = 'theme'`
  );
  assert.match(column.column_default, /light/);
});

test('the account menu offers a one-click switch that flips light and dark', async () => {
  const agent = await helpers.signedUpAgent(app, 'toggleuser');

  let page = await agent.get('/home');
  assert.match(page.text, /Switch to dark/);

  const first = await agent.post('/settings/design/theme').type('form')
    .send({ _csrf: agent.csrfToken });
  assert.equal(first.status, 302);

  page = await agent.get('/home');
  assert.match(page.text, /<html lang="en" data-theme="dark">/);
  assert.match(page.text, /Switch to light/);

  await agent.post('/settings/design/theme').type('form').send({ _csrf: agent.csrfToken });
  page = await agent.get('/home');
  assert.match(page.text, /<html lang="en">/);
  assert.ok(!page.text.includes('data-theme='));
});

test('the theme switch needs a CSRF token and a signed-in member', async () => {
  const request = require('supertest');
  const agent = await helpers.signedUpAgent(app, 'themecsrf');

  const noToken = await agent.post('/settings/design/theme').type('form').send({});
  assert.equal(noToken.status, 403);

  const signedOut = await request(app).post('/settings/design/theme').type('form').send({});
  assert.equal(signedOut.status, 403);
});

test('the maintenance page keeps its own palette regardless of theme', async () => {
  const sheet = await css();
  // It is a deliberate single-theme takeover, so its colours must not have
  // been swept into the token set.
  assert.match(sheet, /\.page-maintenance \{[^}]*background:\s*#3f769d/);
  assert.match(sheet, /\.art-twiq \{ fill: #fff; \}/);
});

// -------------------------------------------------------- token integrity ---

test('no design token is defined in terms of itself', async () => {
  const sheet = await css();
  const blocks = {
    ':root': /^:root \{([\s\S]*?)^\}/m.exec(sheet)[1],
    '[data-theme="dark"]': /:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m.exec(sheet)[1],
    '[data-theme="system"]': /:root\[data-theme="system"\] \{([\s\S]*?)\n {2}\}/.exec(sheet)[1],
  };

  // `--panel-background: var(--panel-background)` is valid CSS syntax and
  // resolves to nothing, so every panel on the site silently goes transparent.
  for (const [name, block] of Object.entries(blocks)) {
    for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      const [, token, value] = match;
      assert.ok(!value.includes(`var(${token})`), `${name}: ${token} is defined as itself`);
    }
  }
});

test('every token the stylesheet uses is declared in the base block', async () => {
  const sheet = await css();
  const root = /^:root \{([\s\S]*?)^\}/m.exec(sheet)[1];
  const declared = new Set([...root.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const used = new Set([...sheet.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));

  for (const token of used) {
    assert.ok(declared.has(token), `${token} is used but never declared in :root`);
  }
});

test('panels stay distinguishable from the page in both themes', async () => {
  const sheet = await css();
  function tokens(block) {
    const out = {};
    for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  }
  const light = tokens(/^:root \{([\s\S]*?)^\}/m.exec(sheet)[1]);
  const dark = tokens(/:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m.exec(sheet)[1]);

  for (const [name, set] of [['light', light], ['dark', dark]]) {
    assert.match(set['--panel-background'], /^#[0-9a-f]{3,8}$/i,
      `${name}: --panel-background must be a literal colour, not a reference`);
    assert.notEqual(set['--panel-background'], set['--page-background'],
      `${name}: a panel that matches the page has no edge at all`);
  }
});

test('the sign-up card on the landing page is a panel, not bare markup', async () => {
  const request = require('supertest');
  const sheet = await css();
  const rule = /\.landing-form \{([^}]+)\}/.exec(sheet);
  assert.ok(rule, 'the card should have a rule');
  assert.match(rule[1], /background:\s*var\(--panel-background\)/);
  assert.match(rule[1], /padding:/);
  assert.match(rule[1], /border-radius:/);

  const page = await request(app).get('/');
  assert.match(page.text, /class="landing-form"/);
  assert.match(page.text, /New to Twiq\?/);
});

test('dark mode reaches every page, not just the ones with no locals of their own', async () => {
  const request = require('supertest');
  const agent = await helpers.signedUpAgent(app, 'darkwanderer');
  await agent.post('/settings/design/theme').set('X-CSRF-Token', agent.csrfToken);

  // A render local shadows res.locals, so a page that happened to send its
  // own `theme` used to emit data-theme="[object Object]" and lose dark mode.
  for (const path of ['/home', '/darkwanderer', '/darkwanderer/media',
                      '/darkwanderer/favorites', '/darkwanderer/followers',
                      '/darkwanderer/lists', '/settings/design', '/settings/profile',
                      '/messages', '/discover']) {
    const page = await agent.get(path);
    assert.equal(page.status, 200, `${path} should render`);
    assert.match(page.text, /<html lang="en" data-theme="dark">/, `${path} should be dark`);
  }

  // And the switch in the top bar knows which way it is pointing.
  const profile = await agent.get('/darkwanderer');
  assert.match(profile.text, /Switch to light/);
});

test('an unexpected theme value is dropped rather than written to the page', async () => {
  const request = require('supertest');
  const agent = await helpers.signedUpAgent(app, 'lightwanderer');
  const page = await agent.get('/lightwanderer');
  assert.ok(!/data-theme=/.test(page.text), 'light is the default and needs no attribute');
  assert.ok(!/\[object Object\]/.test(page.text), 'no local should leak into the markup');
});
