"""Publish only the fixed synthetic preview under the root controller's lock."""

from __future__ import annotations

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

WORKSPACE = Path("/opt/hospital-agent/runtime/praxis/operator")
PREVIEW_ROOT = Path("/opt/hospital-agent/runtime/praxis-preview/web")
PUBLICATION_STATE = Path("/var/lib/praxis-supervision/published-preview.json")
SERVICE = "praxis-preview.service"
UNIT_FILE = Path("/etc/systemd/system/praxis-preview.service")
HEALTH_URL = "http://127.0.0.1:8077/api/session"
WEB_FILES = {"apps/web/app.css": "app.css", "apps/web/app.js": "app.js", "apps/web/index.html": "index.html"}
MAXIMUM_BYTES = 4_000_000
CONFIG_KEYS = {"workspace", "goal_file", "goal_sha256", "issues_file", "roadmap_file", "preview_root", "preview_files",
               "verification_file", "evidence_file", "client_cert", "client_key", "ca_cert", "api_url", "root_limit",
               "notice_limit", "idle_seconds", "cooldown_seconds", "api_timeout", "pass_seconds", "heartbeat_seconds",
               "issue_count", "roadmap_count", "enabled", "bootstrap_receipt_path", "bootstrap_generation",
               "bootstrap_daily_roots", "identity_metadata_file", "certificate_not_after", "postgres_container",
               "issues_columns", "required_gates", "acceptance_receipts_file", "auto_publish_synthetic_preview"}


def validate_config(config: dict, state) -> None:
    enabled = config.get("auto_publish_synthetic_preview", False)
    if type(enabled) is not bool:
        raise state.SupervisionError("invalid_preview_publication_configuration")
    if enabled and (set(config) - CONFIG_KEYS or config.get("workspace") != str(WORKSPACE)
                    or config.get("preview_root") != str(PREVIEW_ROOT) or config.get("preview_files") != WEB_FILES):
        raise state.SupervisionError("invalid_preview_publication_configuration")


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


def guarded_directory(state) -> int:
    guard_parents(PREVIEW_ROOT, state)
    state.trusted_file(PREVIEW_ROOT, directory=True)
    if stat.S_IMODE(PREVIEW_ROOT.lstat().st_mode) != 0o755:
        raise state.SupervisionError("preview_unguarded_destination")
    return os.open(PREVIEW_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


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


def service_guard(deadline: float, state, run_command) -> None:
    guard_parents(UNIT_FILE, state)
    state.trusted_file(UNIT_FILE)
    properties = "LoadState,User,Group,NoNewPrivileges,PermissionsStartOnly,ExecStartEx,ExecConditionEx,ExecStartPreEx,ExecStartPostEx,ExecStopEx,ExecStopPostEx,FragmentPath,DropInPaths"
    raw = systemd_command(["show", SERVICE, "--no-pager", "--property=" + properties], deadline, state, run_command)
    values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    start = values.get("ExecStartEx", "")
    path = re.search(r"\bpath=([^;]+);", start)
    argv = re.search(r"\bargv\[\]=([^;]+);", start)
    flags = re.findall(r"\bflags=([^;]*);", start)
    if (values.get("LoadState") != "loaded" or values.get("User") != "1000" or values.get("Group") != "1000"
            or values.get("NoNewPrivileges") != "yes" or values.get("PermissionsStartOnly", "no") != "no"
            or values.get("FragmentPath") != str(UNIT_FILE) or values.get("DropInPaths", "")
            or any(values.get(key) for key in ("ExecConditionEx", "ExecStartPreEx", "ExecStartPostEx", "ExecStopEx", "ExecStopPostEx"))
            or path is None or path[1].strip() != "/usr/bin/python3" or argv is None
            or argv[1].strip() != "/usr/bin/python3 " + str(WORKSPACE / "apps/api/server.py")
            or not flags or any(flag.strip() for flag in flags)):
        raise state.SupervisionError("preview_service_unguarded")


def systemd_command(arguments: list[str], deadline: float, state, run_command) -> str:
    try:
        return run_command(["systemctl", *arguments], deadline)
    except state.SupervisionError as error:
        code = {"show": "preview_service_metadata_unknown", "restart": "preview_service_restart_unknown",
                "is-active": "preview_service_health_unknown"}[arguments[0]]
        raise state.SupervisionError(code) from error


def http_auth_health(deadline: float, state) -> None:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            raise state.SupervisionError("preview_http_redirect_refused")

    check_deadline(deadline, state)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(HEALTH_URL, headers={"Accept": "application/json"}, method="GET")
    response = None
    try:
        try:
            response = opener.open(request, timeout=min(3, deadline - time.monotonic()))
        except urllib.error.HTTPError as error:
            response = error
        if (response.code != 401 or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
            raise state.SupervisionError("preview_http_auth_health_failed")
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        raise state.SupervisionError("preview_http_auth_health_unknown") from error
    finally:
        if response is not None:
            response.close()


def marker(state, goal: str) -> dict | None:
    guard_parents(PUBLICATION_STATE, state)
    if not PUBLICATION_STATE.exists() and not PUBLICATION_STATE.is_symlink():
        return None
    state.trusted_file(PUBLICATION_STATE)
    if stat.S_IMODE(PUBLICATION_STATE.lstat().st_mode) != 0o600:
        raise state.SupervisionError("preview_publication_state_untrusted")
    value = json.loads(state.read_bytes(PUBLICATION_STATE, 16_000))
    if (not isinstance(value, dict) or value.get("schema_version") != 1 or value.get("goal_sha256") != goal
            or value.get("service") != SERVICE or value.get("authorization") != "existing_owner_synthetic_preview"
            or not isinstance(value.get("app_source_hashes"), dict)
            or value.get("fingerprint") != state.digest(state.canonical(value["app_source_hashes"]))):
        raise state.SupervisionError("preview_publication_state_invalid")
    return value


def verify_source(config: dict, engineering: dict, deadline: float, state, run_command, source_matches) -> dict:
    check_deadline(deadline, state)
    sources = engineering.get("source_hashes")
    required = set(WEB_FILES) | {"apps/api/server.py", "apps/api/store.py"}
    if not isinstance(sources, dict) or not required.issubset(sources):
        raise state.SupervisionError("preview_source_changed")
    for source in sources:
        path = state.scoped(WORKSPACE, source)
        if path.resolve() != path or any(parent.is_symlink() for parent in path.parents):
            raise state.SupervisionError("preview_unsafe_public_file")
    if not source_matches(sources):
        raise state.SupervisionError("preview_source_changed")
    if (run_command(["git", "-C", str(WORKSPACE), "rev-parse", "HEAD"], deadline).strip() != engineering.get("git_head")
            or run_command(["git", "-C", str(WORKSPACE), "status", "--porcelain"], deadline).strip()):
        raise state.SupervisionError("preview_source_changed")
    captured = {}
    for source, destination in WEB_FILES.items():
        value = public_bytes(state.scoped(WORKSPACE, source), state)
        if state.digest(value) != sources.get(source):
            raise state.SupervisionError("preview_source_changed")
        captured[destination] = value
    return captured


def fresh_idle(runtime_reader, state) -> None:
    stop = PUBLICATION_STATE.parent / "STOP"
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
    fresh_idle(runtime_reader, state)
    service_guard(deadline, state, run_command)
    previous = marker(state, config["goal_sha256"])
    captured = verify_source(config, engineering, deadline, state, run_command, source_matches)
    app_sources = {path: sha for path, sha in engineering["source_hashes"].items()
                   if path in WEB_FILES or (path.startswith("apps/api/") and path.endswith(".py")
                                            and not Path(path).name.startswith("test_"))}
    fingerprint = state.digest(state.canonical(app_sources))
    new_application = previous is None or previous["fingerprint"] != fingerprint
    directory = guarded_directory(state)
    originals, changed = {}, []
    try:
        originals = {name: public_bytes(PREVIEW_ROOT / name, state) for name in WEB_FILES.values()}
        different = [name for name, value in captured.items() if originals[name] != value]
        if not new_application and not different:
            systemd_command(["is-active", "--quiet", SERVICE], deadline, state, run_command)
            http_auth_health(deadline, state)
            return {"action": "preview_already_current", "fingerprint": fingerprint}
        fresh_idle(runtime_reader, state)
        if verify_source(config, engineering, deadline, state, run_command, source_matches) != captured:
            raise state.SupervisionError("preview_source_changed")
        for name in different:
            check_deadline(deadline, state, 6)
            changed.append(name)
            atomic_bytes(directory, name, captured[name])
        fresh_idle(runtime_reader, state)
        verify_source(config, engineering, deadline, state, run_command, source_matches)
        if any(public_bytes(PREVIEW_ROOT / name, state) != value for name, value in captured.items()):
            raise state.SupervisionError("preview_copy_verification_failed")
        service_guard(deadline, state, run_command)
        if new_application:
            systemd_command(["restart", SERVICE], deadline, state, run_command)
        systemd_command(["is-active", "--quiet", SERVICE], deadline, state, run_command)
        verify_source(config, engineering, deadline, state, run_command, source_matches)
        http_auth_health(deadline, state)
        fresh_idle(runtime_reader, state)
        verify_source(config, engineering, deadline, state, run_command, source_matches)
        state.atomic_save(PUBLICATION_STATE, {"schema_version": 1, "goal_sha256": config["goal_sha256"],
            "source_commit": engineering["git_head"], "service": SERVICE, "fingerprint": fingerprint,
            "app_source_hashes": app_sources, "web_hashes": {name: state.digest(value) for name, value in captured.items()},
            "authorization": "existing_owner_synthetic_preview", "published_at": time.time()})
        return {"action": "preview_published", "fingerprint": fingerprint, "service_restarted": new_application}
    except BaseException as error:
        try:
            for name in changed:
                atomic_bytes(directory, name, originals[name])
        except BaseException as rollback_error:
            raise state.SupervisionError("preview_rollback_unknown") from rollback_error
        if isinstance(error, state.SupervisionError):
            raise
        raise state.SupervisionError("preview_publication_failed") from error
    finally:
        os.close(directory)
