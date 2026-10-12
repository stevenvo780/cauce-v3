"""Validate controller-owned project data without granting transport authority."""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.parse
from pathlib import Path

# cauce:requiere none

DEFAULT_PATH = Path(__file__).with_name("project-profile.json")
DEFAULT = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}\Z")
RESOURCE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\Z")


def fingerprint(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def safe_path(value: object, state, relative: bool = False) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise state.SupervisionError("invalid_project_profile_path")
    path = Path(value)
    if path.is_absolute() == relative or ".." in path.parts or path == Path("/") or str(path) != value:
        raise state.SupervisionError("invalid_project_profile_path")
    if any(part.lower() in {"credentials", "secrets", "sessions", "profiles", ".git"} or part.startswith(".env") for part in path.parts):
        raise state.SupervisionError("invalid_project_profile_path")
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise state.SupervisionError("invalid_project_profile_path")
    return path


def validate(value: object, state) -> dict:
    if not isinstance(value, dict) or set(value) != set(DEFAULT) or type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise state.SupervisionError("invalid_project_profile")
    for key in ("tenant_id", "room_id", "supervisor_alias", "recipient_alias"):
        if not isinstance(value[key], str) or not IDENTIFIER.fullmatch(value[key]):
            raise state.SupervisionError("invalid_project_profile_scope")
    actors = value["participants"]
    if not isinstance(actors, list) or not 1 <= len(actors) <= 100 or len(set(actors)) != len(actors) or value["recipient_alias"] not in actors or any(not isinstance(actor, str) or not IDENTIFIER.fullmatch(actor) for actor in actors):
        raise state.SupervisionError("invalid_project_profile_participants")
    for key in ("postgres_container", "actor_container", "postgres_user", "postgres_database"):
        if not isinstance(value[key], str) or not RESOURCE.fullmatch(value[key]):
            raise state.SupervisionError("invalid_project_profile_resource")
    for key in ("actor_uid", "actor_gid", "issue_count", "roadmap_count"):
        if type(value[key]) is not int or not 1 <= value[key] <= 100000:
            raise state.SupervisionError("invalid_project_profile_bounds")
    for key in ("workspace", "actor_workspace", "acceptance_root", "config_path", "state_path"):
        safe_path(value[key], state)
    if Path(value["acceptance_root"]).is_relative_to(Path(value["workspace"])) or Path(value["workspace"]).is_relative_to(Path(value["acceptance_root"])):
        raise state.SupervisionError("invalid_project_profile_path")
    origin = value["acceptance_origin"]
    if not isinstance(origin, dict) or set(origin) != {"kind", "channel", "conversation_id"} or origin["kind"] != "authenticated-owner" or origin["channel"] != "cauce.trusted-origin" or not isinstance(origin["conversation_id"], str) or not IDENTIFIER.fullmatch(origin["conversation_id"]):
        raise state.SupervisionError("invalid_project_profile_origin")
    if not isinstance(value["project_name"], str) or not 1 <= len(value["project_name"]) <= 120 or any(ord(char) < 32 for char in value["project_name"]):
        raise state.SupervisionError("invalid_project_profile")
    if not isinstance(value["root_text"], str) or not 1 <= len(value["root_text"]) <= 16000 or not isinstance(value["deferred_issues"], list) or any(not isinstance(item, str) or not IDENTIFIER.fullmatch(item) for item in value["deferred_issues"]):
        raise state.SupervisionError("invalid_project_profile")
    notification = value["notification"]
    if not isinstance(notification, dict) or set(notification) != {"enabled", "egress_handle"} or type(notification["enabled"]) is not bool or not isinstance(notification["egress_handle"], str) or not IDENTIFIER.fullmatch(notification["egress_handle"]):
        raise state.SupervisionError("invalid_project_profile_notification")
    preview = value["preview"]
    if preview is not None:
        if not isinstance(preview, dict) or set(preview) != set(DEFAULT["preview"]):
            raise state.SupervisionError("invalid_project_profile_preview")
        for key in ("workspace", "root", "publication_state", "unit_file"):
            safe_path(preview[key], state)
        if preview["workspace"] != value["workspace"] or Path(preview["root"]).is_relative_to(Path(value["workspace"])) or Path(value["workspace"]).is_relative_to(Path(preview["root"])):
            raise state.SupervisionError("invalid_project_profile_preview")
        if not Path(preview["publication_state"]).is_relative_to(Path(value["acceptance_root"])) or Path(preview["unit_file"]).name != preview["service"] or not RESOURCE.fullmatch(preview["service"]) or not preview["service"].endswith(".service"):
            raise state.SupervisionError("invalid_project_profile_preview")
        files=preview["files"]
        if not isinstance(files, dict) or not 1 <= len(files) <= 32 or len(set(files.values())) != len(files):
            raise state.SupervisionError("invalid_project_profile_preview")
        for source, destination in files.items():
            safe_path(source, state, relative=True)
            if safe_path(destination, state, relative=True).name != destination:
                raise state.SupervisionError("invalid_project_profile_preview")
        safe_path(preview["server_file"], state, relative=True)
        if not isinstance(preview["required_sources"], list) or preview["server_file"] not in preview["required_sources"]:
            raise state.SupervisionError("invalid_project_profile_preview")
        for source in preview["required_sources"]:
            safe_path(source,state,relative=True)
        url=urllib.parse.urlsplit(preview["health_url"])
        if url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"} or url.username or url.password or url.query or url.fragment:
            raise state.SupervisionError("invalid_project_profile_preview")
    return value


def for_config(config: dict | None, state) -> dict:
    if not config or "project_profile" not in config:
        return DEFAULT
    value = validate(config["project_profile"], state)
    if config.get("project_profile_sha256") != fingerprint(value):
        raise state.SupervisionError("project_profile_fingerprint_mismatch")
    return value


def load(config: dict, state) -> dict:
    path = config.get("project_profile_file")
    if path is not None:
        if "project_profile" in config:
            raise state.SupervisionError("ambiguous_project_profile")
        location = safe_path(path, state)
        state.trusted_file(location)
        config["project_profile"] = json.loads(state.read_bytes(location, 64000))
    return for_config(config, state)


def command_identity(command: list[str], profile: dict, error_type) -> dict:
    if command[:2] != ["git", "-C"]:
        return {}
    owner = Path(command[2]).stat()
    if owner.st_uid == 0:
        raise error_type("git_workspace_requires_unprivileged_owner")
    if os.geteuid() != 0:
        raise error_type("git_requires_actor_isolation")
    if command[2] != profile["workspace"] or owner.st_uid != profile["actor_uid"]:
        raise error_type("git_workspace_requires_actor_isolation")
    return {}


def isolated_command(command: list[str], profile: dict, error_type) -> list[str]:
    if command[:2] != ["git", "-C"]:
        return command
    command_identity(command, profile, error_type)
    return ["docker", "exec", "-u", f"{profile['actor_uid']}:{profile['actor_gid']}", profile["actor_container"],
            "git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", profile["actor_workspace"], *command[3:]]


def preview_settings(config: dict, state, defaults: dict) -> dict:
    if "project_profile" in config:
        profile = state.project_profile(config)
        preview = profile["preview"]
        if preview is None:
            raise state.SupervisionError("invalid_preview_publication_configuration")
        return {"workspace": Path(preview["workspace"]), "root": Path(preview["root"]),
                "publication_state": Path(preview["publication_state"]), "service": preview["service"],
                "unit_file": Path(preview["unit_file"]), "health_url": preview["health_url"], "files": preview["files"],
                "uid": str(profile["actor_uid"]), "gid": str(profile["actor_gid"]),
                "server_file": preview["server_file"], "required_sources": set(preview["required_sources"])}
    return defaults



def validate_preview(config: dict, state, settings_factory, allowed_keys) -> None:
    enabled = config.get("auto_publish_synthetic_preview", False)
    if type(enabled) is not bool:
        raise state.SupervisionError("invalid_preview_publication_configuration")
    if not enabled:
        return
    settings = settings_factory(config, state)
    if (set(config) - allowed_keys or config.get("workspace") != str(settings["workspace"])
            or config.get("preview_root") != str(settings["root"]) or config.get("preview_files") != settings["files"]):
        raise state.SupervisionError("invalid_preview_publication_configuration")



PREVIEW_CONFIG_KEYS = {"workspace", "goal_file", "goal_sha256", "issues_file", "roadmap_file", "preview_root", "preview_files",
               "verification_file", "evidence_file", "client_cert", "client_key", "ca_cert", "api_url", "root_limit",
               "notice_limit", "idle_seconds", "cooldown_seconds", "api_timeout", "pass_seconds", "heartbeat_seconds",
               "issue_count", "roadmap_count", "enabled", "bootstrap_receipt_path", "bootstrap_generation",
               "bootstrap_daily_roots", "identity_metadata_file", "certificate_not_after", "postgres_container",
               "issues_columns", "required_gates", "acceptance_receipts_file", "auto_publish_synthetic_preview",
               "project_profile", "project_profile_file", "project_profile_sha256"}

