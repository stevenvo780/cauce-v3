#!/usr/bin/env python3
"""Reject NUL bytes in repository text sources without printing their contents."""

from __future__ import annotations

import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEXT_SUFFIXES = {
    ".cjs", ".css", ".d.mts", ".env.example", ".html", ".js", ".json", ".jsx",
    ".md", ".mjs", ".mts", ".py", ".sh", ".sql", ".ts", ".tsx", ".txt", ".yaml", ".yml",
}


def is_text_source(path: pathlib.Path) -> bool:
    name = path.name
    if name in {"Dockerfile", "Makefile", "AGENTS.md", "CLAUDE.md"}:
        return True
    return any(name.endswith(suffix) for suffix in TEXT_SUFFIXES)


def main() -> int:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    failures: list[str] = []
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        relative = pathlib.PurePosixPath(raw.decode("utf-8", "strict"))
        path = ROOT.joinpath(*relative.parts)
        if is_text_source(path) and path.is_file() and b"\0" in path.read_bytes():
            failures.append(relative.as_posix())
    if failures:
        for failure in failures:
            print(f"source hygiene failed: NUL byte in {failure}", file=sys.stderr)
        return 1
    print("source hygiene passed: repository text sources contain no NUL bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
