#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import sys

from container_alias_lib import FIELDS, ContainerAliasError, load_container_aliases

root = pathlib.Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    print("usage: container-alias-query.py ALIAS", file=sys.stderr)
    raise SystemExit(2)
alias = sys.argv[1]
try:
    entry = load_container_aliases(root)[alias]
except (KeyError, OSError, ValueError, ContainerAliasError) as error:
    print(f"container alias lookup failed: {error}", file=sys.stderr)
    raise SystemExit(2) from None
print("\t".join(entry[field] for field in FIELDS))
