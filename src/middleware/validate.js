'use strict';

const { badRequest } = require('../utils/errors');
const { formatErrors } = require('../validators/schemas');

/**
 * Parse `req.body` with a Zod schema onto `req.valid`.
 *
 * HTML form posts get the validated data back on `req.validationErrors` and
 * carry on to the controller, which re-renders the form with messages.
 * API requests get a 400 with the field errors as JSON.
 */
function validate(schema, { mode = 'throw' } = {}) {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(req.body || {});
    if (result.success) {
      req.valid = result.data;
      req.validationErrors = null;
      return next();
    }
    const formatted = formatErrors(result.error);
    if (mode === 'collect') {
      req.valid = null;
      req.validationErrors = formatted;
      return next();
    }
    return next(badRequest(formatted.first || 'Please check the form and try again.', {
      details: formatted.fields,
    }));
  };
}

module.exports = { validate };
