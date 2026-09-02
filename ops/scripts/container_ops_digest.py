#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import pathlib
import sys

_scripts_dir = os.path.dirname(os.path.abspath(__file__))
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)
from digest_lib import fold_digest, tracked_files  # noqa: E402  (sys.path shim above must run first)

OPERATIONS_SOURCES = (
    "container-aliases.json",
    "scripts/digest_lib.py",
    "scripts/container-adapter-supervisor.sh",
    "scripts/alias-runner.sh",
    "container-runtime/cauce-container-runtime.py",
    "scripts/container_alias_lib.py",
    "scripts/manifest_lib.py",
    "scripts/container-alias-query.py",
    "scripts/validate-container-mount.py",
    "scripts/generate-container-units.py",
    "scripts/pin-container-release.py",
    "scripts/container_ops_digest.py",
    "scripts/cutover.sh",
    "scripts/create-inactive-override-manifest.py",
    "scripts/migration-gate.mjs",
    "scripts/validate.sh",
    # Critical adversarial suites and their fakes: a change to the supervisor/lifecycle
    # behaviour that is not matched by its regression tests must move this digest.
    "tests/container-supervisor.test.mjs",
    "tests/test_container_runtime_reaping.py",
    "tests/alias-runner.test.mjs",
    "tests/container-cutover.test.mjs",
    "tests/container-ops-evidence.test.mjs",
    "tests/fake-docker.mjs",
    "tests/fake-systemctl.mjs",
    "tests/fake-container-supervisor.mjs",
    "tests/fake-gate-collector.mjs",
    # Operator runbooks that document the exact invariants above.
    "runbooks/container-adapters.md",
    "runbooks/alias-cutover.md",
)

# Everything that can change how container operations are configured, monitored or recovered.
# Artifacts/private material are deliberately excluded and secrets never enter a source digest.
# Recursive discovery prevents a newly added operational script from evading OPERATIONS.sha256.
OPERATIONAL_TREES = (
    "scripts",
    "tests",
    "runbooks",
    "schemas",
    "systemd",
    "observability",
    "manifests",
    "pty-agent",
    "container-runtime",
    "harness",
    "guardias",
    "openclaw-gateway",
    "cli",
    "generated/systemd",
)
OPERATIONAL_ROOT_FILES = (
    "Makefile",
    "README.md",
    "INSTALLATION.md",
    "GATE_CONTRACT.md",
    "compose.test.yaml",
    "container-aliases.json",
    "hermes-runtime.json",
    "config/prod.env.example",
    "config/host-backup.env.example",
)


def generated_logical_path(path: pathlib.Path, generated: pathlib.Path, *, rootless: bool) -> str:
    prefix = "generated/container-systemd/rootless" if rootless else "generated/container-systemd"
    return f"{prefix}/{path.relative_to(generated).as_posix()}"


def logical_path(path: pathlib.Path, root: pathlib.Path, generated: pathlib.Path, *, rootless: bool) -> str:
    if path.is_relative_to(generated):
        return generated_logical_path(path, generated, rootless=rootless)
    return path.relative_to(root).as_posix()


def operational_source(path: pathlib.Path, local: pathlib.PurePosixPath) -> bool:
    """Interpreter and test-runner caches are never operational source, and neither is a symlink.

    Recursive discovery over the operational trees is what stops a newly added script from evading
    OPERATIONS.sha256, so the only things filtered out here are the families that are outputs of
    running the tooling rather than inputs to it.
    """
    return (
        path.is_file()
        and not path.is_symlink()
        and "__pycache__" not in local.parts
        and ".pytest_cache" not in local.parts
        and path.suffix not in {".pyc", ".pyo"}
    )


def operational_files(root: pathlib.Path, generated: pathlib.Path, *, rootless: bool = False) -> list[pathlib.Path]:
    files = [root / relative for relative in (*OPERATIONS_SOURCES, *OPERATIONAL_ROOT_FILES)]
    files.extend(root / name for name in ("flota.json", "flota-fisica.json") if (root / name).is_file())
    files.extend(tracked_files(root, OPERATIONAL_TREES, keep=operational_source))
    files.extend(sorted(generated.glob("cauce-v3-container-*.service")))
    files.extend(sorted((generated / "configs").glob("*.env.example")))
    if not rootless:
        # The system digest also binds the complete checked-in
        # rootless deliverable. Rootless keeps its own independently checkable
        # digest/SHA set, while OPERATIONS.sha256 covers both deployment modes.
        checked_rootless = root / "generated" / "container-systemd" / "rootless"
        files.extend(sorted(checked_rootless.glob("cauce-v3-container-*.service")))
        files.extend(sorted((checked_rootless / "configs").glob("*.env.example")))
        files.extend((checked_rootless / "OPERATIONS.sha256", checked_rootless / "SHA256SUMS"))
    files = list(set(files))
    missing = [path for path in files if not path.is_file() or path.is_symlink()]
    if missing:
        raise ValueError(f"missing or symlinked operational input: {missing[0]}")
    return sorted(files, key=lambda path: logical_path(path, root, generated, rootless=rootless))


def operational_digest(root: pathlib.Path, generated: pathlib.Path, *, rootless: bool = False) -> str:
    return fold_digest(
        (logical_path(path, root, generated, rootless=rootless), path)
        for path in operational_files(root, generated, rootless=rootless)
    )


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Digest container supervisor operational sources and generated outputs")
    parser.add_argument("--generated", type=pathlib.Path)
    parser.add_argument("--rootless", action="store_true", help="use rootless generated units/configs")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--list", action="store_true", help="print the logical inputs covered by the digest")
    args = parser.parse_args()
    try:
        generated_source = args.generated or root / "generated" / "container-systemd" / ("rootless" if args.rootless else "")
        generated = generated_source.resolve()
        if args.list:
            for path in operational_files(root, generated, rootless=args.rootless):
                print(logical_path(path, root, generated, rootless=args.rootless))
            raise SystemExit(0)
        value = operational_digest(root, generated, rootless=args.rootless)
        if args.check:
            expected = (generated / "OPERATIONS.sha256").read_text(encoding="utf-8").strip()
            if expected != value:
                raise ValueError("OPERATIONS.sha256 differs from current operational inputs")
            mode = "rootless" if args.rootless else "system"
            print(f"container operational digest passed ({mode})")
        else:
            print(value)
    except (OSError, ValueError) as error:
        print(f"container operational digest failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
