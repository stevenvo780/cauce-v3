#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys


STATIC_INPUTS = (
    "container-aliases.json",
    "scripts/container-adapter-supervisor.sh",
    "scripts/alias-runner.sh",
    "container-runtime/cauce-container-runtime.py",
    "scripts/container_alias_lib.py",
    "scripts/container-alias-query.py",
    "scripts/validate-container-mount.py",
    "scripts/generate-container-units.py",
    "scripts/pin-container-release.py",
    "scripts/container_ops_digest.py",
    "scripts/cutover.sh",
    "scripts/cutover-rollback.sh",
    "scripts/rollback.sh",
    "scripts/migration-gate.mjs",
    "scripts/validate.sh",
    "scripts/release-gate.sh",
    # Critical adversarial suites and their fakes: a change to the supervisor/lifecycle
    # behaviour that is not matched by its regression tests must move this digest.
    "tests/container-supervisor.test.mjs",
    "tests/alias-runner.test.mjs",
    "tests/container-release-pin.test.mjs",
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


def generated_logical_path(path: pathlib.Path, generated: pathlib.Path, *, rootless: bool) -> str:
    prefix = "generated/container-systemd/rootless" if rootless else "generated/container-systemd"
    return f"{prefix}/{path.relative_to(generated).as_posix()}"


def operational_files(root: pathlib.Path, generated: pathlib.Path, *, rootless: bool = False) -> list[pathlib.Path]:
    files = [root / relative for relative in STATIC_INPUTS]
    files.extend(sorted(generated.glob("cauce-v3-container-*.service")))
    files.extend(sorted((generated / "configs").glob("*.env.example")))
    if not rootless:
        # The release-facing system digest also binds the complete checked-in
        # rootless deliverable. Rootless keeps its own independently checkable
        # digest/SHA set, while OPERATIONS.sha256 covers both deployment modes.
        checked_rootless = root / "generated" / "container-systemd" / "rootless"
        files.extend(sorted(checked_rootless.glob("cauce-v3-container-*.service")))
        files.extend(sorted((checked_rootless / "configs").glob("*.env.example")))
        files.extend((checked_rootless / "OPERATIONS.sha256", checked_rootless / "SHA256SUMS"))
    missing = [path for path in files if not path.is_file() or path.is_symlink()]
    if missing:
        raise ValueError(f"missing or symlinked operational input: {missing[0]}")
    def logical(path: pathlib.Path) -> str:
        if path.is_relative_to(generated):
            return generated_logical_path(path, generated, rootless=rootless)
        return path.relative_to(root).as_posix()
    return sorted(files, key=logical)


def operational_digest(root: pathlib.Path, generated: pathlib.Path, *, rootless: bool = False) -> str:
    digest = hashlib.sha256()
    for path in operational_files(root, generated, rootless=rootless):
        if path.is_relative_to(generated):
            relative = generated_logical_path(path, generated, rootless=rootless)
        else:
            relative = path.relative_to(root).as_posix()
        name = relative.encode("utf-8")
        content = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


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
                if path.is_relative_to(generated):
                    print(generated_logical_path(path, generated, rootless=args.rootless))
                else:
                    print(path.relative_to(root).as_posix())
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
        raise SystemExit(1)
