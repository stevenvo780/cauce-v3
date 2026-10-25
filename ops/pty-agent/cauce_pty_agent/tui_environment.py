from __future__ import annotations

import os
import re
from typing import Any

PATH_KEYS = frozenset({
    "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_AGENT_DIR",
    "CAUCE_OPENCLAW_DIST_DIR", "CAUCE_HARNESS_COMMAND", "TMPDIR", "NODE_COMPILE_CACHE",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR",
})
PRIVATE_KEYS = frozenset({"OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"})
LOCAL_KEYS = frozenset({"CAUCE_OPENCLAW_LOCAL", "CAUCE_OPENCLAW_AGENT_ID"})
LOCAL_PATH_KEYS = frozenset({
    "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_AGENT_DIR",
    "TMPDIR", "NODE_COMPILE_CACHE", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
})
IDENTITY_KEYS = frozenset({
    "HOME", "CAUCE_ALIAS", "CAUCE_RUNTIME_KEY", "CAUCE_TENANT_ID", "CAUCE_TENANT",
    "CAUCE_STATE_DIR", "CAUCE_CONTAINER_ID", "CAUCE_CONTAINER_GENERATION",
})


def _matching_environments(bundle: dict[str, Any]) -> list[dict[str, str]]:
    recovery = bundle.get("session_recovery")
    if not isinstance(recovery, dict) or not re.fullmatch(
            r"[a-f0-9]{64}", recovery.get("adapter_generation", "")):
        return []
    matches = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != os.geteuid():
                continue
            with open(f"/proc/{pid}/environ", "rb") as stream:
                raw = stream.read(262145)
            if len(raw) > 262144:
                continue
            environment = {}
            for item in raw.split(b"\0"):
                key, separator, value = item.partition(b"=")
                name = key.decode("utf-8", "strict")
                if separator and name in PATH_KEYS | PRIVATE_KEYS | IDENTITY_KEYS | LOCAL_KEYS:
                    environment[name] = value.decode("utf-8", "strict")
            # CAUCE_ALIAS is the wire alias the PTY bundle names. CAUCE_RUNTIME_KEY is a
            # distinct physical key on V4 and is only the fallback when the wire alias is absent.
            wire = environment.get("CAUCE_ALIAS")
            identity = wire if wire else environment.get("CAUCE_RUNTIME_KEY")
            if (identity != bundle["alias"]
                    or environment.get("HOME") != bundle["home"]
                    or environment.get("CAUCE_STATE_DIR") != recovery.get("state_directory")
                    or environment.get("CAUCE_CONTAINER_ID") != bundle["container_id"]
                    or environment.get("CAUCE_CONTAINER_GENERATION") != recovery["adapter_generation"]
                    or bundle.get("tenant_id") is not None and environment.get(
                        "CAUCE_TENANT_ID", environment.get("CAUCE_TENANT")) != bundle["tenant_id"]):
                continue
            matches.append(environment)
        except (OSError, UnicodeError, ValueError):
            continue
    return matches


def openclaw_local(bundle: dict[str, Any]) -> bool:
    candidates = _matching_environments(bundle)
    return bool(candidates) and all(environment.get("CAUCE_OPENCLAW_LOCAL") == "1" for environment in candidates)


def openclaw_session_key(bundle: dict[str, Any], native_id: str) -> str | None:
    if not openclaw_local(bundle):
        return native_id
    candidates = {environment.get("CAUCE_OPENCLAW_AGENT_ID", "")
                  for environment in _matching_environments(bundle)}
    if len(candidates) != 1:
        return None
    agent_id = candidates.pop()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", agent_id):
        return None
    if native_id.startswith("agent:"):
        return native_id if native_id.startswith(f"agent:{agent_id}:") else None
    return f"agent:{agent_id}:{native_id}"


def measured_environment(bundle: dict[str, Any]) -> dict[str, str]:
    if bundle.get("harness") != "openclaw":
        return {}
    environments = _matching_environments(bundle)
    candidates = [{key: value for key, value in environment.items() if key in PATH_KEYS}
                  for environment in environments]
    if not candidates or any(candidate != candidates[0] for candidate in candidates):
        return {}
    result = candidates[0]
    if any(environment.get("CAUCE_OPENCLAW_LOCAL") == "1" for environment in environments):
        local = {(environment.get("CAUCE_OPENCLAW_LOCAL"), environment.get("CAUCE_OPENCLAW_AGENT_ID"))
                 for environment in environments}
        if (len(local) != 1 or not LOCAL_PATH_KEYS.issubset(result)
                or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", next(iter(local))[1] or "")):
            return {}
    for key, path in result.items():
        if (not path.startswith("/") or path == "/" or os.path.normpath(path) != path
                or any(ord(character) < 32 for character in path)):
            return {}
        if key.startswith("OPENCLAW_") or key in {"TMPDIR", "NODE_COMPILE_CACHE", "CODEX_HOME", "CLAUDE_CONFIG_DIR"}:
            if os.path.commonpath((bundle["home"], path)) != os.path.normpath(bundle["home"]):
                return {}
    return result


def openclaw_environment(bundle: dict[str, Any]) -> dict[str, str]:
    paths = measured_environment(bundle)
    if openclaw_local(bundle):
        return paths
    candidates = [{key: value for key, value in environment.items() if key in PRIVATE_KEYS}
                  for environment in _matching_environments(bundle)]
    private = candidates[0] if candidates and all(value == candidates[0] for value in candidates) else {}
    return {**paths, **private}
