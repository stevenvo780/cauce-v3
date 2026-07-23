#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pnpm --dir "$ROOT" --filter @cauce/protocol build
pnpm --dir "$ROOT" --filter @cauce/adapter-sdk build
pnpm --dir "$ROOT/packages/adapter-sdk" exec node --test --test-concurrency=1 --test-name-pattern='fake executable' \
  "$ROOT/packages/adapter-sdk/dist/test/harnesses.test.js"
printf 'adapter double smoke passed; no authentic CLI or prompt was invoked\n'
