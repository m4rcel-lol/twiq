'use strict';

const config = require('../config/env');

/**
 * The four pages the footer links to. They are deliberately plain: real
 * sentences about how this installation actually behaves, not placeholders.
 */

const PAGES = {
  about: {
    title: `About ${config.brand.name}`,
    description: `What ${config.brand.name} is and how it works.`,
    body: `
      <h1>About ${config.brand.name}</h1>
      <p>
        ${config.brand.name} is a small social network built around short posts.
        A Tweet is at most ${config.brand.tweetMaxLength} characters. Your timeline
        shows the people you follow, newest first, and nothing else - no ranking,
        no suggestions mixed in, no "you might have missed this".
      </p>
      <h2>How it works</h2>
      <ul>
        <li><strong>Follow</strong> someone and their Tweets appear on your home timeline.</li>
        <li><strong>Favorite</strong> a Tweet to keep it; your favorites have their own page.</li>
        <li><strong>Retweet</strong> to pass a Tweet on with the original author attached.</li>
        <li><strong>Protect</strong> your account and only approved followers can read you.</li>
        <li><strong>Direct Messages</strong> go to people who follow you, unless they open them up.</li>
        <li><strong>Lists</strong> gather accounts into a timeline of their own.</li>
      </ul>
      <h2>Trends</h2>
      <p>
        Trends are computed from hashtags used in the last 48 hours. The score
        counts how many different people used a tag, how often it was used, how
        much of that use is recent, and how long ago it was last used. One
        enthusiastic account cannot start a trend on its own.
      </p>
      <h2>This installation</h2>
      <p>
        ${config.brand.name} is self-hosted software. Whoever runs this server
        controls the accounts, the data and the moderation decisions on it.
      </p>
    `,
  },
  help: {
    title: `${config.brand.name} help`,
    description: `Answers to the questions people ask about ${config.brand.name}.`,
    body: `
      <h1>Help</h1>
      <h2>I forgot my password</h2>
      <p>Use <a href="/forgot-password">the reset form</a>. The link it sends is valid for one hour and works once.</p>
      <h2>How do I change my username?</h2>
      <p>In <a href="/settings/account">Account settings</a>. Your profile URL changes with it, and old links stop working.</p>
      <h2>How do I stop seeing somebody?</h2>
      <p>
        <strong>Mute</strong> removes their Tweets from your timeline while you keep following them, and they are not told.
        <strong>Block</strong> ends the relationship in both directions and stops them interacting with you.
        Manage both in <a href="/settings/privacy">Security and privacy</a>.
      </p>
      <h2>Why can I not message somebody?</h2>
      <p>By default you can only send a Direct Message to somebody who follows you. They can widen that in their own settings.</p>
      <h2>Why are some Tweets bigger on a profile?</h2>
      <p>Those are Best Tweets: posts whose engagement is far above that account's own average. It is a fixed calculation, not an editorial choice.</p>
      <h2>Something is broken, or somebody is behaving badly</h2>
      <p>Use the Report option in the "more" menu on any Tweet or profile. Reports go to this installation's moderators.</p>
    `,
  },
  terms: {
    title: `${config.brand.name} terms`,
    description: `The rules for using this ${config.brand.name} installation.`,
    body: `
      <h1>Terms</h1>
      <p>
        This is a self-hosted installation of ${config.brand.name}. The operator of
        this server sets and enforces its rules; these are the defaults the
        software ships with.
      </p>
      <h2>Your account</h2>
      <ul>
        <li>You are responsible for what you post and for keeping your password safe.</li>
        <li>One person may hold several accounts, but not to evade a block or a suspension.</li>
        <li>Impersonating somebody else is not allowed.</li>
      </ul>
      <h2>Content</h2>
      <ul>
        <li>Do not post content that is illegal where this server is operated.</li>
        <li>Do not target people with harassment, or organise others to do so.</li>
        <li>Do not post spam, or automate posting in a way that degrades the service.</li>
      </ul>
      <h2>Moderation</h2>
      <p>
        Moderators may remove a Tweet or suspend an account. Every such action is
        recorded in an audit log. There is no guarantee of uptime, and no
        guarantee that your data will be retained.
      </p>
    `,
  },
  privacy: {
    title: `${config.brand.name} privacy`,
    description: `What ${config.brand.name} stores and who can see it.`,
    body: `
      <h1>Privacy</h1>
      <h2>What is stored</h2>
      <ul>
        <li>Your username, display name, email address and a hash of your password. The password itself is never stored.</li>
        <li>Your Tweets, favorites, retweets, follows, Lists and uploaded media.</li>
        <li>Your Direct Messages. They are private between participants, and their contents are never written to the server logs.</li>
        <li>Sign-in attempts (identifier, IP address, success or failure) so brute-force attempts can be slowed down.</li>
        <li>Administrative actions, in an audit log.</li>
      </ul>
      <h2>Who can see it</h2>
      <p>
        Public Tweets are visible to anybody, signed in or not. A protected
        account's Tweets are visible only to approved followers. Administrators of
        this server have database access, as with any self-hosted service.
      </p>
      <h2>Cookies</h2>
      <p>
        ${config.brand.name} sets one cookie: a session identifier. It is
        HttpOnly and SameSite=Lax. There is no advertising and no third-party
        analytics in this software.
      </p>
      <h2>Deleting your account</h2>
      <p>
        <a href="/settings/account">Account settings</a> has a delete option. It
        removes your profile, Tweets, messages and Lists from the database.
        Backups taken before the deletion are the operator's responsibility.
      </p>
    `,
  },
};

exports.show = (key) => (req, res) => {
  const page = PAGES[key];
  return res.render('static/page', {
    title: `${page.title} | ${config.brand.name}`,
    description: page.description,
    canonical: `${config.baseUrl}/${key}`,
    nav: null,
    bodyClass: 'page-static',
    pageTitle: page.title,
    content: page.body,
  });
};

exports.PAGES = PAGES;
