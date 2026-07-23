#!/usr/bin/env python3
"""Digest exactly the source families copied into the final runtime image.

The digest deliberately avoids Git, build output, test artifacts, private env files,
and dependency caches. Paths and bytes are both included so renames are observable.
"""
from __future__ import annotations

import hashlib
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]
INPUTS = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "packages",
    "services",
    "apps/console",
    "deploy",
)
EXCLUDED_PARTS = {"node_modules", "dist", "coverage", ".git", ".serena", ".test-state"}


def files() -> list[pathlib.Path]:
    selected: list[pathlib.Path] = []
    for relative in INPUTS:
        candidate = ROOT / relative
        paths = [candidate] if candidate.is_file() else candidate.rglob("*")
        for path in paths:
            if not path.is_file() or path.is_symlink():
                continue
            local = path.relative_to(ROOT)
            if any(part in EXCLUDED_PARTS for part in local.parts):
                continue
            if path.name == ".env" or path.name.startswith(".env."):
                continue
            selected.append(path)
    return sorted(set(selected), key=lambda item: item.relative_to(ROOT).as_posix())


digest = hashlib.sha256()
for path in files():
    relative = path.relative_to(ROOT).as_posix().encode("utf-8")
    content = path.read_bytes()
    digest.update(len(relative).to_bytes(8, "big"))
    digest.update(relative)
    digest.update(len(content).to_bytes(8, "big"))
    digest.update(content)

value = f"sha256:{digest.hexdigest()}"
if len(sys.argv) == 1:
    print(value)
elif len(sys.argv) == 2:
    pathlib.Path(sys.argv[1]).write_text(f"{value}\n", encoding="utf-8")
else:
    raise SystemExit("usage: source-digest.py [output-file]")
