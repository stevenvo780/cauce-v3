#!/bin/sh
set -eu

if [ -n "${DATABASE_URL_FILE:-}" ]; then
  [ -r "$DATABASE_URL_FILE" ] || { printf 'DATABASE_URL_FILE is not readable\n' >&2; exit 2; }
  DATABASE_URL=
  IFS= read -r DATABASE_URL < "$DATABASE_URL_FILE" || [ -n "$DATABASE_URL" ]
  [ -n "$DATABASE_URL" ] || { printf 'DATABASE_URL_FILE is empty\n' >&2; exit 2; }
  export DATABASE_URL
fi

exec "$@"
