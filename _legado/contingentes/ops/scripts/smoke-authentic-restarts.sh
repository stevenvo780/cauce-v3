#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
printf 'restart evidence is part of the non-overwriting final-binary authentic suite\n'
exec "$ROOT/scripts/smoke-compose-authentic.sh"
