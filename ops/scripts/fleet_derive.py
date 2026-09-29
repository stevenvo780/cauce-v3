"""Pure derivations shared by the fleet artifact generators.

``runtimeStateDirectory`` in the snapshot, exposed as ``stateDirectory`` in
the container alias mapping, is the adapter's runtime path. It normally lives
inside a container, while host-backed aliases use the host branch selected by
``runtime_state_directory()``. Manifest ``stateDirectory`` and systemd's
resolved ``StateDirectory=`` are host-side and always use
``HOST_STATE_DIRECTORY``. The wire keys stay unchanged despite representing
these two namespaces.
"""

from __future__ import annotations

import json
import pathlib
from collections.abc import Mapping
from typing import Any

SYSTEMD_USER = "stev"
HOST_STATE_DIRECTORY = "/var/lib/cauce-v3/aliases/{alias}"

_LOCAL_RUNTIME_STATE_DIRECTORY = "{home}/.local/state/cauce-v3/{alias}"
_OPENCLAW_RUNTIME_STATE_DIRECTORY = "{home}/.openclaw/cauce-v3/{alias}"
_MUSE_RUNTIME_STATE_DIRECTORY = "{home}/.muse/cauce-v3/{alias}"

HARNESS_RULES: dict[str, dict[str, Any]] = {
    "claude": {
        "stateDirectory": {
            "container": _LOCAL_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
    },
    "codex": {
        "stateDirectory": {
            "container": _LOCAL_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
    },
    "hermes": {
        "stateDirectory": {
            "container": _LOCAL_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
        "operationalModelEnv": "HERMES_INFERENCE_MODEL",
    },
    "openclaw": {
        "stateDirectory": {
            "container": _OPENCLAW_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
        "workspace": "{home}/clawd",
    },
    "opencode": {
        "stateDirectory": {
            "container": _LOCAL_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
    },
    # Headless single-turn CLI like opencode: no bridge, no workspace key, no model env.
    "grok": {
        "stateDirectory": {
            "container": _LOCAL_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
    },
    # muse (hegel) va por el puente muse-cauce: mismo estado local que grok. Una instancia aislada
    # lo corre como agente de workspace: su fila declara el estado en ~/.muse y eso activa el workspace.
    "muse": {
        "stateDirectory": {
            "container": _LOCAL_RUNTIME_STATE_DIRECTORY,
            "host": HOST_STATE_DIRECTORY,
        },
        "workspaceWhenState": {
            "stateDirectory": _MUSE_RUNTIME_STATE_DIRECTORY,
            "workspace": "{home}/clawd",
        },
    },
}

_ENV_KINDS = frozenset({
    "TOKEN_PATH",
    "CERT_PATH",
    "KEY_PATH",
    "CA_PATH",
    "RELAY_URL",
    "EXEC_PATH",
})


def _harness_rule(row: Mapping[str, Any]) -> dict[str, Any]:
    harness = row["harness"]
    try:
        return HARNESS_RULES[harness]
    except (KeyError, TypeError) as error:
        raise ValueError(f"unsupported harness: {harness!r}") from error


def _render(template: str, alias: str, row: Mapping[str, Any]) -> str:
    return template.format(alias=alias, home=row["home"])


def harness_workspace(alias: str, row: Mapping[str, Any]) -> str | None:
    """Derive the durable workspace a harness promises, or None when it has none."""
    rule = _harness_rule(row)
    template = rule.get("workspace")
    conditional = rule.get("workspaceWhenState")
    if template is None and conditional is not None \
            and row.get("runtimeStateDirectory") == _render(conditional["stateDirectory"], alias, row):
        template = conditional["workspace"]
    return None if template is None else _render(template, alias, row)


def runtime_state_directory(alias: str, row: Mapping[str, Any]) -> str:
    """Derive the adapter state path in its container or host namespace."""
    rule = _harness_rule(row)
    branch = "host" if row["container"].startswith(("host:", "vm:")) else "container"
    template = rule["stateDirectory"][branch]
    return _render(template, alias, row)


def env_name(alias: str, kind: str) -> str:
    """Return an exact alias-scoped environment placeholder name."""
    if kind not in _ENV_KINDS:
        raise ValueError(f"unsupported environment kind: {kind!r}")
    normalized_alias = alias.upper().replace("-", "_")
    return f"CAUCE_{normalized_alias}_{kind}"


def alias_entry(
    alias: str,
    row: Mapping[str, Any],
    placement: Mapping[str, Any],
) -> dict[str, Any]:
    """Project one snapshot row and its physical overlay into schema v2."""
    entry: dict[str, Any] = {
        "tenant": row["tenant"],
        "room": row["room"],
        "container": row["container"] if row["container"].startswith(("host:", "vm:"))
        else placement.get("healthContainer", row["container"]),
    }
    for key in ("registryContainer", "dockerHost"):
        if key in placement:
            entry[key] = placement[key]
    entry.update({
        "systemdUser": placement.get("systemdUser", SYSTEMD_USER),
        "user": row["user"],
        "home": row["home"],
    })
    workspace = harness_workspace(alias, row)
    if workspace is not None:
        entry["workspace"] = workspace
    entry.update({
        "stateDirectory": row["runtimeStateDirectory"],
        "harness": row["harness"],
        "membershipRole": row["role"],
    })
    return entry


def manifest_doc(alias: str, row: Mapping[str, Any]) -> dict[str, Any]:
    """Derive one AliasRuntime manifest document from a snapshot row."""
    rule = _harness_rule(row)
    profile: dict[str, Any] = {
        "seedOnConnect": True,
        "configScope": "alias",
    }
    workspace = harness_workspace(alias, row)
    if workspace is not None:
        profile["workspace"] = workspace

    process = {"executablePathEnv": env_name(alias, "EXEC_PATH")}
    operational_model_env = rule.get("operationalModelEnv")
    if operational_model_env is not None:
        process["operationalModelEnv"] = operational_model_env

    return {
        "apiVersion": "cauce.io/v3",
        "kind": "AliasRuntime",
        "metadata": {"name": alias},
        "spec": {
            "tenant": row["tenant"],
            "room": row["room"],
            "alias": alias,
            "harness": row["harness"],
            "profile": profile,
            "origin": {"transport": "telegram"},
            "relay": {
                "urlPathEnv": env_name(alias, "RELAY_URL"),
                "requiredScheme": "wss",
            },
            "secretPathEnv": {
                "token": env_name(alias, "TOKEN_PATH"),
                "clientCertificate": env_name(alias, "CERT_PATH"),
                "clientKey": env_name(alias, "KEY_PATH"),
                "certificateAuthority": env_name(alias, "CA_PATH"),
            },
            "process": process,
            "stateDirectory": HOST_STATE_DIRECTORY.format(alias=alias),
        },
    }


def load_fleet_assignments(root: pathlib.Path) -> dict[str, dict[str, Any]]:
    """Read all declared agents, including native hosts, from the canonical snapshot."""
    from container_alias_lib import HARNESS, NAME_RE, ROOM_RE, TENANT_RE

    document = json.loads((root / "flota.json").read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("schemaVersion") != 1:
        raise ValueError("fleet snapshot must use schemaVersion 1")
    fleet = document.get("fleet")
    if not isinstance(fleet, dict) or not fleet:
        raise ValueError("fleet snapshot must contain enabled agents")
    placement = document.get("placement", {})
    if not isinstance(placement, dict):
        raise ValueError("fleet placement must be an object")
    assignments = {}
    for alias, row in sorted(fleet.items()):
        if not isinstance(alias, str) or NAME_RE.fullmatch(alias) is None:
            raise ValueError("fleet snapshot contains an invalid alias")
        if not isinstance(row, dict) or row.get("enabled") is not True:
            raise ValueError(f"fleet.{alias} is not an enabled agent")
        for field, pattern in (("tenant", TENANT_RE), ("room", ROOM_RE)):
            if not isinstance(row.get(field), str) or pattern.fullmatch(row[field]) is None:
                raise ValueError(f"fleet.{alias}.{field} is invalid")
        if row.get("harness") not in HARNESS:
            raise ValueError(f"fleet.{alias}.harness is invalid")
        overlay = placement.get(alias, {})
        if not isinstance(overlay, dict):
            raise ValueError(f"placement.{alias} must be an object")
        assignments[alias] = alias_entry(alias, row, overlay)
    return assignments
