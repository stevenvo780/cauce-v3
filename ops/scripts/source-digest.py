#!/usr/bin/env python3
"""Digest source families BY DOMAIN, so each evidence artifact is bound to exactly what
can change its own result.

Why domains exist
-----------------
This script used to emit one whole-tree digest, and every evidence artifact was pinned to it.
`apps/console` was inside that digest, so any console edit -- a CSS tweak in the terminal panel --
invalidated runtime-image evidence even though a console stylesheet has no causal path to runtime
behaviour. Evidence that is expensive to regenerate and trivially invalidated is evidence people
hand-edit instead of re-running, so each live producer now declares its causal domain.

The rule implemented here
-------------------------
The digest backing an evidence artifact must cover EXACTLY the files that can change that
artifact's result.
  * Covering more  -> spurious invalidation -> pressure to forge the artifact.
  * Covering less  -> evidence that does not prove what it claims.
When a file's causal relationship to a measurement is unclear, it stays INSIDE the domain.
Directory-level inclusion is preferred over file enumeration wherever a directory is wholly owned
by one domain, because a file added later is then covered automatically instead of silently
escaping the digest.

Domains
-------
runtime  Everything the `runtime` image stage of deploy/Dockerfile is built from, plus everything
         that can change its bytes or behaviour. This backs the runtime source identity recorded by
         Testcontainers evidence.

console  Everything the `console` image stage is built from. Console evidence is cheap to
         regenerate, so over-coverage here costs nothing.

testcontainers  The source-executed PostgreSQL/Testcontainers QA apparatus: its real-gateway runner,
         E2E suites, disposable database helper, evidence schema/validator and wrapper.  Reports
         carry this independently from the runtime digest and from the immutable PostgreSQL image
         they actually started.

verification  The root and ops test trees plus lint/typecheck/test orchestration and every
         operational source family those gates execute or inspect.  This domain is not used to
         relabel runtime evidence; it exists so `full` genuinely covers the tests, root `scripts/`,
         schemas, generated-unit inputs and checked operational policy. Whole-directory inclusion
         is deliberate: a new script or schema must not silently escape the attestation.

full     Union of every domain. This is the safe default: a caller that forgets to declare a
         domain gets the strictest digest and fails closed, never open.

Justification for the exclusions that LOOSEN anything
------------------------------------------------------
`apps/console/src/features/_grafo/` is operator-local SQL scratch.  It is excluded from every
domain by its exact repository-relative prefix, and nowhere else. `.dockerignore` excludes it from
ordinary Docker contexts. Excluding the scratch here keeps local operator notes out without
widening the exclusion to any other path.

`apps/console` is absent from the `runtime` domain. This is safe because there is no causal path
from apps/console to the runtime image or to runtime behaviour:
  1. deploy/Dockerfile copies apps/console only into the `build` stage and into the
     `console-base`/`console-dev`/`console` stages. The `runtime` stage copies from
     `production-dependencies` and from the compiled `dist/` of core/services only; no console file
     and no console dependency reaches it.
  2. `production-dependencies` never copies apps/console/package.json and its `pnpm --filter` list
     excludes @cauce/console, so console dependencies are not in the runtime node_modules either.
  3. tsconfig.json's `include` list is packages/protocol, packages/store, services, tests and
     vitest.config.ts. tsconfig.build.json (which produces every runtime binary) extends it and
     adds no console path, so `pnpm build:core` never compiles console sources.
  4. apps/console imports nothing from the workspace (no `@cauce/*` import exists under
     apps/console/), so it cannot alter shared compiled output.
  5. The dependency graph is still covered: pnpm-lock.yaml and pnpm-workspace.yaml stay in the
     `runtime` domain, so a console dependency change still moves the runtime digest. A console
     package.json edit that contradicts the lockfile fails `pnpm install --frozen-lockfile` in the
     shared build stage, i.e. it fails loudly at build time rather than shipping silently.
The one file that reads apps/console from outside is tests/gateway-hardening/console-api-contract.test.ts,
which runs under `pnpm test` -- verification evidence -- and verification is bound to `full`, not to
`runtime`. So that coupling is preserved where it actually exists.

Timestamped evidence under `ops/artifacts/` is OUTPUT of the verification commands, not input
source. That producer-owned root is excluded by exact prefix; a source
fixture in some other directory named `artifacts` remains covered.  Likewise, an
ignored worktree file (for example an operator backup beside a CLI) is not part of the Git source
tree and is excluded before its bytes are read.  Tracked files remain covered even if an ignore
pattern would match their name, and untracked files which are not ignored remain covered so a new
script cannot silently escape a dirty-tree digest.  Git archives have no ignored files to filter.
After those exclusions, any source symlink is rejected fail-closed by both listing and hashing.
The current source tree needs none, and rejecting them avoids a link whose target is external,
outside the declared domain or later retargeted changing executed behaviour without moving bytes.

Everything else that could plausibly matter stays inside `runtime`: the whole of `packages/`
(including packages/mcp-fleet-monitor, which is not in the image but is in the workspace),
the whole of `services/` (including terminal-relay) and the whole of `deploy/`.

Git, build output, test artifacts, private env files and dependency caches are excluded from every
domain. Paths and bytes are both hashed, so renames are observable.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]


class SourceDigestError(RuntimeError):
    """A sanitized source-selection failure safe to report without path or target details."""


# Root manifests copied into the shared `build` stage before `pnpm install --frozen-lockfile`.
# They define the workspace shape and the resolved dependency graph for BOTH images, so a change
# to any of them can change either one.
SHARED_MANIFESTS = (
    ".dockerignore",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
)

# `pnpm test` executes operational scripts directly from tests/unit, while
# The verification suite additionally runs operational gates whose result depends on more than
# the test files themselves.
# Keep complete source families here instead of enumerating today's scripts: that is what makes a
# previously issued `full` report become stale when a new operational helper or schema changes.
VERIFICATION_OPERATIONAL_INPUTS = (
    ".gitignore",
    "ops/.gitignore",
    "ops/Makefile",
    "ops/cli",
    "ops/compose.test.yaml",
    "ops/container-aliases.json",
    "ops/container-runtime",
    "ops/generated",
    "ops/guardias",
    "ops/harness",
    "ops/manifests",
    "ops/observability",
    "ops/runbooks",
    "ops/schemas",
    "ops/scripts",
)

DOMAIN_INPUTS: dict[str, tuple[str, ...]] = {
    # tsconfig.build.json emits every runtime binary; vitest.config.ts is copied into the build
    # stage next to the runtime sources. Neither takes part in the console build (apps/console
    # builds with `tsc -b` over its own project references plus Vite).
    "runtime": SHARED_MANIFESTS
    + ("tsconfig.build.json", "vitest.config.ts", "packages", "services", "deploy"),
    # `deploy` stays whole here as well: the console image copies deploy/nginx-console-tls.conf, and
    # enumerating single files would let a future console-relevant deploy file escape the digest.
    # Over-coverage is harmless for this domain because console evidence is cheap to regenerate.
    "console": SHARED_MANIFESTS + ("apps/console", "deploy"),
    "testcontainers": SHARED_MANIFESTS
    + (
        "vitest.config.ts",
        "tests/e2e",
        "tests/helpers",
        "ops/harness/runner.mjs",
        "ops/scripts/run-testcontainers.sh",
        "ops/scripts/validate-testcontainers-evidence.py",
        "ops/schemas/testcontainers-evidence.schema.json",
    ),
    "verification": SHARED_MANIFESTS
    + VERIFICATION_OPERATIONAL_INPUTS
    + (
        "eslint.config.js",
        "vitest.config.ts",
        "scripts",
        "tests",
        "ops/tests",
    ),
}

# `full` is the union of every declared domain and the default for undeclared callers.
DOMAINS = (*DOMAIN_INPUTS, "full")

EXCLUDED_PARTS = {
    "node_modules",
    "dist",
    "coverage",
    ".git",
    ".serena",
    ".test-state",
    "__pycache__",
    ".pytest_cache",
    # Agent worktrees are checked out INSIDE the repository under .claude/worktrees/, so a stray
    # nested checkout must never contribute to a release digest.
    ".claude",
}

EXCLUDED_FILE_SUFFIXES = {".pyc", ".pyo"}

# Do not turn either family into a basename-based exclusion.  A `_grafo` or `artifacts` directory
# anywhere else can hold real source/fixtures and remains covered.
EXCLUDED_SOURCE_PREFIXES = (pathlib.PurePosixPath("apps/console/src/features/_grafo"),)
MUTABLE_OUTPUT_PREFIXES = (
    pathlib.PurePosixPath("ops/artifacts"),
)


def under_prefix(
    local: pathlib.PurePosixPath, prefixes: tuple[pathlib.PurePosixPath, ...]
) -> bool:
    return any(local == prefix or prefix in local.parents for prefix in prefixes)


def git_ignored(
    root: pathlib.Path, paths: list[pathlib.Path]
) -> set[pathlib.PurePosixPath]:
    """Return ignored, untracked paths for a real worktree without dropping other untracked source.

    A git archive and the hermetic synthetic trees used by tests have no `.git`, so every path in
    them is already an explicit input and no ignore lookup is needed.  `git check-ignore` omits
    tracked paths by default; this is important for committed fixtures whose names match an ignore
    pattern.  Operator-global excludes are disabled so a local preference cannot hide repository
    source, while repository `.gitignore` and `.git/info/exclude` keep their normal worktree role.
    """

    if not paths or not (root / ".git").exists():
        return set()
    probe = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        raise SourceDigestError(
            "source digest could not resolve worktree ignore policy"
        )
    if pathlib.Path(probe.stdout.strip()).resolve() != root:
        raise SourceDigestError(
            "source digest root differs from the resolved Git worktree"
        )

    relative = [path.relative_to(root).as_posix() for path in paths]
    result = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "-c",
            "core.excludesFile=/dev/null",
            "check-ignore",
            "--stdin",
            "-z",
        ],
        input="\0".join(relative) + "\0",
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in {0, 1}:
        raise SourceDigestError("source digest could not apply worktree ignore policy")
    return {
        pathlib.PurePosixPath(value) for value in result.stdout.split("\0") if value
    }


def domain_inputs(domain: str) -> tuple[str, ...]:
    if domain == "full":
        merged: list[str] = []
        for entries in DOMAIN_INPUTS.values():
            for entry in entries:
                if entry not in merged:
                    merged.append(entry)
        return tuple(merged)
    return DOMAIN_INPUTS[domain]


def files(root: pathlib.Path, domain: str) -> list[pathlib.Path]:
    selected: list[pathlib.Path] = []
    for relative in domain_inputs(domain):
        candidate = root / relative
        paths = (
            [candidate]
            if candidate.is_file() or candidate.is_symlink()
            else candidate.rglob("*")
        )
        for path in paths:
            if not path.is_symlink() and not path.is_file():
                continue
            local = path.relative_to(root)
            if any(part in EXCLUDED_PARTS for part in local.parts):
                continue
            if path.suffix in EXCLUDED_FILE_SUFFIXES:
                continue
            local_posix = pathlib.PurePosixPath(local.as_posix())
            if under_prefix(local_posix, EXCLUDED_SOURCE_PREFIXES):
                continue
            if under_prefix(local_posix, MUTABLE_OUTPUT_PREFIXES):
                continue
            if path.name == ".env" or path.name.startswith(".env."):
                continue
            selected.append(path)
    ordered = sorted(set(selected), key=lambda item: item.relative_to(root).as_posix())
    ignored = git_ignored(root, ordered)
    covered = [
        path
        for path in ordered
        if pathlib.PurePosixPath(path.relative_to(root).as_posix()) not in ignored
    ]
    if any(path.is_symlink() for path in covered):
        raise SourceDigestError("source digest rejects symlinks in covered inputs")
    return covered


def compute(root: pathlib.Path, domain: str) -> str:
    digest = hashlib.sha256()
    for path in files(root, domain):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--domain",
        choices=DOMAINS,
        default="full",
        help="source domain to digest; defaults to the strictest domain so an undeclared caller fails closed",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="print the repository-relative paths covered by the domain",
    )
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=None,
        help="tree to digest (used by tests and by the committed git-archive release context)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        type=pathlib.Path,
        help="write the digest here instead of stdout",
    )
    args = parser.parse_args(argv)

    root = (args.root or ROOT).resolve()
    try:
        if args.list:
            for path in files(root, args.domain):
                print(path.relative_to(root).as_posix())
            return 0
        value = compute(root, args.domain)
    except SourceDigestError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.output is None:
        print(value)
    else:
        args.output.write_text(f"{value}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
