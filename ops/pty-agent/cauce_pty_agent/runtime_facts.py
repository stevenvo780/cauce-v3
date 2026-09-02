from __future__ import annotations

import json
import os
import stat
from typing import Any

from .framing import IDENTITY_RE, PermanentError
from .governance_paths import (
    MAX_READ_PATH,
    PROJECT_DOC_FALLBACK_LIMIT,
    PROJECT_DOC_MAX_BYTES_LIMIT,
    _valid_project_doc_fallback,
)
from .tmux import _openclaw_tui_config, _tmux_tui_config

BUNDLE_KEYS = (
    "tenant_id", "alias", "container_id", "generation", "image_id", "runtime_user", "runtime_uid",
    "runtime_gid", "home", "shell_candidates", "harness", "relay_host", "relay_port",
    "alias_key_hex", "client_cert_pem", "client_key_pem", "ca_pem", "agent_version",
)
RUNTIME_FACT_KEYS = frozenset((
    "codex_home", "claude_config_dir", "openclaw_workspace", "cwd", "workspace_root",
    "project_root", "project_doc_max_bytes", "project_doc_fallback_filenames",
))
RUNTIME_PATH_FACT_KEYS = frozenset((
    "codex_home", "claude_config_dir", "openclaw_workspace", "cwd", "workspace_root",
    "project_root",
))


# ---------------------------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------------------------


def load_bundle(path: str) -> dict[str, Any]:
    """Reads the launcher's drop file and unlinks it immediately: the alias key and the channel
    key must not survive one read, so a later exec inside the container finds nothing."""
    if not path.startswith("/"):
        raise PermanentError("bundle path must be absolute")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode):
            raise PermanentError("bundle must be a regular file")
        if status.st_uid != os.geteuid():
            raise PermanentError("bundle must be owned by the runtime user")
        if status.st_mode & 0o077:
            raise PermanentError("bundle must not be group or world readable")
        raw = os.read(descriptor, 1 << 20)
    finally:
        os.close(descriptor)
    try:
        os.unlink(path)
    except OSError as error:
        raise PermanentError(f"bundle could not be unlinked: {error.strerror}") from None
    try:
        document = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise PermanentError("bundle is not valid JSON") from None
    if not isinstance(document, dict):
        raise PermanentError("bundle must be an object")
    missing = [key for key in BUNDLE_KEYS if key not in document]
    if missing:
        raise PermanentError(f"bundle is missing keys: {' '.join(sorted(missing))}")
    return validate_bundle(document)


def validate_bundle(document: dict[str, Any]) -> dict[str, Any]:
    for key in ("tenant_id", "alias", "container_id", "generation", "runtime_user", "harness", "agent_version"):
        value = document.get(key)
        if not isinstance(value, str) or not IDENTITY_RE.fullmatch(value):
            raise PermanentError(f"bundle field is invalid: {key}")
    for key in ("runtime_uid", "runtime_gid", "relay_port"):
        value = document.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise PermanentError(f"bundle field is invalid: {key}")
    if document["runtime_uid"] == 0 or document["runtime_gid"] == 0:
        raise PermanentError("bundle declares a root runtime identity")
    if not 1 <= document["relay_port"] <= 65535:
        raise PermanentError("bundle field is invalid: relay_port")
    if not isinstance(document.get("home"), str) or not document["home"].startswith("/"):
        raise PermanentError("bundle field is invalid: home")
    if not isinstance(document.get("relay_host"), str) or not document["relay_host"]:
        raise PermanentError("bundle field is invalid: relay_host")
    try:
        key_material = bytes.fromhex(document.get("alias_key_hex", ""))
    except (TypeError, ValueError):
        raise PermanentError("bundle field is invalid: alias_key_hex") from None
    if len(key_material) != 32:
        raise PermanentError("bundle field is invalid: alias_key_hex")
    document["shell_candidates"] = _command_list(document.get("shell_candidates"), "shell_candidates")
    if document.get("harness_command") not in (None, "", []):
        document["harness_command"] = _command(document["harness_command"], "harness_command")
    else:
        document["harness_command"] = None
    document["openclaw_tui"] = _openclaw_tui_config(
        document.get("openclaw_tui"), document["harness"], document["home"]
    )
    document["tmux_tui"] = _tmux_tui_config(
        document.get("tmux_tui"), document["harness"], document["alias"]
    )
    document["runtime_facts"] = _runtime_facts_config(
        document.get("runtime_facts", {}), document["harness"], document["home"]
    )
    harness_resolvers = (
        document["harness_command"], document["openclaw_tui"], document["tmux_tui"],
    )
    if sum(value is not None for value in harness_resolvers) > 1:
        raise PermanentError("bundle defines multiple harness resolvers")
    for key in ("client_cert_pem", "client_key_pem", "ca_pem"):
        if not isinstance(document.get(key), str) or "-----BEGIN" not in document[key]:
            raise PermanentError(f"bundle field is invalid: {key}")
    return document


def _runtime_facts_config(value: Any, harness: str, home: str) -> dict[str, Any]:
    """Validate measured non-secret runtime facts."""
    if not isinstance(value, dict) or not set(value).issubset(RUNTIME_FACT_KEYS):
        return {}
    expected = {
        "codex": "codex_home",
        "claude": "claude_config_dir",
        "openclaw": "openclaw_workspace",
    }.get(harness)
    profile_keys = {"codex_home", "claude_config_dir", "openclaw_workspace"}
    if any(key in profile_keys and key != expected for key in value):
        return {}
    validated: dict[str, Any] = {}
    normalized_home = os.path.normpath(home)
    for key in RUNTIME_PATH_FACT_KEYS.intersection(value):
        path = value[key]
        if (not isinstance(path, str) or not path.startswith("/") or path == "/"
                or len(path) > MAX_READ_PATH or "\0" in path or os.path.normpath(path) != path):
            return {}
        try:
            details = os.lstat(path)
        except (OSError, ValueError):
            return {}
        if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode) \
                or os.path.realpath(path) != path:
            return {}
        if key in profile_keys:
            try:
                contained = os.path.commonpath((normalized_home, path)) == normalized_home
            except ValueError:
                contained = False
            if not contained or details.st_uid != os.geteuid():
                return {}
        validated[key] = path
    workspace_root = validated.get("workspace_root")
    cwd = validated.get("cwd")
    if workspace_root is not None and cwd is None:
        for key in ("cwd", "workspace_root", "project_root"):
            validated.pop(key, None)
    elif workspace_root is not None and cwd is not None:
        try:
            contains_cwd = os.path.commonpath((workspace_root, cwd)) == workspace_root
        except ValueError:
            contains_cwd = False
        if not contains_cwd:
            for key in ("cwd", "workspace_root", "project_root"):
                validated.pop(key, None)
    project_root = validated.get("project_root")
    if project_root is not None and cwd is None:
        for key in ("cwd", "workspace_root", "project_root"):
            validated.pop(key, None)
    elif project_root is not None and cwd is not None:
        try:
            contains_cwd = os.path.commonpath((project_root, cwd)) == project_root
            inside_workspace = workspace_root is None \
                or os.path.commonpath((workspace_root, project_root)) == workspace_root
        except ValueError:
            contains_cwd = False
            inside_workspace = False
        if not contains_cwd or not inside_workspace:
            for key in ("cwd", "workspace_root", "project_root"):
                validated.pop(key, None)

    # Codex exposes exactly this pair from config.toml. It is optional and all-or-nothing: an old
    # agent, a partial rollout, a malformed type or one secret-looking fallback simply omits the
    # pair while preserving independently valid path facts and terminal identity.
    maximum_present = "project_doc_max_bytes" in value
    fallbacks_present = "project_doc_fallback_filenames" in value
    maximum = value.get("project_doc_max_bytes")
    fallbacks = value.get("project_doc_fallback_filenames")
    if harness == "codex" and maximum_present and fallbacks_present \
            and isinstance(maximum, int) and not isinstance(maximum, bool) \
            and 1 <= maximum <= PROJECT_DOC_MAX_BYTES_LIMIT \
            and isinstance(fallbacks, list) and len(fallbacks) <= PROJECT_DOC_FALLBACK_LIMIT:
        safe_fallbacks: list[str] = []
        seen = {"agents.override.md", "agents.md"}
        for name in fallbacks:
            if not _valid_project_doc_fallback(name, seen):
                break
            seen.add(name.casefold())
            safe_fallbacks.append(name)
        else:
            validated["project_doc_max_bytes"] = maximum
            validated["project_doc_fallback_filenames"] = safe_fallbacks
    return validated


def _command(value: Any, label: str) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value:
        raise PermanentError(f"bundle field is invalid: {label}")
    argv = []
    for item in value:
        if not isinstance(item, str) or not item or "\x00" in item:
            raise PermanentError(f"bundle field is invalid: {label}")
        argv.append(item)
    if not argv[0].startswith("/"):
        raise PermanentError(f"bundle field must name an absolute executable: {label}")
    return argv


def _command_list(value: Any, label: str) -> list[list[str]]:
    if not isinstance(value, list) or not value:
        raise PermanentError(f"bundle field is invalid: {label}")
    return [_command(item, label) for item in value]
