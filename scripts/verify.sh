#!/usr/bin/env sh
set -eu
pnpm lint
pnpm typecheck
pnpm test
pnpm build
