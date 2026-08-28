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

from collections.abc import Mapping
from typing import Any

SYSTEMD_USER = "stev"
HOST_STATE_DIRECTORY = "/var/lib/cauce-v3/aliases/{alias}"

_LOCAL_RUNTIME_STATE_DIRECTORY = "{home}/.local/state/cauce-v3/{alias}"
_OPENCLAW_RUNTIME_STATE_DIRECTORY = "{home}/.openclaw/cauce-v3/{alias}"

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


def runtime_state_directory(alias: str, row: Mapping[str, Any]) -> str:
    """Derive the adapter state path in its container or host namespace."""
    rule = _harness_rule(row)
    branch = "host" if row["container"].startswith("host:") else "container"
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
    rule = _harness_rule(row)
    entry: dict[str, Any] = {
        "tenant": row["tenant"],
        "room": row["room"],
        "container": placement.get("healthContainer", row["container"]),
    }
    for key in ("registryContainer", "dockerHost"):
        if key in placement:
            entry[key] = placement[key]
    entry.update({
        "systemdUser": SYSTEMD_USER,
        "user": row["user"],
        "home": row["home"],
    })
    workspace = rule.get("workspace")
    if workspace is not None:
        entry["workspace"] = _render(workspace, alias, row)
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
    workspace = rule.get("workspace")
    if workspace is not None:
        profile["workspace"] = _render(workspace, alias, row)

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
