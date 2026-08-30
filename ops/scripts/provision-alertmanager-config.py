#!/usr/bin/env python3
"""Prepare Alertmanager from an existing Telegram alias without exposing identity data.

The Telegram bridge already owns the bot token and allowlists.  This tool selects
one recent bridge-authenticated private origin for the alias, proves that destination
is shared by its user and chat allowlists, reuses the existing token file, and writes
only the protected chat-id file supported by Alertmanager.  It prints paths only;
token contents and identifiers never enter stdout or process args.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any

PROJECT = pathlib.Path(__file__).resolve().parents[2]
ALIAS = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
IDENTIFIER = re.compile(r"^-?[1-9][0-9]{0,18}$")
CONTAINER_RUNTIME = pathlib.PurePosixPath("/run/cauce-telegram")
PRIVATE_POSTGRES = PROJECT / "ops" / "scripts" / "private-postgres-command.py"
TENANT = re.compile(r"^[A-Z][A-Za-z0-9_-]{0,63}$")
CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class ProvisionError(ValueError):
    """A fail-closed source or filesystem error."""


def _private_regular(path: pathlib.Path, label: str) -> None:
    try:
        details = path.lstat()
    except OSError as exc:
        raise ProvisionError(f"cannot inspect {label}: {exc}") from exc
    if not stat.S_ISREG(details.st_mode):
        raise ProvisionError(f"{label} must be a regular file, not a symlink or device")
    if details.st_mode & 0o077:
        raise ProvisionError(f"{label} permissions allow group or other access")


def _private_directory(path: pathlib.Path, label: str) -> None:
    try:
        details = path.lstat()
    except OSError as exc:
        raise ProvisionError(f"cannot inspect {label}: {exc}") from exc
    if not stat.S_ISDIR(details.st_mode):
        raise ProvisionError(f"{label} must be a real directory")
    if details.st_mode & 0o077:
        raise ProvisionError(f"{label} permissions allow group or other access")


def _adopt_directory(path: pathlib.Path, label: str, uid: int, gid: int, allowed: set[str] | None = None) -> None:
    _private_directory(path, label)
    entries = list(path.iterdir())
    if allowed is not None and any(entry.name not in allowed for entry in entries):
        raise ProvisionError(f"{label} contains an unexpected entry")
    details = path.stat()
    if (details.st_uid, details.st_gid) == (uid, gid):
        return
    if entries:
        raise ProvisionError(f"{label} has existing state owned by a different principal")
    if os.geteuid() != 0:
        raise ProvisionError(f"{label} owner differs from the Telegram token owner")
    os.chown(path, uid, gid)


def _inside_project(path: pathlib.Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(PROJECT)
    except ValueError:
        return False
    return True


def _identifier_list(value: Any, label: str) -> set[str]:
    if not isinstance(value, list) or not value:
        raise ProvisionError(f"{label} must be a non-empty array")
    result: set[str] = set()
    for item in value:
        if not isinstance(item, str) or not IDENTIFIER.fullmatch(item):
            raise ProvisionError(f"{label} contains an invalid identifier")
        if item in result:
            raise ProvisionError(f"{label} contains duplicates")
        result.add(item)
    return result


def _load_alias(config_path: pathlib.Path, alias: str) -> dict[str, Any]:
    _private_regular(config_path, "Telegram config")
    try:
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProvisionError(f"cannot read Telegram config: {exc}") from exc
    rows = document.get("aliases") if isinstance(document, dict) else None
    if not isinstance(rows, list):
        raise ProvisionError("Telegram config must contain an aliases array")
    matches = [row for row in rows if isinstance(row, dict) and row.get("alias") == alias]
    if len(matches) != 1:
        raise ProvisionError("Telegram config must contain the selected alias exactly once")
    return matches[0]


def _trusted_origin_query(tenant: str, alias: str, max_age_hours: int) -> str:
    if not TENANT.fullmatch(tenant) or not ALIAS.fullmatch(alias):
        raise ProvisionError("trusted origin tenant or alias is invalid")
    if not 1 <= max_age_hours <= 168:
        raise ProvisionError("trusted origin window must be between 1 and 168 hours")
    return """
WITH candidates AS (
  SELECT DISTINCT origin->>'conversation_id' AS identifier
  FROM messages
  WHERE tenant_id=:'tenant'
    AND origin->>'adapter'='telegram'
    AND origin->'metadata'->>'bridge_alias'=:'alias'
    AND origin->'metadata'->>'chat_type' IN ('private','dm')
    AND origin->>'conversation_id'~'^[1-9][0-9]{0,18}$'
    AND created_at>=now()-make_interval(hours=>:'hours'::integer)
)
SELECT identifier FROM candidates ORDER BY identifier
""".strip()


def _one_trusted_origin(completed: subprocess.CompletedProcess[str]) -> str:
    if completed.returncode != 0:
        raise ProvisionError("trusted Telegram origin query failed")
    candidates = completed.stdout.splitlines()
    if len(candidates) != 1 or not IDENTIFIER.fullmatch(candidates[0]) or int(candidates[0]) <= 0:
        raise ProvisionError("recent trusted Telegram origins do not identify exactly one private destination")
    return candidates[0]


def _trusted_direct_origin(
    database_url_file: pathlib.Path,
    tenant: str,
    alias: str,
    max_age_hours: int,
    private_postgres: pathlib.Path = PRIVATE_POSTGRES,
) -> str:
    """Select one recent, bridge-authenticated private origin via a private libpq URL."""
    if not database_url_file.is_absolute():
        raise ProvisionError("database URL file must be absolute")
    query = _trusted_origin_query(tenant, alias, max_age_hours)
    try:
        completed = subprocess.run(
            [
                sys.executable,
                os.fspath(private_postgres),
                os.fspath(database_url_file),
                "--",
                "psql",
                "-XAtq",
                "--no-password",
                "--set=ON_ERROR_STOP=1",
                f"--set=tenant={tenant}",
                f"--set=alias={alias}",
                f"--set=hours={max_age_hours}",
            ],
            check=False,
            capture_output=True,
            text=True,
            input=f"{query}\n",
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProvisionError("cannot query the trusted Telegram origin") from exc
    return _one_trusted_origin(completed)


def _trusted_direct_origin_from_container(
    postgres_container: str,
    tenant: str,
    alias: str,
    max_age_hours: int,
) -> str:
    """Select the origin through the authenticated local PostgreSQL container, without a DSN."""
    if not CONTAINER.fullmatch(postgres_container):
        raise ProvisionError("PostgreSQL container name is invalid")
    query = _trusted_origin_query(tenant, alias, max_age_hours)
    try:
        inspected = subprocess.run(
            [
                "docker", "inspect", "--format",
                '{{index .Config.Labels "com.docker.compose.project"}}|'
                '{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}',
                postgres_container,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if inspected.returncode != 0 or inspected.stdout.strip() != "cauce-v3-prod|postgres|true":
            raise ProvisionError("PostgreSQL container is not the running canonical production service")
        completed = subprocess.run(
            [
                "docker", "exec", "-i", postgres_container,
                "sh", "-eu", "-c",
                'exec psql -XAtq --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"',
                "cauce-alert-origin",
                "--set=ON_ERROR_STOP=1",
                f"--set=tenant={tenant}",
                f"--set=alias={alias}",
                f"--set=hours={max_age_hours}",
            ],
            check=False,
            capture_output=True,
            text=True,
            input=f"{query}\n",
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProvisionError("cannot query the trusted Telegram origin") from exc
    return _one_trusted_origin(completed)


def _atomic_private_text(path: pathlib.Path, value: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as stream:
            stream.write(value)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600, follow_symlinks=False)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def provision(
    telegram_config: pathlib.Path,
    telegram_runtime_dir: pathlib.Path,
    alias: str,
    secret_dir: pathlib.Path,
    data_dir: pathlib.Path,
    trusted_chat_id: str,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, int, int]:
    if not ALIAS.fullmatch(alias):
        raise ProvisionError("alias is invalid")
    for path, label in (
        (telegram_runtime_dir, "Telegram runtime directory"),
        (secret_dir, "secret directory"),
        (data_dir, "data directory"),
    ):
        if not path.is_absolute():
            raise ProvisionError(f"{label} must be absolute")
        _private_directory(path, label)
    if _inside_project(secret_dir) or _inside_project(data_dir):
        raise ProvisionError("secret and data directories must be outside the repository")

    row = _load_alias(telegram_config, alias)
    user_ids = _identifier_list(row.get("allowed_user_ids"), "allowed_user_ids")
    chat_ids = _identifier_list(row.get("allowed_chat_ids"), "allowed_chat_ids")
    if not IDENTIFIER.fullmatch(trusted_chat_id) or int(trusted_chat_id) <= 0:
        raise ProvisionError("trusted origin is not a private Telegram destination")
    if trusted_chat_id not in user_ids or trusted_chat_id not in chat_ids:
        raise ProvisionError("trusted origin is not authorized by both alias allowlists")

    token_value = row.get("token_file")
    if not isinstance(token_value, str):
        raise ProvisionError("selected alias has no token_file")
    token_container = pathlib.PurePosixPath(token_value)
    try:
        token_relative = token_container.relative_to(CONTAINER_RUNTIME)
    except ValueError as exc:
        raise ProvisionError("token_file is outside /run/cauce-telegram") from exc
    if len(token_relative.parts) != 1 or token_relative.name in ("", ".", ".."):
        raise ProvisionError("token_file must be a direct child of /run/cauce-telegram")
    token_host = telegram_runtime_dir / token_relative.name
    _private_regular(token_host, "Telegram token file")
    token_details = token_host.stat()
    if token_details.st_uid == 0:
        raise ProvisionError("Telegram token must belong to a non-root runtime principal")
    _adopt_directory(
        secret_dir,
        "secret directory",
        token_details.st_uid,
        token_details.st_gid,
        {"telegram-chat-id"},
    )
    _adopt_directory(data_dir, "data directory", token_details.st_uid, token_details.st_gid)

    identifier_path = secret_dir / "telegram-chat-id"
    if identifier_path.is_symlink():
        raise ProvisionError("Alertmanager chat-id path must not be a symlink")
    _atomic_private_text(identifier_path, trusted_chat_id)
    os.chown(identifier_path, token_details.st_uid, token_details.st_gid)
    return identifier_path, token_host, data_dir, token_details.st_uid, token_details.st_gid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--telegram-config", type=pathlib.Path, required=True)
    parser.add_argument("--telegram-runtime-dir", type=pathlib.Path, required=True)
    parser.add_argument("--alias", required=True)
    parser.add_argument("--tenant", required=True)
    database = parser.add_mutually_exclusive_group(required=True)
    database.add_argument("--database-url-file", type=pathlib.Path)
    database.add_argument("--postgres-container")
    parser.add_argument("--trusted-origin-max-age-hours", type=int, default=24)
    parser.add_argument("--secret-dir", type=pathlib.Path, required=True)
    parser.add_argument("--data-dir", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        if args.postgres_container:
            trusted_chat_id = _trusted_direct_origin_from_container(
                args.postgres_container,
                args.tenant,
                args.alias,
                args.trusted_origin_max_age_hours,
            )
        else:
            trusted_chat_id = _trusted_direct_origin(
                args.database_url_file,
                args.tenant,
                args.alias,
                args.trusted_origin_max_age_hours,
            )
        chat_id, token, data, uid, gid = provision(
            args.telegram_config,
            args.telegram_runtime_dir,
            args.alias,
            args.secret_dir,
            args.data_dir,
            trusted_chat_id,
        )
    except ProvisionError as exc:
        parser.error(str(exc))
    print("Alertmanager private configuration prepared")
    print(f"CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH={chat_id}")
    print(f"CAUCE_ALERTMANAGER_TELEGRAM_TOKEN_PATH={token}")
    print(f"CAUCE_ALERTMANAGER_DATA_DIR={data}")
    print(f"CAUCE_ALERTMANAGER_UID={uid}")
    print(f"CAUCE_ALERTMANAGER_GID={gid}")


if __name__ == "__main__":
    main()
