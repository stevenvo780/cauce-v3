#!/bin/sh
set -eu
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_URL_FILE:-}" ]; then
  [ -r "$DATABASE_URL_FILE" ] || { printf 'DATABASE_URL_FILE is not readable\n' >&2; exit 2; }
  DATABASE_URL=
  IFS= read -r DATABASE_URL < "$DATABASE_URL_FILE" || [ -n "$DATABASE_URL" ]
  export DATABASE_URL
fi
: "${DATABASE_URL:?DATABASE_URL or DATABASE_URL_FILE must be set outside version control}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec pnpm --dir "$ROOT" migrate
