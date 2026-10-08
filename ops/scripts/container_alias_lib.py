#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import re
import stat
from typing import Any

from fleet_derive import ROOM_PATTERN, RUNTIME_KEY_PATTERN
from fleet_runtime_inventory import inventory_root

FIELDS = ("tenant", "room", "container", "user", "home", "stateDirectory", "harness")
ALIAS_REQUIRED_FIELDS = (*FIELDS, "membershipRole", "systemdUser")
ALIAS_OPTIONAL_FIELDS = ("registryContainer", "workspace", "dockerHost", "alias", "bootstrap", "admission", "enabled")
PRINCIPAL_FIELDS = ("tenant", "room", "membershipRole")
NAME_RE = re.compile(r"^[a-z][a-z0-9.-]*$")
HOST_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_.-]{0,63}$")
WIRE_ALIAS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
PLACEMENT_RE = re.compile(r"^(?:[a-z][a-z0-9.-]*|host:[a-z][a-z0-9.-]*)$")
TENANT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ROOM_RE = ROOM_PATTERN
HARNESS = {"openclaw", "opencode", "claude", "hermes", "codex", "grok", "muse"}
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


def _role(value: Any, label: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 64 or value != value.strip() \
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ContainerAliasError(f"{label} is invalid")
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


def _document(root: pathlib.Path, *, hardened: bool = False, resolve_runtime: bool = True) -> dict[str, Any]:
    if resolve_runtime:
        root = inventory_root(root)
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
    root: pathlib.Path, *, hardened: bool = False, resolve_runtime: bool = True, allow_empty: bool = False,
    allow_bootstrap: bool = False,
) -> dict[str, dict[str, Any]]:
    document = _document(root, hardened=hardened, resolve_runtime=resolve_runtime)
    aliases = _mapping(document["aliases"], "aliases")
    if not aliases and not allow_empty:
        raise ContainerAliasError("container alias mapping must not be empty")
    validated: dict[str, dict[str, str]] = {}
    for alias in sorted(aliases):
        if not RUNTIME_KEY_PATTERN.fullmatch(alias):
            raise ContainerAliasError(f"invalid alias: {alias}")
        entry = _mapping(aliases[alias], alias)
        if {"bootstrap", "admission", "enabled"} & set(entry):
            if entry.get("bootstrap") is not True or entry.get("admission") is not False \
                    or entry.get("enabled") is not False or not allow_bootstrap:
                raise ContainerAliasError(f"{alias}: bootstrap aliases do not admit runtime launch")
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
        logical_alias = entry.get("alias", alias)
        if not isinstance(logical_alias, str) or WIRE_ALIAS_RE.fullmatch(logical_alias) is None:
            raise ContainerAliasError(f"{alias}.alias is invalid")
        for field, pattern in (("container", NAME_RE), ("user", USER_RE), ("systemdUser", USER_RE)):
            if not isinstance(entry[field], str) or not pattern.fullmatch(entry[field]):
                raise ContainerAliasError(f"{alias}.{field} is invalid")
        for field in ("home", "stateDirectory"):
            _absolute_path(entry[field], f"{alias}.{field}")
        if entry["harness"] not in HARNESS:
            raise ContainerAliasError(f"{alias}.harness is invalid")
        _role(entry["membershipRole"], f"{alias}.membershipRole")
        registry_container = entry.get("registryContainer", entry["container"])
        if not isinstance(registry_container, str) or not PLACEMENT_RE.fullmatch(
            registry_container
        ):
            raise ContainerAliasError(f"{alias}.registryContainer is invalid")
        docker_host = entry.get("dockerHost", "local")
        if not isinstance(docker_host, str) or not HOST_RE.fullmatch(docker_host):
            raise ContainerAliasError(f"{alias}.dockerHost is invalid")
        workspace = entry.get("workspace")
        if entry["harness"] == "openclaw" or (entry["harness"] == "muse" and workspace is not None):
            _absolute_path(workspace, f"{alias}.workspace")
        elif workspace is not None:
            raise ContainerAliasError(f"{alias}.workspace is only valid for openclaw or muse")
        validated[alias] = {
            **{field: str(entry[field]) for field in ALIAS_REQUIRED_FIELDS},
            "registryContainer": registry_container,
            "dockerHost": docker_host,
            **({"workspace": str(workspace)} if workspace is not None else {}),
            **({"alias": logical_alias} if logical_alias != alias else {}),
            **({"bootstrap": True, "admission": False, "enabled": False} if "bootstrap" in entry else {}),
        }
    return validated


def validate_principal_entry(key: str, raw_entry: Any) -> dict[str, Any]:
    if not isinstance(key, str) or not RUNTIME_KEY_PATTERN.fullmatch(key):
        raise ContainerAliasError(f"invalid system principal: {key}")
    label = f"systemPrincipals.{key}"
    entry = _mapping(raw_entry, label)
    required = {"tenant", "memberships"} if "memberships" in entry else set(PRINCIPAL_FIELDS)
    if set(entry) - required - {"alias"} or required - set(entry):
        raise ContainerAliasError(f"{label} has invalid identity or membership fields")
    if not isinstance(entry["tenant"], str) or not TENANT_RE.fullmatch(entry["tenant"]):
        raise ContainerAliasError(f"{label}.tenant is invalid")
    logical = entry.get("alias", key)
    if not isinstance(logical, str) or WIRE_ALIAS_RE.fullmatch(logical) is None:
        raise ContainerAliasError(f"{label}.alias is invalid")
    rows = entry.get("memberships", [{"room": entry.get("room"), "membershipRole": entry.get("membershipRole")}])
    if not isinstance(rows, list) or not rows:
        raise ContainerAliasError(f"{label}.memberships must be non-empty")
    rooms = set()
    for row in rows:
        member = _mapping(row, f"{label}.membership")
        if set(member) != {"room", "membershipRole"}:
            raise ContainerAliasError(f"{label}.membership has invalid fields")
        if not isinstance(member["room"], str) or not ROOM_RE.fullmatch(member["room"]) \
                or member["room"] in rooms:
            raise ContainerAliasError(f"{label}.membership.room is invalid or duplicated")
        rooms.add(member["room"])
        _role(member["membershipRole"], f"{label}.membershipRole")
    return dict(entry)


def load_system_principals(root: pathlib.Path) -> dict[str, dict[str, Any]]:
    document = _document(root)
    principals = _mapping(document["systemPrincipals"], "systemPrincipals")
    validated = {key: validate_principal_entry(key, principals[key]) for key in sorted(principals)}
    overlap = set(validated) & set(load_container_aliases(root))
    if overlap:
        raise ContainerAliasError(
            f"system principals overlap fleet aliases: {sorted(overlap)}"
        )
    return validated
