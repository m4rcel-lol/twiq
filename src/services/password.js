'use strict';

const crypto = require('crypto');
const argon2 = require('argon2');
const config = require('../config/env');

/**
 * Argon2id with parameters comfortably above the OWASP 2024 minimum
 * (19 MiB memory, t=2). Plaintext passwords are never stored or logged.
 *
 * The test suite hashes a password for every account it creates and for
 * every sign-in it tries, which is minutes of deliberate CPU burn for no
 * added coverage - so, and only under NODE_ENV=test, the work factor drops
 * to the cheapest parameters Argon2id accepts. Development and production
 * always use the real ones.
 */
const OPTIONS = config.isTest
  ? { type: argon2.argon2id, memoryCost: 1024, timeCost: 2, parallelism: 1 } // argon2's own minimum
  : {
      type: argon2.argon2id,
      memoryCost: 19456, // 19 MiB
      timeCost: 3,
      parallelism: 1,
    };

async function hash(plaintext) {
  return argon2.hash(plaintext, OPTIONS);
}

async function verify(storedHash, plaintext) {
  if (!storedHash || !plaintext) return false;
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

/** Burn roughly the same time as a real verification for unknown accounts. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=3,p=1$c29tZS1zYWx0LXZhbHVl$3n1Yy0bOZ0zR2wvOZ1Bw4Q5zQ0m1yKf0mQZ0g2ZbJ8A';

async function fakeVerify(plaintext) {
  try {
    await argon2.verify(DUMMY_HASH, String(plaintext || 'x'));
  } catch {
    /* expected */
  }
  return false;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  // Exposed so a test can prove the cheap parameters are test-only.
  OPTIONS_FOR_TESTS: OPTIONS, hash, verify, fakeVerify, randomToken, hashToken };
