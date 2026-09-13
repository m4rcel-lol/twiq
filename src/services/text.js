'use strict';

const { escapeHtml, escapeAttribute } = require('../utils/escape');

/**
 * Entity extraction and rendering for Tweet bodies.
 *
 * Tweet text is never stored as HTML. It is stored verbatim and rendered to
 * escaped HTML on the way out, so a Tweet can never inject markup.
 */

// A hashtag: # followed by at least one letter, then letters/digits/underscore.
const HASHTAG_RE = /(^|[^\w&/])[#＃]([\p{L}][\p{L}\p{N}_]{0,79})/gu;
// A mention: @ followed by a Twiq username.
const MENTION_RE = /(^|[^\w@/])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
// A bare http(s) URL.
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,!?;:]/gi;

/** Count characters the way a 2014 composer did: by Unicode code point. */
function tweetLength(text) {
  return Array.from(String(text || '').trim()).length;
}

function extractHashtags(text) {
  const out = new Set();
  for (const match of String(text || '').matchAll(HASHTAG_RE)) {
    out.add(match[2].toLowerCase());
  }
  return [...out];
}

function extractMentions(text) {
  const out = new Set();
  for (const match of String(text || '').matchAll(MENTION_RE)) {
    out.add(match[2].toLowerCase());
  }
  return [...out];
}

function extractUrls(text) {
  return [...new Set(String(text || '').match(URL_RE) || [])];
}

function shortenUrl(url) {
  const stripped = url.replace(/^https?:\/\//i, '');
  return stripped.length > 27 ? `${stripped.slice(0, 27)}…` : stripped;
}

/**
 * Render Tweet text to HTML. Everything is escaped first; links are then
 * built from index ranges computed against the *escaped* string so offsets
 * always line up.
 */
function renderTweetHtml(text) {
  const source = String(text || '');
  const tokens = [];

  for (const match of source.matchAll(URL_RE)) {
    tokens.push({ start: match.index, end: match.index + match[0].length, type: 'url', value: match[0] });
  }
  for (const match of source.matchAll(HASHTAG_RE)) {
    const start = match.index + match[1].length;
    tokens.push({ start, end: start + match[2].length + 1, type: 'hashtag', value: match[2] });
  }
  for (const match of source.matchAll(MENTION_RE)) {
    const start = match.index + match[1].length;
    tokens.push({ start, end: start + match[2].length + 1, type: 'mention', value: match[2] });
  }

  // Earliest wins; drop anything that overlaps an already-accepted token.
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted = [];
  let cursor = -1;
  for (const token of tokens) {
    if (token.start >= cursor) {
      accepted.push(token);
      cursor = token.end;
    }
  }

  let html = '';
  let index = 0;
  for (const token of accepted) {
    html += escapeHtml(source.slice(index, token.start)).replace(/\n/g, '<br>');
    if (token.type === 'url') {
      const safe = /^https?:\/\//i.test(token.value) ? token.value : `http://${token.value}`;
      html +=
        `<a class="tw-link" href="${escapeAttribute(safe)}" rel="nofollow noopener noreferrer" ` +
        `target="_blank" title="${escapeAttribute(token.value)}">${escapeHtml(shortenUrl(token.value))}</a>`;
    } else if (token.type === 'hashtag') {
      html +=
        `<a class="tw-hashtag" href="/search?q=%23${encodeURIComponent(token.value)}">` +
        `<s>#</s><b>${escapeHtml(token.value)}</b></a>`;
    } else {
      html +=
        `<a class="tw-mention" href="/${encodeURIComponent(token.value)}" ` +
        `title="${escapeAttribute('@' + token.value)}"><s>@</s><b>${escapeHtml(token.value)}</b></a>`;
    }
    index = token.end;
  }
  html += escapeHtml(source.slice(index)).replace(/\n/g, '<br>');
  return html;
}

/** Plain-text preview used for meta descriptions and DM list snippets. */
function plainSnippet(text, max = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Render a short bio: mentions and hashtags become links, URLs too. */
function renderBioHtml(text) {
  return renderTweetHtml(text);
}

module.exports = {
  tweetLength,
  extractHashtags,
  extractMentions,
  extractUrls,
  renderTweetHtml,
  renderBioHtml,
  plainSnippet,
  shortenUrl,
};
