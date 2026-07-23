#!/usr/bin/env python3
import pathlib
import sys

from manifest_lib import ManifestError, load_manifests

root = pathlib.Path(__file__).resolve().parents[1]
try:
    manifests = load_manifests(root)
except (OSError, ValueError, ManifestError) as error:
    print(f"manifest validation failed: {error}", file=sys.stderr)
    raise SystemExit(1)
print(f"manifest validation passed: {len(manifests)} exact aliases")
