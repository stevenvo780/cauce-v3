#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPTS="$ROOT/scripts"
PREFLIGHT=$(mktemp -d)
trap 'rm -rf "$PREFLIGHT"' EXIT

export PYTHONDONTWRITEBYTECODE=1
python3 "$SCRIPTS/generate-container-aliases.py" \
  --output "$PREFLIGHT/container-aliases.json"
python3 "$SCRIPTS/generate-manifests.py" \
  --output "$PREFLIGHT/manifests"
python3 "$SCRIPTS/generate-runtime-fleet.py" \
  --output "$PREFLIGHT/fleet.json"
mkdir -p "$PREFLIGHT/schemas"
cp "$ROOT/schemas/alias-manifest.schema.json" "$PREFLIGHT/schemas/alias-manifest.schema.json"
python3 - "$ROOT" "$PREFLIGHT" <<'PY'
import pathlib
import sys

ops_root, generated_root = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(ops_root / "scripts"))

from container_alias_lib import load_container_aliases, load_system_principals
from manifest_lib import load_manifests

load_container_aliases(generated_root)
load_system_principals(generated_root)
load_manifests(generated_root)
PY

python3 "$SCRIPTS/generate-container-aliases.py"
python3 "$SCRIPTS/generate-manifests.py"
python3 "$SCRIPTS/generate-runtime-fleet.py"
python3 "$SCRIPTS/generate-units.py"
python3 "$SCRIPTS/generate-container-units.py" \
  --rootless \
  --home /home/dev \
  --output "$ROOT/generated/container-systemd/rootless"
python3 "$SCRIPTS/generate-telegram-config.py" \
  --output "$ROOT/telegram-runtime/config.json"
