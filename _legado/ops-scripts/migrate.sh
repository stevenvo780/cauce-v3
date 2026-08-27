#!/bin/sh
set -eu

# Retired entrypoint.  In particular, do not inspect DATABASE_URL_FILE here: a tombstone must fail
# before it can read production credentials, and cannot infer a safe target from an unset NODE_ENV.
printf '%s\n' 'direct migration is disabled: use ops/scripts/deploy-release.sh deploy for the stop/drain/migrate/restore transaction; disposable dev/test databases require an exact NODE_ENV=development or NODE_ENV=test with pnpm migrate:dev' >&2
exit 2
