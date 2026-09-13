'use strict';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * 2014-style relative timestamps: 12s, 45m, 7h, 3 Mar, 12 Mar 13.
 */
function shortTimestamp(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const diff = Math.max(0, now.getTime() - date.getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()];
  if (date.getUTCFullYear() === now.getUTCFullYear()) return `${day} ${month}`;
  return `${day} ${month} ${String(date.getUTCFullYear()).slice(2)}`;
}

/** "6:31 PM - 12 Mar 2014" - the permalink timestamp format. */
function longTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  let hours = date.getUTCHours();
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} ${meridiem} - ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "Joined March 2014" */
function joinedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

/** 1234 -> "1,234"; 12345 -> "12.3K"; 1234567 -> "1.23M" (2014 count style). */
function compactCount(n) {
  const num = Number(n) || 0;
  if (num < 10000) return num.toLocaleString('en-US');
  if (num < 1000000) return `${(num / 1000).toFixed(num < 100000 ? 1 : 0)}K`;
  return `${(num / 1000000).toFixed(2)}M`;
}

function fullCount(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

/** Strip the scheme and trailing slash the way 2014 profile links did. */
function displayUrl(url) {
  if (!url) return '';
  return String(url).replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** 1536 -> "1.5 KB"; 5242880 -> "5 MB" */
function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** A signed percentage change, or null when there is nothing to compare to. */
function delta(current, previous) {
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  if (before === 0) return now === 0 ? { pct: 0, dir: 'flat' } : { pct: null, dir: 'up' };
  const pct = Math.round(((now - before) / before) * 100);
  return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

function pluralize(n, singular, plural) {
  return Number(n) === 1 ? singular : plural || `${singular}s`;
}

module.exports = {
  shortTimestamp,
  longTimestamp,
  joinedDate,
  isoDate,
  compactCount,
  fullCount,
  displayUrl,
  bytes,
  delta,
  pluralize,
};
