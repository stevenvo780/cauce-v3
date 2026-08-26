#!/usr/bin/env bash
# Compatibility entrypoint. The maintained implementation lives in ops/cli so
# privacy and query fixes cannot drift between two executable copies.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_CLI="$SCRIPT_DIR/../cli/cauce-huerfanas"
if [[ -x "$REPO_CLI" ]]; then
  exec "$REPO_CLI" "$@"
fi
installed=$(command -v cauce-huerfanas 2>/dev/null || true)
if [[ -n "$installed" && "$installed" != "${BASH_SOURCE[0]}" ]]; then
  exec "$installed" "$@"
fi
printf 'cauce-huerfanas canonico no esta instalado\n' >&2
exit 127
