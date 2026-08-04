#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import re
from typing import Any

import yaml
from jsonschema import Draft202012Validator

EXPECTED = {
    "argos": ("Steven", "grp.steven", "hermes"),
    "atlas": ("Miguel", "grp.miguel", "codex"),
    "dedalo": ("Pablo", "grp.pablo", "codex"),
    "hegel": ("Jhon", "grp.jhon", "openclaw"),
    "heraclito": ("Jhon", "grp.jhon", "openclaw"),
    "iza": ("Miguel", "grp.miguel", "hermes"),
    "janus": ("Miguel", "grp.miguel", "openclaw"),
    "jarvis": ("Steven", "grp.steven", "openclaw"),
    "kant": ("Steven", "grp.steven", "codex"),
    "kratos": ("Miguel", "grp.miguel", "codex"),
    "midas": ("Pablo", "grp.pablo", "openclaw"),
    "salva": ("Isa", "grp.isa", "codex"),
    "seneca": ("Pablo", "grp.pablo", "openclaw"),
    "socrates": ("Steven", "grp.steven", "codex"),
    "vulcano": ("Pablo", "grp.pablo", "claude"),
}
ENV_RE = re.compile(r"^CAUCE_[A-Z0-9_]+_(?:PATH|URL)$")
ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]*$")
TOP_KEYS = {"apiVersion", "kind", "metadata", "spec"}
SPEC_KEYS = {"tenant", "room", "alias", "harness", "origin", "relay", "secretPathEnv", "process", "stateDirectory"}
SECRET_KEYS = {"token", "clientCertificate", "clientKey", "certificateAuthority"}


class ManifestError(ValueError):
    pass


def require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{label} must be a mapping")
    return value


def exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise ManifestError(f"{label} keys differ: missing={sorted(expected-actual)} extra={sorted(actual-expected)}")


def env_name(value: Any, expected: str, label: str) -> None:
    if not isinstance(value, str) or not ENV_RE.fullmatch(value) or value != expected:
        raise ManifestError(f"{label} must be the exact PATH/URL placeholder {expected}")


def validate_manifest(data: Any, source: pathlib.Path) -> dict[str, Any]:
    root = require_mapping(data, str(source))
    exact_keys(root, TOP_KEYS, str(source))
    if root["apiVersion"] != "cauce.io/v3" or root["kind"] != "AliasRuntime":
        raise ManifestError(f"{source}: unsupported apiVersion/kind")
    metadata = require_mapping(root["metadata"], f"{source}.metadata")
    exact_keys(metadata, {"name"}, f"{source}.metadata")
    spec = require_mapping(root["spec"], f"{source}.spec")
    exact_keys(spec, SPEC_KEYS, f"{source}.spec")
    alias = spec["alias"]
    if not isinstance(alias, str) or not ALIAS_RE.fullmatch(alias):
        raise ManifestError(f"{source}: invalid alias")
    if metadata["name"] != alias or source.stem != alias:
        raise ManifestError(f"{source}: filename, metadata.name and spec.alias must match")
    if alias not in EXPECTED:
        raise ManifestError(f"{source}: alias is not in the 14-member fleet")
    tenant, room, harness = EXPECTED[alias]
    if (spec["tenant"], spec["room"], spec["harness"]) != (tenant, room, harness):
        raise ManifestError(f"{source}: tenant/room/harness differs from the fleet assignment")
    origin = require_mapping(spec["origin"], f"{source}.spec.origin")
    exact_keys(origin, {"transport"}, f"{source}.spec.origin")
    if origin["transport"] != "telegram":
        raise ManifestError(f"{source}: origin transport must be telegram")
    relay = require_mapping(spec["relay"], f"{source}.spec.relay")
    exact_keys(relay, {"urlPathEnv", "requiredScheme"}, f"{source}.spec.relay")
    if relay["requiredScheme"] != "wss":
        raise ManifestError(f"{source}: adapters must require wss")
    prefix = f"CAUCE_{alias.upper().replace('-', '_')}"
    env_name(relay["urlPathEnv"], f"{prefix}_RELAY_URL", f"{source}.spec.relay.urlPathEnv")
    secrets = require_mapping(spec["secretPathEnv"], f"{source}.spec.secretPathEnv")
    exact_keys(secrets, SECRET_KEYS, f"{source}.spec.secretPathEnv")
    env_name(secrets["token"], f"{prefix}_TOKEN_PATH", f"{source}.token")
    env_name(secrets["clientCertificate"], f"{prefix}_CERT_PATH", f"{source}.clientCertificate")
    env_name(secrets["clientKey"], f"{prefix}_KEY_PATH", f"{source}.clientKey")
    env_name(secrets["certificateAuthority"], f"{prefix}_CA_PATH", f"{source}.certificateAuthority")
    process = require_mapping(spec["process"], f"{source}.spec.process")
    process_keys = {"executablePathEnv", "operationalModelEnv"} if harness == "hermes" else {"executablePathEnv"}
    exact_keys(process, process_keys, f"{source}.spec.process")
    env_name(process["executablePathEnv"], f"{prefix}_EXEC_PATH", f"{source}.executablePathEnv")
    if harness == "hermes" and process["operationalModelEnv"] != "HERMES_INFERENCE_MODEL":
        raise ManifestError(f"{source}: Hermes operationalModelEnv must be HERMES_INFERENCE_MODEL")
    if spec["stateDirectory"] != f"/var/lib/cauce-v3/aliases/{alias}":
        raise ManifestError(f"{source}: stateDirectory must be alias-scoped")
    return root


def load_manifests(root: pathlib.Path) -> list[dict[str, Any]]:
    schema = root / "schemas" / "alias-manifest.schema.json"
    with schema.open(encoding="utf-8") as stream:
        schema_document = json.load(stream)
    validator = Draft202012Validator(schema_document)
    paths = sorted((root / "manifests").glob("*.yaml"))
    if {path.stem for path in paths} != set(EXPECTED):
        missing = sorted(set(EXPECTED) - {path.stem for path in paths})
        extra = sorted({path.stem for path in paths} - set(EXPECTED))
        raise ManifestError(f"fleet manifests must be exact: missing={missing} extra={extra}")
    manifests = []
    for path in paths:
        with path.open(encoding="utf-8") as stream:
            document = yaml.safe_load(stream)
        errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
        if errors:
            raise ManifestError(f"{path}: JSON Schema: {errors[0].message}")
        manifests.append(validate_manifest(document, path))
    return manifests
