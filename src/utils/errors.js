'use strict';

class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = options.expose !== false;
    this.code = options.code;
    this.details = options.details;
  }
}

const badRequest = (msg = 'Bad request', o) => new HttpError(400, msg, o);
const unauthorized = (msg = 'You need to sign in to do that.', o) => new HttpError(401, msg, o);
const forbidden = (msg = 'You are not allowed to do that.', o) => new HttpError(403, msg, o);
const notFound = (msg = 'Sorry, that page does not exist.', o) => new HttpError(404, msg, o);
const conflict = (msg = 'That conflicts with something that already exists.', o) =>
  new HttpError(409, msg, o);
const tooLarge = (msg = 'That file is too large.', o) => new HttpError(413, msg, o);
const tooMany = (msg = 'You are doing that a bit too often. Try again in a little while.', o) =>
  new HttpError(429, msg, o);
const serverError = (msg = 'Something went wrong on our end.', o) =>
  new HttpError(500, msg, { expose: false, ...o });

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooLarge,
  tooMany,
  serverError,
};
