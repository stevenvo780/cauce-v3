#!/usr/bin/env bash
set -euo pipefail

STATUS_FILE=${STATUS_FILE:-/var/backups/cauce-v3-hospital/status.json}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-24}

python3 - "$STATUS_FILE" "$MAX_AGE_HOURS" <<'PY'
from pathlib import Path
import datetime
import hashlib
import json
import math
import os
import stat
import sys

status_path = Path(sys.argv[1])
try:
    maximum_age = float(sys.argv[2])
except ValueError as error:
    raise SystemExit("backup Hospital: MAX_AGE_HOURS inválido") from error
if not math.isfinite(maximum_age) or maximum_age <= 0:
    raise SystemExit("backup Hospital: MAX_AGE_HOURS inválido")


def open_private(path: Path, label: str, maximum: int | None = None) -> tuple[int, os.stat_result]:
    if not path.is_absolute() or path.is_symlink():
        raise ValueError(f"{label} no es un archivo absoluto seguro")
    metadata = path.stat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size < 1
        or (maximum is not None and metadata.st_size > maximum)
    ):
        raise ValueError(f"{label} no tiene owner/mode/tamaño válidos")
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino, opened.st_size) != (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
    ):
        os.close(descriptor)
        raise ValueError(f"{label} cambió durante la apertura")
    return descriptor, opened


def private_file(path: Path, label: str, maximum: int | None = None) -> bytes:
    descriptor, opened = open_private(path, label, maximum)
    try:
        chunks = []
        while block := os.read(descriptor, 1024 * 1024):
            chunks.append(block)
        final_opened = os.fstat(descriptor)
        final_named = path.stat()
        if (final_named.st_dev, final_named.st_ino, final_named.st_size, final_named.st_mtime_ns) != (
            final_opened.st_dev,
            final_opened.st_ino,
            final_opened.st_size,
            final_opened.st_mtime_ns,
        ) or (opened.st_size, opened.st_mtime_ns) != (final_opened.st_size, final_opened.st_mtime_ns):
            raise ValueError(f"{label} cambió durante la lectura")
    finally:
        os.close(descriptor)
    return b"".join(chunks)


def private_sha256(path: Path, label: str) -> str:
    descriptor, opened = open_private(path, label)
    digest = hashlib.sha256()
    try:
        while block := os.read(descriptor, 1024 * 1024):
            digest.update(block)
        final_opened = os.fstat(descriptor)
        final_named = path.stat()
        if (final_named.st_dev, final_named.st_ino, final_named.st_size, final_named.st_mtime_ns) != (
            final_opened.st_dev,
            final_opened.st_ino,
            final_opened.st_size,
            final_opened.st_mtime_ns,
        ) or (opened.st_size, opened.st_mtime_ns) != (final_opened.st_size, final_opened.st_mtime_ns):
            raise ValueError(f"{label} cambió durante la lectura")
    finally:
        os.close(descriptor)
    return digest.hexdigest()


try:
    status = json.loads(private_file(status_path, "status", 16_384).decode("utf-8"))
    if status.get("schema_version") != 1 or status.get("overall") != "ok":
        raise ValueError("el último backup no terminó en ok")
    if status.get("offsite") is not False:
        raise ValueError("la política de este monitor debe declarar offsite=false")
    finished = datetime.datetime.strptime(
        status["run_finished_utc"], "%Y-%m-%dT%H:%M:%SZ"
    ).replace(tzinfo=datetime.timezone.utc)
    age = (datetime.datetime.now(datetime.timezone.utc) - finished).total_seconds() / 3600
    if age < 0 or age > maximum_age:
        raise ValueError(f"el backup tiene {age:.1f} horas")
    dump = Path(status["dump_file"])
    root = status_path.parent / "dumps"
    if dump.parent != root or dump.name != dump.name.replace("/", ""):
        raise ValueError("dump fuera del directorio Hospital")
    digest = private_sha256(dump, "dump")
    if digest != status.get("dump_sha256"):
        raise ValueError("digest del dump no coincide")
    sidecar = private_file(Path(f"{dump}.sha256"), "checksum", 1024).decode("ascii")
    if sidecar != f"{digest}  {dump.name}\n":
        raise ValueError("sidecar del dump no coincide")
    evidence_path = Path(status["restore_evidence_file"])
    if evidence_path != Path(f"{dump}.restore.json"):
        raise ValueError("evidencia no corresponde al dump")
    evidence = json.loads(private_file(evidence_path, "evidencia", 16_384).decode("utf-8"))
    if (
        evidence.get("schema_version") != 1
        or evidence.get("suite") != "hospital-cauce-backup-restore"
        or evidence.get("dump_file") != dump.name
        or evidence.get("dump_sha256") != digest
        or evidence.get("isolated") is not True
        or evidence.get("network") != "none"
        or evidence.get("full_restore") is not True
        or evidence.get("tenant_count") != 1
        or evidence.get("room_count") != 1
        or evidence.get("agent_count") != 3
        or evidence.get("profile_count") != 3
        or evidence.get("membership_count") != 4
        or evidence.get("acl_edge_count") != 0
        or evidence.get("agent_topology") != "backend:hospital-developer:agent,frontend:hospital-developer:agent,operador:hospital-lider:operator"
        or not isinstance(evidence.get("migration_count"), int)
        or evidence["migration_count"] < 1
    ):
        raise ValueError("evidencia de restauración incompleta")
except (OSError, ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError) as error:
    print(f"backup Hospital: ROJO: {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"backup Hospital: OK local-only ({age:.1f}h, restauración aislada acreditada)")
PY
