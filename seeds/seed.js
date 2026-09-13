#!/usr/bin/env node
'use strict';

/**
 * Development seed data for Twiq.
 *
 *   npm run seed          insert the fictional community (idempotent)
 *   npm run seed:reset    wipe every table first, then insert
 *
 * Everything here is invented. No account, Tweet or image is taken from any
 * real service.
 */

const config = require('../src/config/env');
const logger = require('../src/config/logger');
const db = require('../src/config/db');
const userModel = require('../src/models/user');
const tweetModel = require('../src/models/tweet');
const graphModel = require('../src/models/graph');
const listModel = require('../src/models/list');
const messageModel = require('../src/models/message');
const mediaModel = require('../src/models/media');
const trendsService = require('../src/services/trends');
const storage = require('../src/services/storage');
const png = require('./png');

const PASSWORD = process.env.SEED_PASSWORD || 'twiqtwiq';

const PALETTE = {
  alice: [46, 116, 181],
  bob: [190, 96, 60],
  charlie: [58, 138, 106],
  diana: [136, 72, 160],
  twiq: [63, 169, 224],
  devuser: [90, 100, 112],
  newsbot: [196, 60, 84],
  marcus: [120, 96, 40],
  priya: [40, 128, 140],
};

const PEOPLE = [
  {
    username: 'twiq',
    displayName: 'Twiq',
    email: 'hello@twiq.example.com',
    bio: 'The official account. Product notes, downtime updates and the occasional bad pun. 300 characters at a time.',
    location: 'Everywhere',
    website: 'https://twiq.example.com',
    verified: true,
  },
  {
    username: 'alice',
    displayName: 'Alice Nakamura',
    email: 'alice@example.com',
    bio: 'Front-end engineer. Collects old keyboards and older CSS tricks. Opinions are load-bearing.',
    location: 'Lisbon',
    website: 'https://alice.example.com',
    verified: true,
  },
  {
    username: 'bob',
    displayName: 'Bob Ferreira',
    email: 'bob@example.com',
    bio: 'Bread, bikes, and databases. Mostly bread.',
    location: 'Porto',
    website: '',
  },
  {
    username: 'charlie',
    displayName: 'Charlie Okonkwo',
    email: 'charlie@example.com',
    bio: 'Photographer. Film mostly. I will tell you about the light whether you asked or not.',
    location: 'Lagos',
    website: 'https://charlie.example.com',
  },
  {
    username: 'diana',
    displayName: 'Diana Weiss',
    email: 'diana@example.com',
    bio: 'Archivist. I care about metadata more than is socially acceptable.',
    location: 'Vienna',
    website: '',
    protected: true,
  },
  {
    username: 'devuser',
    displayName: 'Dev Account',
    email: 'dev@example.com',
    bio: 'Test account for local development. Nothing here is interesting on purpose.',
    location: 'localhost:40437',
    website: '',
  },
  {
    username: 'newsbot',
    displayName: 'Twiq Newsbot',
    email: 'newsbot@example.com',
    bio: 'Automated headlines from the fictional wire. Not a person. Replies are not read.',
    location: '',
    website: '',
  },
  {
    username: 'marcus',
    displayName: 'Marcus Hale',
    email: 'marcus@example.com',
    bio: 'Runs a very small record shop. Ask me about the B-sides.',
    location: 'Glasgow',
    website: '',
  },
  {
    username: 'priya',
    displayName: 'Priya Raman',
    email: 'priya@example.com',
    bio: 'Civil engineer. Bridges, mostly. Sometimes tunnels when I am feeling dramatic.',
    location: 'Chennai',
    website: 'https://priya.example.com',
  },
];

/** [author, text, optionsOrMinutesAgo] */
const TWEETS = [
  ['twiq', 'Twiq is open. 300 characters, a reverse-chronological timeline and nothing that decides what you should have read. #twiq', 4320],
  ['twiq', 'Scheduled maintenance tonight at 23:00 UTC. Expect about ten minutes where new Tweets do not post. #twiqstatus', 2880],
  ['alice', 'Spent the morning rewriting a 400 line stylesheet into 120. The trick was deleting things, which is always the trick. #css', 2600],
  ['alice', 'Hot take: a table is still the right element for tabular data and I will not be revisiting this. #webdev', 2400],
  ['alice', 'New keyboard day. It is loud in a way that my colleagues describe as "a choice". http://alice.example.com/keyboards', 1500],
  ['bob', 'The sourdough starter survived a two week holiday. I did not expect loyalty from a jar of flour. #baking', 2200],
  ['bob', 'Query went from 4.2s to 40ms by adding one index. I have never felt so powerful or so foolish. #postgres', 1800],
  ['charlie', 'Shot a roll of expired film at the harbour this morning. Half of it is fog. The other half is the best work I have done. #photography', 1700],
  ['charlie', 'Golden hour lasted eleven minutes today and I used nine of them changing a lens. #photography', 900],
  ['diana', 'Catalogued 1,200 photographs today. Three of them had dates. Archivists are just people who are angry about missing metadata.', 1400],
  ['newsbot', 'WIRE: City council approves the riverside cycle bridge after four years of consultation. #cycling #infrastructure', 1300],
  ['newsbot', 'WIRE: Regional trains to run through the night this weekend during the festival. #transit', 700],
  ['newsbot', 'WIRE: Old harbour warehouse to reopen as a public archive next spring. #archives', 320],
  ['marcus', 'Somebody traded in a box of 1970s soul 45s today and I have not sold a single one. They are mine now. #records', 1100],
  ['marcus', 'The shop cat has learned to sit on exactly the record a customer is reaching for. #records', 260],
  ['priya', 'Bridge inspection at 6am. The river was completely flat and the whole span was in it, upside down. #engineering', 800],
  ['priya', 'Reminder that the most impressive part of a bridge is usually the part you cannot see. #engineering #infrastructure', 180],
  ['alice', 'Anyone else find that the best debugging tool is explaining the bug out loud to a colleague who has already left for lunch?', 150],
  ['bob', 'Loaf number 214. Crumb is finally open. Four years of this. #baking', 120],
  ['twiq', 'Trends now update every ten minutes and count distinct people, not raw volume, so one enthusiastic account cannot start a trend. #twiq', 90],
  ['charlie', 'Printing all weekend. If you have ever wondered what 40 sheets of fibre paper look like drying in a small flat, the answer is "a hazard".', 60],
  ['alice', 'Watching @charlie print is the closest thing to watching a chemist who is also a gambler. #photography', 30],
  ['devuser', 'test tweet please ignore', 20],
  ['priya', 'Late train, good book, no complaints. @marcus what should I be listening to on the way home?', 12],
];

const REPLIES = [
  ['charlie', 'alice', 2, '@alice it is mostly gambling. The chemistry just keeps score.'],
  ['marcus', 'priya', 23, '@priya the soul 45s, obviously. Come by and I will play you three of them.'],
  ['bob', 'alice', 3, '@alice deleting code is underrated. My best commit last year was -812 lines.'],
  ['alice', 'bob', 6, '@bob one index. One! Meanwhile I spent a week on a render loop.'],
  ['priya', 'newsbot', 10, '@newsbot four years of consultation for a bridge that took eleven months to build. #infrastructure'],
];

const FOLLOWS = {
  alice: ['bob', 'charlie', 'twiq', 'newsbot', 'priya'],
  bob: ['alice', 'charlie', 'twiq', 'marcus'],
  charlie: ['alice', 'bob', 'twiq', 'priya'],
  diana: ['alice', 'twiq', 'newsbot'],
  devuser: ['alice', 'bob', 'charlie', 'twiq', 'newsbot', 'marcus', 'priya'],
  marcus: ['bob', 'charlie', 'priya'],
  priya: ['alice', 'newsbot', 'marcus', 'twiq'],
  newsbot: ['twiq'],
  twiq: ['alice', 'bob', 'charlie'],
};

const TABLES = [
  'audit_logs', 'reports', 'list_members', 'lists', 'messages',
  'conversation_participants', 'conversations', 'notifications', 'mutes', 'blocks',
  'follow_requests', 'follows', 'pinned_tweets', 'favorites', 'retweets',
  'tweet_mentions', 'tweet_hashtags', 'hashtags', 'tweet_media', 'tweets',
  'media', 'profile_settings', 'user_settings', 'password_resets',
  'email_verifications', 'login_attempts', 'trends', 'users', 'sessions',
];

async function reset() {
  logger.warn('resetting every Twiq table');
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

async function storeImage(buffer, prefix) {
  return storage.save(buffer, { prefix, ext: 'png' });
}

async function ensureUser(person, index) {
  const existing = await userModel.findByUsername(person.username);
  if (existing) return existing;

  const created = await userModel.create({
    username: person.username,
    displayName: person.displayName,
    email: person.email,
    plainPassword: PASSWORD,
    isVerified: Boolean(person.verified),
  });

  const color = PALETTE[person.username] || [90, 110, 130];
  const [avatarKey, headerKey] = await Promise.all([
    storeImage(png.avatar(200, color, index + 1), 'avatar'),
    storeImage(png.gradient(1500, 500, color, png.mix(color, [250, 250, 250], 0.7)), 'header'),
  ]);

  await userModel.setAvatar(created.id, avatarKey);
  await userModel.setHeader(created.id, headerKey);
  await userModel.updateProfile(created.id, {
    bio: person.bio || '',
    location: person.location || '',
    website: person.website || '',
    is_protected: Boolean(person.protected),
  });
  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [created.id]);

  logger.info({ username: person.username }, 'seeded account');
  return userModel.findByUsername(person.username);
}

async function backdate(tweetId, minutesAgo) {
  await db.query(
    `UPDATE tweets SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
    [tweetId, String(minutesAgo)]
  );
}

async function main() {
  const shouldReset = process.argv.includes('--reset');
  await db.healthcheck();
  if (shouldReset) await reset();

  // -- accounts -----------------------------------------------------------
  const users = {};
  for (const [index, person] of PEOPLE.entries()) {
    users[person.username] = await ensureUser(person, index);
  }

  // -- the administrator described in .env --------------------------------
  const adminUsername = String(config.admin.username).toLowerCase();
  let admin = await userModel.findByUsername(adminUsername);
  if (!admin) {
    const created = await userModel.create({
      username: adminUsername,
      displayName: 'Twiq Admin',
      email: config.admin.email,
      plainPassword: config.admin.password,
      isVerified: true,
    });
    admin = await userModel.findById(created.id);
  }
  await userModel.setRole(admin.id, 'admin');
  logger.info({ username: adminUsername }, 'administrator ready');

  if ((await db.one('SELECT count(*)::int AS n FROM tweets')).n > 0) {
    logger.info('tweets already present - skipping content seed');
    await trendsService.refreshGlobal();
    await db.close();
    return;
  }

  // -- the follow graph ---------------------------------------------------
  for (const [follower, targets] of Object.entries(FOLLOWS)) {
    for (const target of targets) {
      if (!users[follower] || !users[target]) continue;
      await graphModel.follow(users[follower].id, users[target]);
    }
  }
  // Diana is protected, so this stays a pending request.
  await graphModel.follow(users.bob.id, users.diana);

  // -- Tweets -------------------------------------------------------------
  const created = [];
  for (const [username, text, minutesAgo] of TWEETS) {
    const tweet = await tweetModel.create({ userId: users[username].id, body: text });
    await backdate(tweet.id, minutesAgo);
    created.push({ ...tweet, username, minutesAgo });
  }

  // -- photo Tweets -------------------------------------------------------
  const photoPlan = [
    ['charlie', 'Harbour, 6:40am, expired film. Worth the cold. #photography', [40, 70, 110], [230, 180, 120], 240],
    ['charlie', 'Contact sheet from the weekend. Frame 7 is the one. #photography', [70, 60, 55], [220, 215, 200], 200],
    ['bob', 'Loaf 214. Look at that crumb. #baking', [120, 80, 45], [240, 220, 180], 115],
    ['priya', 'The span at first light. #engineering', [30, 60, 90], [200, 220, 235], 175],
  ];
  for (const [username, text, from, to, minutesAgo] of photoPlan) {
    const buffer = png.gradient(900, 600, from, to);
    const key = await storeImage(buffer, 'media');
    const record = await mediaModel.create({
      userId: users[username].id,
      kind: 'photo',
      storageKey: key,
      mimeType: 'image/png',
      byteSize: buffer.length,
      altText: text,
    });
    const tweet = await tweetModel.create({
      userId: users[username].id,
      body: text,
      mediaIds: [record.id],
    });
    await backdate(tweet.id, minutesAgo);
    created.push({ ...tweet, username, minutesAgo });
  }

  // -- replies (conversations) -------------------------------------------
  for (const [username, , parentIndex, text] of REPLIES) {
    const parent = created[parentIndex];
    if (!parent) continue;
    const reply = await tweetModel.create({
      userId: users[username].id,
      body: text,
      inReplyToTweetId: parent.id,
    });
    await backdate(reply.id, Math.max(1, Math.round(parent.minutesAgo / 2)));
  }

  // -- retweets and favorites --------------------------------------------
  const engagementPlan = [
    ['alice', [0, 6, 7, 10, 16]],
    ['bob', [0, 2, 3, 7, 19]],
    ['charlie', [0, 2, 5, 16, 19]],
    ['diana', [0, 9, 10, 12]],
    ['marcus', [5, 7, 15, 19]],
    ['priya', [0, 2, 6, 10, 19]],
    ['devuser', [0, 2, 3, 5, 6, 7, 19]],
    ['newsbot', [0]],
    ['twiq', [2, 7, 16]],
  ];
  for (const [username, indexes] of engagementPlan) {
    for (const index of indexes) {
      const tweet = created[index];
      if (!tweet || tweet.username === username) continue;
      await tweetModel.favorite(users[username].id, tweet.id);
    }
  }
  const retweetPlan = [
    ['alice', [10, 16]],
    ['bob', [0, 19]],
    ['charlie', [19]],
    ['priya', [10]],
    ['devuser', [0, 19]],
    ['marcus', [19]],
  ];
  for (const [username, indexes] of retweetPlan) {
    for (const index of indexes) {
      const tweet = created[index];
      if (!tweet || tweet.username === username) continue;
      const author = await userModel.findByUsername(tweet.username);
      if (author.is_protected) continue;
      await tweetModel.retweet(users[username].id, tweet.id);
    }
  }

  // -- a pinned Tweet -----------------------------------------------------
  await tweetModel.pin(users.twiq.id, created[0].id);
  await tweetModel.pin(users.alice.id, created[3].id);

  // -- Lists --------------------------------------------------------------
  const makers = await listModel.create(users.alice.id, {
    name: 'People who make things',
    description: 'Bread, bridges, photographs and records.',
    isPrivate: false,
  });
  for (const username of ['bob', 'charlie', 'priya', 'marcus']) {
    await listModel.addMember(makers.id, users.alice.id, users[username].id);
  }
  const quiet = await listModel.create(users.alice.id, {
    name: 'Quiet reading',
    description: 'A private List I actually read.',
    isPrivate: true,
  });
  await listModel.addMember(quiet.id, users.alice.id, users.diana.id);

  // -- Direct Messages (mutual follows only) ------------------------------
  const conversation = await messageModel.findOrCreateConversation(users.alice.id, users.bob.id);
  await messageModel.send({
    conversationId: conversation,
    senderId: users.alice.id,
    body: 'Are you bringing bread on Saturday or should I plan a backup?',
  });
  await messageModel.send({
    conversationId: conversation,
    senderId: users.bob.id,
    body: 'Loaf 215 is proving as we speak. There is no backup plan.',
  });
  await messageModel.send({
    conversationId: conversation,
    senderId: users.alice.id,
    body: 'Perfect answer.',
  });

  const second = await messageModel.findOrCreateConversation(users.charlie.id, users.priya.id);
  await messageModel.send({
    conversationId: second,
    senderId: users.priya.id,
    body: 'If you want the bridge at first light, be on the east bank by 05:50. It is worth it.',
  });

  // -- curated regional trends + a fresh worldwide computation ------------
  await trendsService.upsertManual({
    scopeType: 'country', scopeName: 'Portugal', tag: 'baking', query: '#baking', volume: 812, position: 0,
  });
  await trendsService.upsertManual({
    scopeType: 'country', scopeName: 'Portugal', tag: 'photography', query: '#photography', volume: 640, position: 1,
  });
  await trendsService.upsertManual({
    scopeType: 'city', scopeName: 'Lisbon', tag: 'css', query: '#css', volume: 205, position: 0,
  });
  await trendsService.upsertManual({
    scopeType: 'city', scopeName: 'Lisbon', tag: 'webdev', query: '#webdev', volume: 180, position: 1,
  });
  await trendsService.refreshGlobal();

  const counts = await db.one(`
    SELECT (SELECT count(*) FROM users)::int AS users,
           (SELECT count(*) FROM tweets)::int AS tweets,
           (SELECT count(*) FROM follows)::int AS follows,
           (SELECT count(*) FROM favorites)::int AS favorites,
           (SELECT count(*) FROM retweets)::int AS retweets
  `);
  logger.info(counts, 'seed complete');
  process.stdout.write(
    `\nTwiq seed complete.\n` +
    `  accounts: ${PEOPLE.map((p) => '@' + p.username).join(', ')}\n` +
    `  password: ${PASSWORD}\n` +
    `  admin:    @${adminUsername} (password from ADMIN_PASSWORD)\n\n`
  );
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
}

module.exports = { main, PEOPLE, PASSWORD };
