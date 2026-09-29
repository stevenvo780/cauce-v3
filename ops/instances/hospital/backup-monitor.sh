#!/usr/bin/env bash
set -euo pipefail

STATUS_FILE=${STATUS_FILE:-/var/backups/cauce-v3-hospital/status.json}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-24}
REQUIRE_BLOB_VOLUME=${REQUIRE_BLOB_VOLUME:-0}

python3 - "$STATUS_FILE" "$MAX_AGE_HOURS" "$REQUIRE_BLOB_VOLUME" <<'PY'
from pathlib import Path
import datetime
import hashlib
import json
import math
import os
import re
import stat
import sys
import tarfile

status_path = Path(sys.argv[1])
try:
    maximum_age = float(sys.argv[2])
except ValueError as error:
    raise SystemExit("backup Hospital: MAX_AGE_HOURS inválido") from error
if not math.isfinite(maximum_age) or maximum_age <= 0:
    raise SystemExit("backup Hospital: MAX_AGE_HOURS inválido")
if sys.argv[3] not in {"0", "1"}:
    raise SystemExit("backup Hospital: REQUIRE_BLOB_VOLUME inválido")
require_blob_volume = sys.argv[3] == "1"


def open_private(
    path: Path, label: str, maximum: int | None = None, minimum: int = 1
) -> tuple[int, os.stat_result]:
    if not path.is_absolute() or path.is_symlink():
        raise ValueError(f"{label} no es un archivo absoluto seguro")
    metadata = path.stat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size < minimum
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


def private_file(path: Path, label: str, maximum: int | None = None, minimum: int = 1) -> bytes:
    descriptor, opened = open_private(path, label, maximum, minimum)
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


def verified_blobs(archive_path: Path, manifest_bytes: bytes) -> tuple[int, int, int]:
    if manifest_bytes and not manifest_bytes.endswith(b"\n"):
        raise ValueError("manifiesto de blobs incompleto")
    rows = {}
    for line in manifest_bytes.decode("ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})\t([1-9][0-9]*)", line)
        if match is None or match.group(1) in rows:
            raise ValueError("manifiesto de blobs inválido")
        rows[match.group(1)] = int(match.group(2))

    found = set()
    descriptor, opened = open_private(archive_path, "archivo de blobs")
    with os.fdopen(descriptor, "rb") as source:
        with tarfile.open(fileobj=source, mode="r|") as archive:
            for member in archive:
                if member.isdir() and member.name in {".", "./"}:
                    continue
                match = re.fullmatch(r"\./([a-f0-9]{64})", member.name)
                if not member.isfile() or match is None or match.group(1) in found:
                    raise ValueError("archivo de blobs contiene una entrada insegura")
                digest = match.group(1)
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError("no pude leer un blob archivado")
                hasher = hashlib.sha256()
                size = 0
                while block := stream.read(1024 * 1024):
                    hasher.update(block)
                    size += len(block)
                if hasher.hexdigest() != digest or size < 1 or (digest in rows and size != rows[digest]):
                    raise ValueError("blob archivado no coincide con digest o tamaño restaurado")
                found.add(digest)
        final_opened = os.fstat(source.fileno())
        final_named = archive_path.stat()
        if (final_named.st_dev, final_named.st_ino, final_named.st_size, final_named.st_mtime_ns) != (
            final_opened.st_dev, final_opened.st_ino, final_opened.st_size, final_opened.st_mtime_ns,
        ) or (opened.st_size, opened.st_mtime_ns) != (final_opened.st_size, final_opened.st_mtime_ns):
            raise ValueError("archivo de blobs cambió durante la lectura")
    if not rows.keys() <= found:
        raise ValueError("faltan blobs de la base restaurada")
    return len(rows), sum(rows.values()), len(found)


try:
    status = json.loads(private_file(status_path, "status", 16_384).decode("utf-8"))
    if status.get("schema_version") != 2 or status.get("overall") != "ok":
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
    blob_archive = Path(status["blob_archive_file"])
    blob_manifest = Path(status["blob_manifest_file"])
    if blob_archive != Path(f"{dump}.blobs.tar") or blob_manifest != Path(f"{dump}.blobs.tsv"):
        raise ValueError("archivo o manifiesto de blobs fuera del backup Hospital")
    blob_digest = private_sha256(blob_archive, "archivo de blobs")
    if blob_digest != status.get("blob_archive_sha256"):
        raise ValueError("digest del archivo de blobs no coincide")
    blob_sidecar = private_file(Path(f"{blob_archive}.sha256"), "checksum de blobs", 1024).decode("ascii")
    if blob_sidecar != f"{blob_digest}  {blob_archive.name}\n":
        raise ValueError("sidecar de blobs no coincide")
    manifest_bytes = private_file(blob_manifest, "manifiesto de blobs", 268_435_456, minimum=0)
    manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
    if manifest_digest != status.get("blob_manifest_sha256"):
        raise ValueError("digest del manifiesto de blobs no coincide")
    blob_rows, blob_bytes, archived_blobs = verified_blobs(blob_archive, manifest_bytes)
    evidence_path = Path(status["restore_evidence_file"])
    if evidence_path != Path(f"{dump}.restore.json"):
        raise ValueError("evidencia no corresponde al dump")
    evidence = json.loads(private_file(evidence_path, "evidencia", 16_384).decode("utf-8"))
    if (
        evidence.get("schema_version") != 2
        or evidence.get("suite") != "hospital-cauce-backup-restore"
        or evidence.get("dump_file") != dump.name
        or evidence.get("dump_sha256") != digest
        or evidence.get("blob_archive_file") != blob_archive.name
        or evidence.get("blob_archive_sha256") != blob_digest
        or evidence.get("blob_manifest_file") != blob_manifest.name
        or evidence.get("blob_manifest_sha256") != manifest_digest
        or evidence.get("blob_volume") != "hospital-cauce_blobs_data"
        or evidence.get("blob_row_count") != blob_rows
        or evidence.get("blob_row_bytes") != blob_bytes
        or evidence.get("archived_blob_count") != archived_blobs
        or not isinstance(evidence.get("blob_table_present"), bool)
        or not isinstance(evidence.get("blob_volume_present"), bool)
        or (evidence["blob_table_present"] and not evidence["blob_volume_present"])
        or (not evidence["blob_table_present"] and blob_rows != 0)
        or (not evidence["blob_volume_present"] and archived_blobs != 0)
        or evidence.get("blob_restore_verified") is not True
        or evidence.get("blob_restore_uid") != 1000
        or evidence.get("blob_restore_network") != "none"
        or evidence.get("blob_restore_row_count") != blob_rows
        or evidence.get("isolated") is not True
        or evidence.get("network") != "none"
        or evidence.get("full_restore") is not True
        or evidence.get("tenant_count") != 1
        or evidence.get("room_count") != 1
        or evidence.get("agent_count") != 3
        or evidence.get("profile_count") != 3
        or evidence.get("membership_count") != 4
        or evidence.get("acl_edge_count") != 0
        or evidence.get("agent_topology") != "operador:hospital-lider:operator,perseo:hospital-praxis-developer:agent,teseo:hospital-praxis-developer:agent"
        or not isinstance(evidence.get("migration_count"), int)
        or evidence["migration_count"] < 1
    ):
        raise ValueError("evidencia de restauración incompleta")
    if require_blob_volume and not (evidence["blob_table_present"] and evidence["blob_volume_present"]):
        raise ValueError("falta backup verificado de tabla y volumen de blobs posteriores a 042")
except (OSError, ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError, tarfile.TarError) as error:
    print(f"backup Hospital: ROJO: {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"backup Hospital: OK local-only ({age:.1f}h, restauración aislada, {blob_rows} blobs verificados)")
PY
