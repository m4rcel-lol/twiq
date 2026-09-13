#!/bin/sh
# Apply any pending migrations, then hand over to the application.
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "twiq: applying database migrations"
  node src/db/migrate.js up
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "twiq: seeding development data"
  node seeds/seed.js
fi

exec "$@"
