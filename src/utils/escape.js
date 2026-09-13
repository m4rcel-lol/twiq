'use strict';

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape a string for safe interpolation into HTML. */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ENTITIES[ch]);
}

/** Escape a string for safe interpolation inside an HTML attribute. */
function escapeAttribute(value) {
  return escapeHtml(value).replace(/\r?\n/g, '&#10;');
}

module.exports = { escapeHtml, escapeAttribute };
