"""Materialize content-addressed desired fleet generations outside repositories."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import tempfile
from typing import Any

from atomic_file import atomic_write

SCRIPTS = pathlib.Path(__file__).resolve().parent
PROJECT = SCRIPTS.parents[1]
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_ARTIFACTS = frozenset({"flota.json", "container-aliases.json", "generated/fleet.json",
                                "schemas/alias-manifest.schema.json"})
ARTIFACT_PATTERN = re.compile(
    r"^(?:flota\.json|container-aliases\.json|generated/fleet\.json|"
    r"schemas/alias-manifest\.schema\.json|manifests/[a-z][a-z0-9-]{0,63}\.yaml|"
    r"bootstrap/container-aliases\.json|bootstrap/manifests/[a-z][a-z0-9-]{0,63}\.yaml)$"
)


def _script(name: str) -> Any:
    path = SCRIPTS / name
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise ValueError(f"cannot load fleet generator: {name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXPORTER = _script("export-fleet-snapshot.py")
ALIASES = _script("generate-container-aliases.py")
MANIFESTS = _script("generate-manifests.py")
RUNTIME = _script("generate-runtime-fleet.py")


def external_directory(directory: pathlib.Path) -> pathlib.Path:
    if not directory.is_absolute():
        raise ValueError("runtime state directory must be absolute and external to repositories")
    resolved = directory.resolve()
    if resolved.is_relative_to(PROJECT):
        raise ValueError("runtime state directory must be external to repositories")
    for parent in (resolved, *resolved.parents):
        if (parent / ".git").exists():
            raise ValueError("runtime state directory must be external to repositories")
    return resolved


def _sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _destination(root: pathlib.Path, relative: str) -> pathlib.Path:
    destination = root / relative
    current = pathlib.Path(destination.anchor)
    for component in destination.parts[1:]:
        current /= component
        if current.is_symlink():
            raise ValueError(f"runtime artifact path contains a symlink: {current}")
    if not destination.resolve().is_relative_to(root.resolve()):
        raise ValueError("runtime artifact destination escapes its external directory")
    return destination


def _verify_artifacts(generation: pathlib.Path, digests: dict[str, str]) -> None:
    for name, digest in digests.items():
        if _sha256(_destination(generation, name).read_bytes()) != digest:
            raise ValueError(f"desired fleet artifact digest differs: {name}")


def _publish_generation(state: pathlib.Path, receipt: dict[str, Any], files: dict[str, bytes]) -> None:
    generation = _destination(state, f"generations/{receipt['generation']}")
    if generation.exists():
        _verify_artifacts(generation, receipt["files"])
        return
    generation.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=f".{generation.name}.", dir=generation.parent))
    try:
        for name, body in files.items():
            atomic_write(_destination(temporary, name), body)
        _destination(state, f"generations/{receipt['generation']}")
        if generation.exists():
            _verify_artifacts(generation, receipt["files"])
            return
        try:
            os.rename(temporary, generation)
        except OSError:
            if not generation.exists():
                raise
            _verify_artifacts(generation, receipt["files"])
            return
        descriptor = os.open(generation.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def render_artifacts(source: Any, placement: dict[str, dict[str, str]]) -> dict[str, bytes]:
    snapshot = EXPORTER.snapshot_document(source, placement)
    fleet = MANIFESTS.validate_fleet(snapshot["fleet"])
    files = {
        "flota.json": EXPORTER.canonical_bytes(snapshot),
        "container-aliases.json": ALIASES.render(snapshot).encode("utf-8"),
        "generated/fleet.json": RUNTIME.render(fleet, snapshot["placement"]),
        "schemas/alias-manifest.schema.json": (PROJECT / "ops/schemas/alias-manifest.schema.json").read_bytes(),
    }
    for key, row in sorted(fleet.items()):
        files[f"manifests/{key}.yaml"] = MANIFESTS.render_manifest(key, row).encode("utf-8")
    if snapshot.get("bootstrap"):
        bootstrap = MANIFESTS.validate_fleet(snapshot["bootstrap"], bootstrap=True)
        preparation = {**snapshot, "fleet": bootstrap, "systemPrincipals": {}, "retired": {}}
        files["bootstrap/container-aliases.json"] = ALIASES.render(preparation).encode("utf-8")
        for key, row in sorted(bootstrap.items()):
            files[f"bootstrap/manifests/{key}.yaml"] = MANIFESTS.render_manifest(key, row).encode("utf-8")
    return files


def _receipt(files: dict[str, bytes]) -> dict[str, Any]:
    digests = {name: _sha256(body) for name, body in sorted(files.items())}
    return {
        "schemaVersion": 1,
        "generation": _sha256(EXPORTER.canonical_bytes(digests)),
        "snapshotSha256": digests["flota.json"],
        "files": digests,
    }


def materialize(
    source: Any, placement: dict[str, dict[str, str]], state_directory: pathlib.Path,
) -> dict[str, Any]:
    state = external_directory(state_directory)
    files = render_artifacts(source, placement)
    receipt = _receipt(files)
    _destination(state, "desired-fleet.json")
    _publish_generation(state, receipt, files)
    atomic_write(_destination(state, "desired-fleet.json"), EXPORTER.canonical_bytes(receipt))
    return receipt


def load_runtime_fleet(state_directory: pathlib.Path, kind: str) -> dict[str, Any]:
    if kind not in {"desired", "applied"}:
        raise ValueError("fleet receipt kind must be desired or applied")
    state = external_directory(state_directory)
    receipt = json.loads(_destination(state, f"{kind}-fleet.json").read_bytes())
    if not isinstance(receipt, dict) or set(receipt) != {"schemaVersion", "generation", "snapshotSha256", "files"} \
            or type(receipt["schemaVersion"]) is not int or receipt["schemaVersion"] != 1:
        raise ValueError("invalid desired fleet receipt schema")
    digests = receipt["files"]
    if not isinstance(digests, dict) or not digests:
        raise ValueError("desired fleet receipt has no artifact digests")
    if not REQUIRED_ARTIFACTS.issubset(digests):
        raise ValueError("desired fleet receipt omits required artifacts")
    for name, digest in digests.items():
        if not isinstance(name, str) or ARTIFACT_PATTERN.fullmatch(name) is None \
                or not isinstance(digest, str) or DIGEST_PATTERN.fullmatch(digest) is None:
            raise ValueError("desired fleet receipt contains an invalid artifact digest")
    generation_digest = _sha256(EXPORTER.canonical_bytes(digests))
    if receipt["generation"] != generation_digest or receipt["snapshotSha256"] != digests.get("flota.json"):
        raise ValueError("desired fleet receipt digest differs")
    generation = _destination(state, f"generations/{generation_digest}")
    _verify_artifacts(generation, digests)
    return receipt


def load_desired_fleet(state_directory: pathlib.Path) -> dict[str, Any]:
    return load_runtime_fleet(state_directory, "desired")


def load_applied_fleet(state_directory: pathlib.Path) -> dict[str, Any]:
    return load_runtime_fleet(state_directory, "applied")
