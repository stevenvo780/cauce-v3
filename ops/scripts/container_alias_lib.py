#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import re
from typing import Any


EXPECTED = {
    "argos": ("Steven", "grp.steven", "ctrl-infra", "dev", "/home/dev", "/home/dev/.local/state/cauce-v3/argos", "hermes"),
    "dedalo": ("Pablo", "grp.pablo", "ws-pablo-dev", "dev", "/home/dev", "/workspace/.cauce-v3/dedalo", "codex"),
    "hegel": ("Jhon", "grp.jhon", "agv2-jhon-hegel-oc", "claw", "/home/claw", "/home/claw/.openclaw/cauce-v3/hegel", "openclaw"),
    "janus": ("Miguel", "grp.miguel", "claw-miguel", "claw", "/home/claw", "/home/claw/.openclaw/cauce-v3/janus", "openclaw"),
    "jarvis": ("Steven", "grp.steven", "claw", "claw", "/home/claw", "/home/claw/.openclaw/cauce-v3/jarvis", "openclaw"),
    "kant": ("Steven", "grp.steven", "ctrl-infra", "dev", "/home/dev", "/home/dev/.local/state/cauce-v3/kant", "codex"),
    "kratos": ("Miguel", "grp.miguel", "ws-humanizar", "dev", "/home/dev", "/home/dev/.local/state/cauce-v3/kratos", "codex"),
    "midas": ("Pablo", "grp.pablo", "agv2-pablo-marcas-oc", "claw", "/home/claw", "/home/claw/.openclaw/cauce-v3/midas", "openclaw"),
    "salva": ("Isa", "grp.isa", "ws-isa", "dev", "/home/dev", "/home/dev/.local/state/cauce-v3/salva", "codex"),
    "seneca": ("Pablo", "grp.pablo", "agv2-pablo-personal-oc", "claw", "/home/claw", "/home/claw/.openclaw/cauce-v3/seneca", "openclaw"),
    "socrates": ("Steven", "grp.steven", "ws-prizma", "dev", "/home/dev", "/home/dev/.local/state/cauce-v3/socrates", "codex"),
    "vulcano": ("Pablo", "grp.pablo", "ws-pablo", "dev", "/home/dev", "/workspace/.cauce-v3/vulcano", "claude"),
}
FIELDS = ("tenant", "room", "container", "user", "home", "stateDirectory", "harness")
NAME_RE = re.compile(r"^[a-z][a-z0-9.-]*$")
HARNESS = {"openclaw", "opencode", "claude", "hermes", "codex"}


class ContainerAliasError(ValueError):
    pass


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContainerAliasError(f"{label} must be an object")
    return value


def _absolute_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("/") or "//" in value:
        raise ContainerAliasError(f"{label} must be a canonical absolute path")
    path = pathlib.PurePosixPath(value)
    if str(path) != value or ".." in path.parts or "." in path.parts:
        raise ContainerAliasError(f"{label} must be a canonical absolute path")
    return value


def load_container_aliases(root: pathlib.Path) -> dict[str, dict[str, str]]:
    source = root / "container-aliases.json"
    document = _mapping(json.loads(source.read_text(encoding="utf-8")), str(source))
    if set(document) != {"schemaVersion", "aliases"} or document["schemaVersion"] != 1:
        raise ContainerAliasError("container alias mapping must use exact schemaVersion 1")
    aliases = _mapping(document["aliases"], "aliases")
    if set(aliases) != set(EXPECTED):
        raise ContainerAliasError(
            f"container aliases differ: missing={sorted(set(EXPECTED)-set(aliases))} "
            f"extra={sorted(set(aliases)-set(EXPECTED))}"
        )
    validated: dict[str, dict[str, str]] = {}
    for alias in sorted(aliases):
        if not NAME_RE.fullmatch(alias):
            raise ContainerAliasError(f"invalid alias: {alias}")
        entry = _mapping(aliases[alias], alias)
        if set(entry) != set(FIELDS):
            raise ContainerAliasError(f"{alias} must have exact fields {FIELDS}")
        actual = tuple(entry[field] for field in FIELDS)
        if actual != EXPECTED[alias]:
            raise ContainerAliasError(f"{alias} differs from the assigned container fleet mapping")
        for field in ("container", "user"):
            if not isinstance(entry[field], str) or not NAME_RE.fullmatch(entry[field]):
                raise ContainerAliasError(f"{alias}.{field} is invalid")
        for field in ("home", "stateDirectory"):
            _absolute_path(entry[field], f"{alias}.{field}")
        if entry["harness"] not in HARNESS:
            raise ContainerAliasError(f"{alias}.harness is invalid")
        # The persistent mount that backs the state directory is no longer pinned here:
        # every real container keeps the alias state inside a broad persistent bind, so the
        # supervisor discovers the containing bind/volume from `docker inspect` at runtime.
        validated[alias] = {field: str(entry[field]) for field in FIELDS}
    return validated
