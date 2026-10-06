from __future__ import annotations

import ipaddress
import json
import os
import pathlib
import re
from urllib.parse import urlsplit

import jsonschema

SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "schemas/instance-descriptor.schema.json"
IDENTITY = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ALIAS = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class InstanceError(ValueError):
    pass


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def overlaps(first, second):
    a, b = pathlib.Path(first), pathlib.Path(second)
    return a == b or a in b.parents or b in a.parents


def safe_path(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or str(path) != value or ".." in path.parts:
        raise InstanceError("path must be canonical and absolute")
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink():
            raise InstanceError(f"symlink is forbidden: {ancestor}")
    for forbidden in ("/etc", "/opt", "/proc", "/sys", "/dev"):
        if overlaps(value, forbidden):
            raise InstanceError(f"protected path: {value}")
    return path


def mutable_roots(document):
    return [document["inventoryRoot"], *document["paths"].values(),
            *dict.fromkeys(entry["workspace"] for entry in document.get("integrations", {}).values() if "workspace" in entry)]


def validate_descriptor(document):
    try:
        jsonschema.Draft202012Validator(json.loads(SCHEMA.read_text())).validate(document)
    except jsonschema.ValidationError as exc:
        raise InstanceError(f"descriptor schema: {exc.json_path}: {exc.message}") from exc
    if type(document["schemaVersion"]) is not int:
        raise InstanceError("schemaVersion must be integer")
    roots = mutable_roots(document)
    for root in [document["codeRoot"], *roots]:
        path = safe_path(root)
        if path.exists() and not path.is_dir():
            raise InstanceError(f"root is not a directory: {root}")
        if root != document["codeRoot"] and path.exists() and path.stat().st_uid != os.getuid():
            raise InstanceError(f"root owner differs: {root}")
    for index, root in enumerate(roots):
        if overlaps(root, document["codeRoot"]):
            raise InstanceError("mutable root overlaps codeRoot")
        for other in roots[index + 1:]:
            if overlaps(root, other):
                raise InstanceError("mutable roots overlap")
    code = pathlib.Path(document["codeRoot"])
    if not (code / "deploy/compose.yaml").is_file():
        raise InstanceError("codeRoot has no canonical Compose")
    endpoints = document["endpoints"]
    try:
        ipaddress.ip_address(endpoints["bindIp"])
    except ValueError as exc:
        raise InstanceError("bindIp must be a literal IP") from exc
    ports = [endpoints[k] for k in ("gatewayPort", "consolePort", "relayPort")]
    if len(ports) != len(set(ports)):
        raise InstanceError("instance ports collide")
    for origin in endpoints["origins"]:
        url = urlsplit(origin)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.path:
            raise InstanceError("console origin must be exact HTTPS authority")
        try:
            _ = url.port
        except ValueError as exc:
            raise InstanceError("invalid origin port") from exc
    refs = document["identityRefs"]
    for value in [refs["bootstrap"], *refs["secretFiles"].values()]:
        safe_path(value)
        if not any(pathlib.Path(root) in pathlib.Path(value).parents for root in
                   (document["paths"]["config"], document["paths"]["pki"])):
            raise InstanceError("identity reference escapes own config/PKI")
    if "snapshot" in refs and refs["snapshot"] != str(pathlib.Path(document["inventoryRoot"]) / "ops/flota.json"):
        raise InstanceError("snapshot must be the derived inventoryRoot/ops/flota.json")
    for integration in document.get("integrations", {}).values():
        safe_path(integration["config"])
        if pathlib.Path(document["paths"]["config"]) not in pathlib.Path(integration["config"]).parents:
            raise InstanceError("integration config escapes config root")
        if "workspace" in integration:
            safe_path(integration["workspace"])
    return document


def load_instance_descriptor(path):
    return validate_descriptor(json.loads(pathlib.Path(path).read_text()))


def validate_bootstrap(document):
    required = {"schemaVersion", "tenants", "rooms", "memberships", "agents", "aclEdges"}
    if not isinstance(document, dict) or set(document) != required or type(document["schemaVersion"]) is not int or document["schemaVersion"] != 1:
        raise InstanceError("bootstrap must contain version 1 identities and permissions only")
    specs = {
        "tenants": ({"id"}, {"id", "display_name", "is_hub"}),
        "rooms": ({"id", "tenant_id"}, {"id", "tenant_id", "display_name"}),
        "memberships": ({"tenant_id", "room_id", "alias", "role"}, {"tenant_id", "room_id", "alias", "role"}),
        "agents": ({"tenant_id", "alias", "harness_id", "enabled", "container_name", "runtime_user", "home_directory", "state_directory"},
                   {"tenant_id", "alias", "harness_id", "enabled", "container_name", "runtime_user", "home_directory", "state_directory"}),
        "aclEdges": ({"from_tenant", "to_tenant", "allow_route", "allow_read", "allow_control"},
                     {"from_tenant", "to_tenant", "allow_route", "allow_read", "allow_control"}),
    }
    for table, (required_fields, allowed) in specs.items():
        rows = document[table]
        if not isinstance(rows, list):
            raise InstanceError(f"{table} must be an array")
        for row in rows:
            if not isinstance(row, dict) or not required_fields <= set(row) <= allowed:
                raise InstanceError(f"invalid {table} row")
            for key, value in row.items():
                if key in {"enabled", "is_hub", "allow_route", "allow_read", "allow_control"}:
                    if type(value) is not bool:
                        raise InstanceError(f"{key} must be boolean")
                elif key in {"alias", "runtime_user", "harness_id"}:
                    if not isinstance(value, str) or not ALIAS.fullmatch(value):
                        raise InstanceError(f"invalid {key}")
                elif key == "room_id" or (key == "id" and table == "rooms"):
                    if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(ord(c) < 32 or ord(c) == 127 for c in value):
                        raise InstanceError(f"invalid {key}")
                elif key in {"id", "tenant_id", "from_tenant", "to_tenant"}:
                    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
                        raise InstanceError(f"invalid {key}")
                elif key == "container_name":
                    if not isinstance(value, str) or re.fullmatch(r"(?:(?:host|vm):)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is None:
                        raise InstanceError("invalid container name")
                elif key.endswith("_directory"):
                    safe_path(value)
                elif not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
                    raise InstanceError(f"invalid {key}")
    tenants = [row["id"] for row in document["tenants"]]
    rooms = [(row["tenant_id"], row["id"]) for row in document["rooms"]]
    memberships = [(r["tenant_id"], r["room_id"], r["alias"]) for r in document["memberships"]]
    aliases = [row["alias"] for row in document["agents"]]
    if not tenants or len(tenants) != len(set(tenants)) or len(rooms) != len(set(rooms)) or len(memberships) != len(set(memberships)) or len(aliases) != len(set(aliases)):
        raise InstanceError("duplicate or missing bootstrap identity")
    if sum(row.get("is_hub", False) for row in document["tenants"]) > 1:
        raise InstanceError("multiple tenant hubs")
    for tenant, _room in rooms:
        if tenant not in tenants:
            raise InstanceError("room tenant is absent")
    principal_aliases = [r["alias"] for r in document["memberships"]]
    if len(principal_aliases) != len(set(principal_aliases)):
        raise InstanceError("alias must be unique in the full instance snapshot")
    for tenant, room, _ in memberships:
        if (tenant, room) not in rooms:
            raise InstanceError("membership room/tenant is absent")
    for agent in document["agents"]:
        if sum(r["tenant_id"] == agent["tenant_id"] and r["alias"] == agent["alias"] for r in document["memberships"]) != 1:
            raise InstanceError("agent needs one own tenant membership")
    for edge in document["aclEdges"]:
        if edge["from_tenant"] not in tenants or edge["to_tenant"] not in tenants or edge["from_tenant"] == edge["to_tenant"]:
            raise InstanceError("invalid ACL tenant membership")
    return document
