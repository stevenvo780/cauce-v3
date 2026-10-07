"""Publish only the fixed synthetic preview under the root controller's lock."""

from __future__ import annotations

import errno
import json
import os
import re
import stat
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

# cauce:requiere none

DEFAULT = json.loads(Path(__file__).with_name("project-profile.json").read_text(encoding="utf-8"))
WORKSPACE = Path(DEFAULT["preview"]["workspace"])
PREVIEW_ROOT = Path(DEFAULT["preview"]["root"])
PUBLICATION_STATE = Path(DEFAULT["preview"]["publication_state"])
SERVICE = DEFAULT["preview"]["service"]
UNIT_FILE = Path(DEFAULT["preview"]["unit_file"])
HEALTH_URL = DEFAULT["preview"]["health_url"]
WEB_FILES = DEFAULT["preview"]["files"]
MAXIMUM_BYTES = 4_000_000


def preview_settings(config: dict, state) -> dict:
    return state.PROFILE.preview_settings(config, state, {"workspace": WORKSPACE, "root": PREVIEW_ROOT,
        "publication_state": PUBLICATION_STATE, "service": SERVICE, "unit_file": UNIT_FILE,
        "health_url": HEALTH_URL, "files": WEB_FILES, "uid": str(DEFAULT["actor_uid"]),
        "gid": str(DEFAULT["actor_gid"]), "server_file": DEFAULT["preview"]["server_file"],
        "required_sources": set(DEFAULT["preview"]["required_sources"])})

def validate_config(config: dict, state) -> None:
    state.PROFILE.validate_preview(config, state, preview_settings, state.PROFILE.PREVIEW_CONFIG_KEYS)


def guard_parents(path: Path, state) -> None:
    for directory in reversed((path.parent, *path.parent.parents)):
        state.trusted_file(directory, directory=True)


def check_deadline(deadline: float, state, reserve: float = 0) -> None:
    if deadline - time.monotonic() <= reserve:
        raise state.SupervisionError("preview_pass_timeout")


def public_bytes(path: Path, state) -> bytes:
    if path.resolve() != path or any(parent.is_symlink() for parent in path.parents):
        raise state.SupervisionError("preview_unsafe_public_file")
    try:
        descriptor = state.readonly_descriptor(path)
    except state.SupervisionError as error:
        raise state.SupervisionError("preview_unsafe_public_file") from error
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > MAXIMUM_BYTES:
            raise state.SupervisionError("preview_unsafe_public_file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = stream.read(MAXIMUM_BYTES + 1)
        if len(value) > MAXIMUM_BYTES:
            raise state.SupervisionError("preview_unsafe_public_file")
        return value
    finally:
        os.close(descriptor)


def guarded_directory(state, settings: dict | None = None) -> int:
    settings = settings or preview_settings({}, state)
    guard_parents(settings["root"], state)
    state.trusted_file(settings["root"], directory=True)
    if stat.S_IMODE(settings["root"].lstat().st_mode) != 0o755:
        raise state.SupervisionError("preview_unguarded_destination")
    return os.open(settings["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def failure(state, code: str, stage: str, error=None):
    value = state.SupervisionError(code)
    number = getattr(error, "errno", None)
    value.preview_diagnostics = {"stage": stage, "errno": number if type(number) is int else None}
    return value


def preflight_writable(directory: int, state) -> None:
    if os.fstatvfs(directory).f_flag & os.ST_RDONLY:
        raise failure(state, "preview_destination_read_only", "preflight", OSError(errno.EROFS, "read-only preview"))
    temporary = ".praxis-preflight-" + uuid.uuid4().hex
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    except OSError as error:
        code = "preview_destination_read_only" if error.errno == errno.EROFS else "preview_destination_not_writable"
        raise failure(state, code, "preflight", error) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
            os.unlink(temporary, dir_fd=directory)


def atomic_bytes(directory: int, name: str, value: bytes) -> None:
    temporary = ".praxis-publish-" + uuid.uuid4().hex
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(value)
            stream.flush()
            os.fsync(descriptor)
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def service_guard(deadline: float, state, run_command, settings: dict | None = None) -> None:
    settings = settings or preview_settings({}, state)
    guard_parents(settings["unit_file"], state)
    state.trusted_file(settings["unit_file"])
    properties = "LoadState,User,Group,NoNewPrivileges,PermissionsStartOnly,ExecStartEx,ExecConditionEx,ExecStartPreEx,ExecStartPostEx,ExecStopEx,ExecStopPostEx,FragmentPath,DropInPaths"
    raw = systemd_command(["show", settings["service"], "--no-pager", "--property=" + properties], deadline, state, run_command)
    values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    start = values.get("ExecStartEx", "")
    path = re.search(r"\bpath=([^;]+);", start)
    argv = re.search(r"\bargv\[\]=([^;]+);", start)
    flags = re.findall(r"\bflags=([^;]*);", start)
    if (values.get("LoadState") != "loaded" or values.get("User") != settings["uid"] or values.get("Group") != settings["gid"]
            or values.get("NoNewPrivileges") != "yes" or values.get("PermissionsStartOnly", "no") != "no"
            or values.get("FragmentPath") != str(settings["unit_file"]) or values.get("DropInPaths", "")
            or any(values.get(key) for key in ("ExecConditionEx", "ExecStartPreEx", "ExecStartPostEx", "ExecStopEx", "ExecStopPostEx"))
            or path is None or path[1].strip() != "/usr/bin/python3" or argv is None
            or argv[1].strip() != "/usr/bin/python3 " + str(settings["workspace"] / settings["server_file"])
            or not flags or any(flag.strip() for flag in flags)):
        raise state.SupervisionError("preview_service_unguarded")


def systemd_command(arguments: list[str], deadline: float, state, run_command) -> str:
    try:
        return run_command(["systemctl", *arguments], deadline)
    except state.SupervisionError as error:
        code = {"show": "preview_service_metadata_unknown", "restart": "preview_service_restart_unknown",
                "is-active": "preview_service_health_unknown"}[arguments[0]]
        raise state.SupervisionError(code) from error


def http_auth_health(deadline: float, state, settings: dict | None = None) -> None:
    settings = settings or preview_settings({}, state)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            raise state.SupervisionError("preview_http_redirect_refused")

    check_deadline(deadline, state)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(settings["health_url"], headers={"Accept": "application/json"}, method="GET")
    health_deadline = min(deadline, time.monotonic() + 3)
    last_error = None
    for _ in range(32):
        remaining = health_deadline - time.monotonic()
        if remaining <= 0:
            break
        response = None
        try:
            try:
                response = opener.open(request, timeout=remaining)
            except urllib.error.HTTPError as error:
                response = error
            if (response.code != 401 or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
                raise state.SupervisionError("preview_http_auth_health_failed")
            return
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            if getattr(reason, "errno", None) != errno.ECONNREFUSED:
                raise failure(state, "preview_http_auth_health_unknown", "health", reason) from error
            last_error = reason
            remaining = health_deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.1, remaining))
        finally:
            if response is not None:
                response.close()
    raise failure(state, "preview_http_auth_health_unknown", "health", last_error)


def marker(state, goal: str, settings: dict | None = None) -> dict | None:
    settings = settings or preview_settings({}, state)
    guard_parents(settings["publication_state"], state)
    if not settings["publication_state"].exists() and not settings["publication_state"].is_symlink():
        return None
    state.trusted_file(settings["publication_state"])
    if stat.S_IMODE(settings["publication_state"].lstat().st_mode) != 0o600:
        raise state.SupervisionError("preview_publication_state_untrusted")
    value = json.loads(state.read_bytes(settings["publication_state"], 16_000))
    if (not isinstance(value, dict) or value.get("schema_version") != 1 or value.get("goal_sha256") != goal
            or value.get("service") != settings["service"] or value.get("authorization") != "existing_owner_synthetic_preview"
            or not isinstance(value.get("app_source_hashes"), dict)
            or value.get("fingerprint") != state.digest(state.canonical(value["app_source_hashes"]))):
        raise state.SupervisionError("preview_publication_state_invalid")
    return value


def verify_source(config: dict, engineering: dict, deadline: float, state, run_command, source_matches, settings: dict | None = None) -> dict:
    settings = settings or preview_settings({}, state)
    check_deadline(deadline, state)
    sources = engineering.get("source_hashes")
    required = set(settings["files"]) | settings["required_sources"]
    if not isinstance(sources, dict) or not required.issubset(sources):
        raise state.SupervisionError("preview_source_changed")
    for source in sources:
        path = state.scoped(settings["workspace"], source)
        if path.resolve() != path or any(parent.is_symlink() for parent in path.parents):
            raise state.SupervisionError("preview_unsafe_public_file")
    if not source_matches(sources):
        raise state.SupervisionError("preview_source_changed")
    if (run_command(["git", "-C", str(settings["workspace"]), "rev-parse", "HEAD"], deadline).strip() != engineering.get("git_head")
            or run_command(["git", "-C", str(settings["workspace"]), "status", "--porcelain"], deadline).strip()):
        raise state.SupervisionError("preview_source_changed")
    captured = {}
    for source, destination in settings["files"].items():
        value = public_bytes(state.scoped(settings["workspace"], source), state)
        if state.digest(value) != sources.get(source):
            raise state.SupervisionError("preview_source_changed")
        captured[destination] = value
    return captured


def fresh_idle(runtime_reader, state, settings: dict | None = None) -> None:
    settings = settings or preview_settings({}, state)
    stop = settings["publication_state"].parent / "STOP"
    if stop.exists() or stop.is_symlink():
        state.trusted_file(stop)
        raise state.SupervisionError("preview_owner_stopped")
    runtime = runtime_reader()
    if (not isinstance(runtime, dict) or not isinstance(runtime.get("observed_at"), (int, float))
            or abs(time.time() - runtime["observed_at"]) > 10):
        raise state.SupervisionError("preview_runtime_stale")
    if type(runtime.get("active")) is not int or runtime["active"] != 0 or runtime.get("ready") is not True:
        raise state.SupervisionError("preview_activity_changed")


def publish(config: dict, engineering: dict, runtime: dict, deadline: float, state, run_command,
            runtime_reader, source_matches, observe_only: bool = False) -> dict:
    validate_config(config, state)
    if not config.get("auto_publish_synthetic_preview", False):
        return {"action": "preview_disabled"}
    settings = preview_settings(config, state)
    if observe_only or not config.get("enabled", False):
        return {"action": "preview_observe_only"}
    if type(runtime.get("active")) is not int or runtime["active"] != 0 or runtime.get("ready") is not True:
        return {"action": "preview_active_work"}
    if (engineering.get("verified_engineering") is not True or engineering.get("verification_source_current") is not True
            or not {"tests", "qa", "snapshot"}.issubset(engineering.get("valid_gates", []))):
        return {"action": "preview_evidence_pending"}
    if engineering.get("production_clinical_accepted", False) is not False:
        raise state.SupervisionError("preview_clinical_scope_refused")
    if engineering.get("goal_sha256") != config.get("goal_sha256"):
        raise state.SupervisionError("preview_foreign_goal")
    check_deadline(deadline, state, 12)
    fresh_idle(runtime_reader, state, settings)
    service_guard(deadline, state, run_command, settings)
    previous = marker(state, config["goal_sha256"], settings)
    captured = verify_source(config, engineering, deadline, state, run_command, source_matches, settings)
    app_sources = {path: sha for path, sha in engineering["source_hashes"].items()
                   if path in settings["files"] or path in settings["required_sources"]}
    fingerprint = state.digest(state.canonical(app_sources))
    new_application = previous is None or previous["fingerprint"] != fingerprint
    directory = guarded_directory(state, settings)
    originals, changed, stage = {}, [], "preflight"
    try:
        originals = {name: public_bytes(settings["root"] / name, state) for name in settings["files"].values()}
        different = [name for name, value in captured.items() if originals[name] != value]
        if not new_application and not different:
            systemd_command(["is-active", "--quiet", settings["service"]], deadline, state, run_command)
            http_auth_health(deadline, state, settings)
            return {"action": "preview_already_current", "fingerprint": fingerprint}
        preflight_writable(directory, state)
        fresh_idle(runtime_reader, state, settings)
        if verify_source(config, engineering, deadline, state, run_command, source_matches, settings) != captured:
            raise state.SupervisionError("preview_source_changed")
        for name in different:
            check_deadline(deadline, state, 6)
            changed.append(name)
            stage = "copy"
            atomic_bytes(directory, name, captured[name])
        fresh_idle(runtime_reader, state, settings)
        verify_source(config, engineering, deadline, state, run_command, source_matches, settings)
        if any(public_bytes(settings["root"] / name, state) != value for name, value in captured.items()):
            raise state.SupervisionError("preview_copy_verification_failed")
        service_guard(deadline, state, run_command, settings)
        if new_application:
            stage = "restart"
            systemd_command(["restart", settings["service"]], deadline, state, run_command)
        stage = "health"
        systemd_command(["is-active", "--quiet", settings["service"]], deadline, state, run_command)
        verify_source(config, engineering, deadline, state, run_command, source_matches, settings)
        http_auth_health(deadline, state, settings)
        fresh_idle(runtime_reader, state, settings)
        verify_source(config, engineering, deadline, state, run_command, source_matches, settings)
        stage = "marker"
        state.atomic_save(settings["publication_state"], {"schema_version": 1, "goal_sha256": config["goal_sha256"],
            "source_commit": engineering["git_head"], "service": settings["service"], "fingerprint": fingerprint,
            "app_source_hashes": app_sources, "web_hashes": {name: state.digest(value) for name, value in captured.items()},
            "authorization": "existing_owner_synthetic_preview", "published_at": time.time()})
        return {"action": "preview_published", "fingerprint": fingerprint, "service_restarted": new_application}
    except BaseException as error:
        try:
            for name in changed:
                if public_bytes(settings["root"] / name, state) != originals[name]:
                    atomic_bytes(directory, name, originals[name])
        except BaseException as rollback_error:
            value = failure(state, "preview_rollback_unknown", "rollback", rollback_error)
            value.preview_diagnostics.update(cause_stage=stage, cause_errno=getattr(error, "errno", None))
            raise value from rollback_error
        if isinstance(error, state.SupervisionError):
            if not getattr(error, "preview_diagnostics", None):
                error.preview_diagnostics = {"stage": stage, "errno": None}
            raise
        raise failure(state, "preview_publication_failed", stage, error) from error
    finally:
        os.close(directory)
