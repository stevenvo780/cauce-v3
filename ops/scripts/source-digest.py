#!/usr/bin/env python3
"""Digest source families BY DOMAIN, so each evidence artifact is bound to exactly what
can change its own result.

Why domains exist
-----------------
This script used to emit one whole-tree digest, and every evidence artifact was pinned to it.
`apps/console` was inside that digest, so any console edit -- a CSS tweak in the terminal panel --
invalidated the compose-authentic fault-injection evidence. That evidence costs a full release-host
run with Docker Compose v2 to regenerate, and a console stylesheet has no causal path to how the
gateway behaves when its process is killed. Evidence that is expensive to regenerate and trivially
invalidated is evidence people hand-edit instead of re-running. That already happened. The gate was
not detecting forgery, it was manufacturing the incentive for it.

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
         that can change the bytes or behaviour of the five final services. This is the domain that
         backs compose-authentic / runtime-authentic fault-injection evidence and the fleet matrix.

console  Everything the `console` image stage is built from. Its only consumer is the console image
         entry of the release build evidence, which is regenerated in the same `release-build.sh`
         invocation as the runtime image, so over-coverage here costs nothing.

harness  The measurement apparatus for authentic evidence: the runner that drives the faults, the
         fake external world it asserts against, the authentic Compose topology and the fault
         drivers. These files decide what a fault-injection run reports, so authentic evidence is
         only meaningful when it is bound to them. This closes the opposite hole from the console
         one: previously the whole of `ops/` was outside the digest, so the harness could be
         weakened without moving any digest the gate checks.

full     Union of every domain. Backs the three-round verification evidence, because
         `pnpm lint | typecheck | build | test` genuinely exercises every domain (see
         `lint:console`, `typecheck:console`, `build:console`, the console vitest project, and
         tests/gateway-hardening/console-api-contract.test.ts, which reads apps/console sources).
         `full` is also the safe default: a caller that forgets to declare a domain gets the
         strictest digest and fails closed, never open.

Justification for the exclusions that LOOSEN anything
------------------------------------------------------
`apps/console/src/features/_grafo/` is operator-local SQL scratch.  It is excluded from every
domain by its exact repository-relative prefix, and nowhere else.  It cannot enter a release:
`.dockerignore` excludes it from ordinary Docker contexts and `release-build.sh` builds from the
committed `git archive`, rejects that path if it ever becomes committed, and fails on every other
untracked path.  Excluding the scratch here makes a digest recomputed on the release host describe
the same committed RC that was built, without moving or hashing local operator notes.

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

Everything else that could plausibly matter stays inside `runtime`: the whole of `packages/`
(including packages/mcp-fleet-monitor, which is not in the image but is in the workspace),
the whole of `services/` (including terminal-relay, which is in the image even though it is not one
of the five services the authentic suite deploys) and the whole of `deploy/`.

Git, build output, test artifacts, private env files and dependency caches are excluded from every
domain. Paths and bytes are both hashed, so renames are observable.
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]

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

DOMAIN_INPUTS: dict[str, tuple[str, ...]] = {
    # tsconfig.build.json emits every runtime binary; vitest.config.ts is copied into the build
    # stage next to the runtime sources. Neither takes part in the console build (apps/console
    # builds with `tsc -b` over its own project references plus Vite).
    "runtime": SHARED_MANIFESTS + ("tsconfig.build.json", "vitest.config.ts", "packages", "services", "deploy"),
    # `deploy` stays whole here as well: the console image copies deploy/nginx-console-tls.conf, and
    # enumerating single files would let a future console-relevant deploy file escape the digest.
    # Over-coverage is harmless for this domain -- console evidence is produced by the same
    # release-build.sh run as the runtime image, so it is never expensive to regenerate.
    "console": SHARED_MANIFESTS + ("apps/console", "deploy"),
    # The apparatus that decides what an authentic run reports. `ops/harness` is taken whole so a
    # new harness module cannot appear outside the digest; the ops/scripts entries are enumerated
    # because ops/scripts also holds ~50 files with no bearing on the measurement.
    "harness": (
        "ops/harness",
        "ops/compose.authentic.yaml",
        "ops/scripts/compose-files.sh",
        "ops/scripts/compose.sh",
        "ops/scripts/fault-compose.sh",
        "ops/scripts/fault-compose.test.sh",
        "ops/scripts/fault-runtime.sh",
        "ops/scripts/smoke-compose-authentic.sh",
        "ops/scripts/smoke-runtime-authentic.sh",
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
    # Agent worktrees are checked out INSIDE the repository under .claude/worktrees/, so a stray
    # nested checkout must never contribute to a release digest.
    ".claude",
}

# Do not turn this into a name-based exclusion.  Only the explicitly approved operator scratch
# path is outside release source digests; a `_grafo` directory anywhere else remains covered.
EXCLUDED_PREFIXES = (pathlib.PurePosixPath("apps/console/src/features/_grafo"),)


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
        paths = [candidate] if candidate.is_file() else candidate.rglob("*")
        for path in paths:
            if not path.is_file() or path.is_symlink():
                continue
            local = path.relative_to(root)
            if any(part in EXCLUDED_PARTS for part in local.parts):
                continue
            local_posix = pathlib.PurePosixPath(local.as_posix())
            if any(local_posix == prefix or prefix in local_posix.parents for prefix in EXCLUDED_PREFIXES):
                continue
            if path.name == ".env" or path.name.startswith(".env."):
                continue
            selected.append(path)
    return sorted(set(selected), key=lambda item: item.relative_to(root).as_posix())


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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--domain",
        choices=DOMAINS,
        default="full",
        help="source domain to digest; defaults to the strictest domain so an undeclared caller fails closed",
    )
    parser.add_argument("--list", action="store_true", help="print the repository-relative paths covered by the domain")
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=None,
        help="tree to digest (used by tests and by the committed git-archive release context)",
    )
    parser.add_argument("output", nargs="?", type=pathlib.Path, help="write the digest here instead of stdout")
    args = parser.parse_args(argv)

    root = (args.root or ROOT).resolve()
    if args.list:
        for path in files(root, args.domain):
            print(path.relative_to(root).as_posix())
        return 0
    value = compute(root, args.domain)
    if args.output is None:
        print(value)
    else:
        args.output.write_text(f"{value}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
