'use strict';

const { z } = require('zod');
const config = require('../config/env');
const { isReservedUsername } = require('../utils/reserved');

/**
 * Server-side validation. Nothing in Twiq trusts the browser: every form and
 * API body is parsed through one of these schemas before it reaches a model.
 */

const username = z
  .string()
  .trim()
  .min(1, 'Choose a username.')
  .max(15, 'Usernames can be at most 15 characters.')
  .regex(/^[A-Za-z0-9_]+$/, 'Usernames can only use letters, numbers and underscores.')
  .refine((value) => !/^\d+$/.test(value), 'Usernames must contain at least one letter.')
  .refine((value) => !isReservedUsername(value), 'That username is reserved.')
  .transform((value) => value.toLowerCase());

const displayName = z
  .string()
  .trim()
  .min(1, 'Enter your name.')
  .max(20, 'Names can be at most 20 characters.');

const email = z
  .string()
  .trim()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.')
  .transform((value) => value.toLowerCase());

const passwordField = z
  .string()
  .min(8, 'Passwords must be at least 8 characters.')
  .max(200, 'Passwords can be at most 200 characters.');

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Enter a colour as a hex value, for example #3fa9e0.');

const optionalUrl = z
  .string()
  .trim()
  .max(200, 'That link is too long.')
  .refine(
    (value) => value === '' || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(value),
    'Enter a full link starting with http:// or https://'
  );

const checkbox = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => value === true || value === 'on' || value === 'true' || value === '1');

const registration = z
  .object({
    display_name: displayName,
    username,
    email,
    password: passwordField,
  })
  .strict()
  .refine((data) => !data.password.toLowerCase().includes(data.username.toLowerCase()), {
    message: 'Your password cannot contain your username.',
    path: ['password'],
  });

const login = z.object({
  identifier: z.string().trim().min(1, 'Enter your username or email.').max(254),
  password: z.string().min(1, 'Enter your password.').max(200),
  remember: checkbox.optional(),
});

const composeTweet = z.object({
  body: z.string().max(2000).default(''),
  in_reply_to: z
    .union([z.string(), z.number(), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
  quote_of: z
    .union([z.string(), z.number(), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
  media_ids: z
    .union([z.string(), z.array(z.string()), z.undefined()])
    .optional()
    .transform((v) => {
      if (!v) return [];
      const list = Array.isArray(v) ? v : String(v).split(',');
      return list.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 4);
    }),
});

const automationUpdate = z.object({
  username: z.string().trim().min(1, 'Enter the username of the account that runs this one.').max(255),
  // Never trimmed and never logged: it is the operator's real password.
  password: z.string().min(1, 'Enter that account\'s password.').max(200),
});

const profileUpdate = z.object({
  display_name: displayName,
  bio: z.string().trim().max(config.brand.bioMaxLength, `Your bio can be at most ${config.brand.bioMaxLength} characters.`),
  location: z.string().trim().max(30, 'Location can be at most 30 characters.'),
  website: optionalUrl,
});

const accountUpdate = z.object({
  username,
  email,
  is_protected: checkbox.optional(),
  language: z.string().trim().max(10).default('en'),
  timezone: z.string().trim().max(60).default('UTC'),
});

const passwordChange = z.object({
  current_password: z.string().min(1, 'Enter your current password.').max(200),
  new_password: passwordField,
  new_password_confirm: z.string().max(200),
}).refine((data) => data.new_password === data.new_password_confirm, {
  message: 'The new passwords do not match.',
  path: ['new_password_confirm'],
});

const privacyUpdate = z.object({
  is_protected: checkbox.optional(),
  dm_policy: z.enum(['followers', 'everyone', 'nobody']),
  discoverable_by_email: checkbox.optional(),
  show_sensitive_media: checkbox.optional(),
});

const notificationsUpdate = z.object({
  notify_follows: checkbox.optional(),
  notify_mentions: checkbox.optional(),
  notify_replies: checkbox.optional(),
  notify_retweets: checkbox.optional(),
  notify_favorites: checkbox.optional(),
  notify_messages: checkbox.optional(),
});

const designUpdate = z.object({
  accent_color: hexColor,
  background_color: hexColor,
  background_tile: checkbox.optional(),
});

const listInput = z.object({
  name: z.string().trim().min(1, 'Give your List a name.').max(25, 'List names can be at most 25 characters.'),
  description: z.string().trim().max(160, 'List descriptions can be at most 160 characters.').default(''),
  is_private: checkbox.optional(),
});

const messageInput = z.object({
  body: z.string().max(1000, 'Messages can be at most 1000 characters.').default(''),
  media_id: z
    .union([z.string(), z.number(), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
  shared_tweet_id: z
    .union([z.string(), z.number(), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
});

const reportInput = z.object({
  category: z.enum(['spam', 'harassment', 'abusive', 'impersonation', 'illegal', 'other']),
  details: z.string().trim().max(1000).default(''),
  tweet_id: z
    .union([z.string(), z.number(), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : Number(v))),
  username: z.string().trim().max(15).optional(),
});

const passwordResetRequest = z.object({
  identifier: z.string().trim().min(1, 'Enter your username or email.').max(254),
});

const passwordResetComplete = z.object({
  token: z.string().min(10).max(200),
  password: passwordField,
  password_confirm: z.string().max(200),
}).refine((data) => data.password === data.password_confirm, {
  message: 'The passwords do not match.',
  path: ['password_confirm'],
});

const trendInput = z.object({
  scope_type: z.enum(['global', 'country', 'city']),
  scope_name: z.string().trim().min(1).max(60),
  tag: z.string().trim().min(1).max(80),
  query: z.string().trim().max(120).default(''),
  volume: z.coerce.number().int().min(0).max(100000000).default(0),
  position: z.coerce.number().int().min(0).max(50).default(0),
});

/** Flatten a ZodError into `{ field: message }` plus an ordered list. */
function formatErrors(error) {
  const fields = {};
  const messages = [];
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
    messages.push(issue.message);
  }
  return { fields, messages, first: messages[0] };
}

module.exports = {
  username,
  displayName,
  email,
  passwordField,
  hexColor,
  registration,
  login,
  composeTweet,
  automationUpdate,
  profileUpdate,
  accountUpdate,
  passwordChange,
  privacyUpdate,
  notificationsUpdate,
  designUpdate,
  listInput,
  messageInput,
  reportInput,
  passwordResetRequest,
  passwordResetComplete,
  trendInput,
  formatErrors,
};
