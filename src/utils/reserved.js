'use strict';

/**
 * Usernames that must never be handed to a member, because `/:username`
 * is the last route Twiq matches and would otherwise shadow a system page.
 */
const RESERVED_USERNAMES = new Set([
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'assets',
  'auth', 'blog', 'compose', 'connect', 'contact', 'css', 'dashboard', 'debug',
  'delete', 'developer', 'developers', 'direct_messages', 'discover', 'docs',
  'download', 'edit', 'explore', 'favicon', 'favorites', 'feed', 'follow',
  'followers', 'following', 'fonts', 'forgot', 'help', 'home', 'i', 'images',
  'img', 'intent', 'javascript', 'jobs', 'js', 'legal', 'list', 'lists',
  'login', 'logout', 'mail', 'me', 'media', 'message', 'messages', 'mobile',
  'moderator', 'new', 'news', 'notifications', 'oauth', 'password', 'photos',
  'privacy', 'public', 'register', 'reset', 'robots', 'root', 'rss', 'search',
  'security', 'session', 'sessions', 'settings', 'signin', 'signup', 'sitemap',
  'static', 'status', 'statuses', 'support', 'system', 'terms', 'trends',
  'tweet', 'tweets', 'undefined', 'uploads', 'user', 'users', 'verify',
  'webhooks', 'welcome', 'who_to_follow', 'widgets', 'ws',
]);

function isReservedUsername(name) {
  return RESERVED_USERNAMES.has(String(name || '').trim().toLowerCase());
}

module.exports = { RESERVED_USERNAMES, isReservedUsername };
