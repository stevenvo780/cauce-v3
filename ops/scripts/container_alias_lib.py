#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import re
import stat
from typing import Any

FIELDS = ("tenant", "room", "container", "user", "home", "stateDirectory", "harness")
ALIAS_REQUIRED_FIELDS = (*FIELDS, "membershipRole", "systemdUser")
ALIAS_OPTIONAL_FIELDS = ("registryContainer", "workspace", "dockerHost")
PRINCIPAL_FIELDS = ("tenant", "room", "membershipRole")
NAME_RE = re.compile(r"^[a-z][a-z0-9.-]*$")
PLACEMENT_RE = re.compile(r"^(?:[a-z][a-z0-9.-]*|host:[a-z][a-z0-9.-]*)$")
TENANT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ROOM_RE = re.compile(r"^grp\.[a-z][a-z0-9_-]{0,63}$")
HARNESS = {"openclaw", "opencode", "claude", "hermes", "codex"}
MEMBERSHIP_ROLES = {"agent", "agent_notify", "operator"}
MAX_INVENTORY_BYTES = 1024 * 1024
READ_CHUNK_BYTES = 65536


class ContainerAliasError(ValueError):
    pass


class InventoryAccessError(ContainerAliasError):
    """The inventory file itself was rejected by a hardened read."""


class InventorySizeError(InventoryAccessError):
    """The inventory is larger than the hardened read accepts."""


class AliasNotDeclaredError(ContainerAliasError):
    """The inventory parses but declares no entry for the requested alias."""


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


def _read_source(source: pathlib.Path, hardened: bool) -> str:
    """Return the inventory text, optionally through a hardened open.

    A hardened read refuses a symlinked final component and refuses an inventory that group or
    others can rewrite between this read and the action it authorises. Callers that act on the
    fleet opt in; callers that only render generated artefacts keep the plain read.
    """
    if not hardened:
        return source.read_text(encoding="utf-8")
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o022:
            raise InventoryAccessError(
                f"{source} must be a regular file that neither group nor others can write"
            )
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, READ_CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_INVENTORY_BYTES:
                raise InventorySizeError(f"{source} exceeds the inventory size limit")
            chunks.append(chunk)
    finally:
        os.close(descriptor)
    return b"".join(chunks).decode("utf-8")


def read_alias_entry(
    source: pathlib.Path, alias: str, *, hardened: bool = False
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the raw ``aliases`` mapping of ``source`` plus the entry declared for ``alias``.

    Shape only: this is the reader for callers that derive their own policy from the inventory
    and cannot pay for the fleet-wide contract that ``load_container_aliases`` enforces.
    """
    document = json.loads(_read_source(source, hardened))
    if not isinstance(document, dict) or not isinstance(document.get("aliases"), dict):
        raise ContainerAliasError(f"{source} does not declare an aliases object")
    aliases: dict[str, Any] = document["aliases"]
    entry = aliases.get(alias)
    if not isinstance(entry, dict):
        raise AliasNotDeclaredError(f"{alias} is not declared in {source}")
    return aliases, entry


def _document(root: pathlib.Path, *, hardened: bool = False) -> dict[str, Any]:
    source = root / "container-aliases.json"
    document = _mapping(json.loads(_read_source(source, hardened)), str(source))
    if (
        set(document)
        != {"schemaVersion", "systemPrincipals", "historicalAliases", "aliases"}
        or document["schemaVersion"] != 2
    ):
        raise ContainerAliasError(
            "container alias mapping must use exact schemaVersion 2"
        )
    return document


def load_container_aliases(
    root: pathlib.Path, *, hardened: bool = False
) -> dict[str, dict[str, str]]:
    document = _document(root, hardened=hardened)
    aliases = _mapping(document["aliases"], "aliases")
    if not aliases:
        raise ContainerAliasError("container alias mapping must not be empty")
    validated: dict[str, dict[str, str]] = {}
    for alias in sorted(aliases):
        if not NAME_RE.fullmatch(alias):
            raise ContainerAliasError(f"invalid alias: {alias}")
        entry = _mapping(aliases[alias], alias)
        if set(entry) - set(ALIAS_REQUIRED_FIELDS) - set(ALIAS_OPTIONAL_FIELDS) or set(
            ALIAS_REQUIRED_FIELDS
        ) - set(entry):
            raise ContainerAliasError(
                f"{alias} must have required fields {ALIAS_REQUIRED_FIELDS} "
                f"and optional fields {ALIAS_OPTIONAL_FIELDS}"
            )
        if not isinstance(entry["tenant"], str) or not TENANT_RE.fullmatch(
            entry["tenant"]
        ):
            raise ContainerAliasError(f"{alias}.tenant is invalid")
        if not isinstance(entry["room"], str) or not ROOM_RE.fullmatch(entry["room"]):
            raise ContainerAliasError(f"{alias}.room is invalid")
        for field in ("container", "user", "systemdUser"):
            if not isinstance(entry[field], str) or not NAME_RE.fullmatch(entry[field]):
                raise ContainerAliasError(f"{alias}.{field} is invalid")
        for field in ("home", "stateDirectory"):
            _absolute_path(entry[field], f"{alias}.{field}")
        if entry["harness"] not in HARNESS:
            raise ContainerAliasError(f"{alias}.harness is invalid")
        if entry["membershipRole"] not in MEMBERSHIP_ROLES:
            raise ContainerAliasError(f"{alias}.membershipRole is invalid")
        registry_container = entry.get("registryContainer", entry["container"])
        if not isinstance(registry_container, str) or not PLACEMENT_RE.fullmatch(
            registry_container
        ):
            raise ContainerAliasError(f"{alias}.registryContainer is invalid")
        docker_host = entry.get("dockerHost", "local")
        if not isinstance(docker_host, str) or not NAME_RE.fullmatch(docker_host):
            raise ContainerAliasError(f"{alias}.dockerHost is invalid")
        workspace = entry.get("workspace")
        if entry["harness"] == "openclaw":
            _absolute_path(workspace, f"{alias}.workspace")
        elif workspace is not None:
            raise ContainerAliasError(f"{alias}.workspace is only valid for openclaw")
        # The persistent mount that backs the state directory is no longer pinned here:
        # every real container keeps the alias state inside a broad persistent bind, so the
        # supervisor discovers the containing bind/volume from `docker inspect` at runtime.
        validated[alias] = {
            **{field: str(entry[field]) for field in ALIAS_REQUIRED_FIELDS},
            "registryContainer": registry_container,
            "dockerHost": docker_host,
            **({"workspace": str(workspace)} if workspace is not None else {}),
        }
    return validated


def load_system_principals(root: pathlib.Path) -> dict[str, dict[str, str]]:
    document = _document(root)
    principals = _mapping(document["systemPrincipals"], "systemPrincipals")
    validated: dict[str, dict[str, str]] = {}
    for alias in sorted(principals):
        if not NAME_RE.fullmatch(alias):
            raise ContainerAliasError(f"invalid system principal: {alias}")
        entry = _mapping(principals[alias], f"systemPrincipals.{alias}")
        if set(entry) != set(PRINCIPAL_FIELDS):
            raise ContainerAliasError(
                f"system principal {alias} must have exact fields {PRINCIPAL_FIELDS}"
            )
        if not isinstance(entry["tenant"], str) or not TENANT_RE.fullmatch(
            entry["tenant"]
        ):
            raise ContainerAliasError(f"system principal {alias}.tenant is invalid")
        if not isinstance(entry["room"], str) or not ROOM_RE.fullmatch(entry["room"]):
            raise ContainerAliasError(f"system principal {alias}.room is invalid")
        if entry["membershipRole"] not in MEMBERSHIP_ROLES:
            raise ContainerAliasError(
                f"system principal {alias}.membershipRole is invalid"
            )
        validated[alias] = {field: str(entry[field]) for field in PRINCIPAL_FIELDS}
    overlap = set(validated) & set(load_container_aliases(root))
    if overlap:
        raise ContainerAliasError(
            f"system principals overlap fleet aliases: {sorted(overlap)}"
        )
    return validated


