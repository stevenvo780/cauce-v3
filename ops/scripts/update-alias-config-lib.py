"""Backup and causal-consumption machinery for update-alias-config.py.

Loaded by the entrypoint with importlib (hyphenated filename) and re-exported there,
so the entrypoint keeps its full module surface and CLI contract. Holds no CLI code.
"""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sys
import time

_scripts_dir = str(pathlib.Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from update_alias_lib import (  # noqa: E402  (sys.path.insert deliberado arriba)
    BACKUP_AUTH_KEY,
    BACKUP_AUTH_KEY_BYTES,
    BACKUP_CONSUMPTION_VERSION,
    BACKUP_RE,
    BACKUP_RECEIPT_SUFFIX,
    BACKUP_RECEIPT_VERSION,
    BACKUP_USED_SUFFIX,
    DIGEST_RE,
    ConfigUpdateError,
    ConsumptionJournal,
    EnvDocument,
    assert_private_regular,
    content_digest,
    file_identity,
    open_regular_at,
    parse_document,
    read_all,
    write_all,
)


def load_backup_auth_key(backups_fd: int, *, create: bool) -> bytes:
    while True:
        try:
            fd = open_regular_at(backups_fd, BACKUP_AUTH_KEY, os.O_RDONLY)
        except FileNotFoundError:
            if not create:
                raise ConfigUpdateError("el backup no tiene autenticacion emitida por el helper") from None
            candidate = secrets.token_bytes(BACKUP_AUTH_KEY_BYTES)
            try:
                fd = open_regular_at(
                    backups_fd,
                    BACKUP_AUTH_KEY,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    mode=0o600,
                )
            except FileExistsError:
                continue
            try:
                os.fchmod(fd, 0o600)
                write_all(fd, candidate)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(backups_fd)
            continue
        try:
            assert_private_regular(fd, "clave de autenticacion de backups")
            key = read_all(fd, "clave de autenticacion de backups")
        finally:
            os.close(fd)
        if len(key) != BACKUP_AUTH_KEY_BYTES:
            raise ConfigUpdateError("la clave de autenticacion de backups es invalida")
        return key


def backup_receipt(
    key: bytes, alias: str, name: str, body: bytes, successor_digest: str,
) -> bytes:
    """Authenticate a causal edge body -> successor rather than a free-standing snapshot."""
    if DIGEST_RE.fullmatch(successor_digest) is None:
        raise ConfigUpdateError("el sucesor del backup no es un digest valido")
    payload: dict[str, object] = {
        "schemaVersion": BACKUP_RECEIPT_VERSION,
        "alias": alias,
        "backup": name,
        "bodySha256": content_digest(body),
        "successorSha256": successor_digest,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    message = b"cauce-v3-config-backup-v2\0" + canonical + b"\0" + body
    payload["hmacSha256"] = hmac.new(key, message, hashlib.sha256).hexdigest()
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def create_backup(backups_fd: int, alias: str, body: bytes, successor_digest: str) -> str:
    key = load_backup_auth_key(backups_fd, create=True)
    digest_hex = content_digest(body).removeprefix("sha256:")
    for _ in range(8):
        name = f"{alias}.{digest_hex}.{time.time_ns()}.{secrets.token_hex(8)}.env"
        receipt_name = f"{name}{BACKUP_RECEIPT_SUFFIX}"
        body_created = False
        receipt_created = False
        try:
            fd = open_regular_at(
                backups_fd,
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                mode=0o600,
            )
        except FileExistsError:
            continue
        try:
            body_created = True
            os.fchmod(fd, 0o600)
            write_all(fd, body)
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            receipt_fd = open_regular_at(
                backups_fd,
                receipt_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                mode=0o600,
            )
            try:
                receipt_created = True
                os.fchmod(receipt_fd, 0o600)
                write_all(receipt_fd, backup_receipt(key, alias, name, body, successor_digest))
                os.fsync(receipt_fd)
            finally:
                os.close(receipt_fd)
            os.fsync(backups_fd)
            return name
        except BaseException:
            if receipt_created:
                os.unlink(receipt_name, dir_fd=backups_fd)
            if body_created:
                os.unlink(name, dir_fd=backups_fd)
            os.fsync(backups_fd)
            raise
    raise ConfigUpdateError("no se pudo reservar un nombre de backup unico")


def atomic_replace(config_root_fd: int, config_name: str, body: bytes, original: os.stat_result) -> None:
    temporary_name = f".{config_name}.cas-{os.getpid()}-{secrets.token_hex(8)}"
    temporary_fd: int | None = None
    try:
        temporary_fd = open_regular_at(
            config_root_fd,
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode=0o600,
        )
        os.fchown(temporary_fd, original.st_uid, original.st_gid)
        os.fchmod(temporary_fd, 0o600)
        write_all(temporary_fd, body)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None

        current_fd = open_regular_at(config_root_fd, config_name, os.O_RDONLY)
        try:
            current = assert_private_regular(current_fd, "configuracion del alias")
            if file_identity(current) != file_identity(original):
                raise ConfigUpdateError("compare-and-swap fallo: el fichero cambio durante la actualizacion")
        finally:
            os.close(current_fd)
        os.replace(
            temporary_name,
            config_name,
            src_dir_fd=config_root_fd,
            dst_dir_fd=config_root_fd,
        )
        os.fsync(config_root_fd)
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=config_root_fd)
        except FileNotFoundError:
            pass


def read_current(config_root_fd: int, alias: str) -> tuple[EnvDocument, os.stat_result]:
    fd = open_regular_at(config_root_fd, f"{alias}.env", os.O_RDONLY)
    try:
        details = assert_private_regular(fd, "configuracion del alias")
        body = read_all(fd, "configuracion del alias")
    finally:
        os.close(fd)
    return parse_document(body), details


def with_lock(config_root_fd: int, alias: str, exclusive: bool) -> int:
    lock_fd = open_regular_at(
        config_root_fd,
        f".{alias}.config.lock",
        os.O_RDWR | os.O_CREAT,
        mode=0o600,
    )
    assert_private_regular(lock_fd, "lock de configuracion")
    fcntl.flock(lock_fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
    return lock_fd


def parse_backup_receipt(
    receipt: bytes,
    key: bytes,
    alias: str,
    name: str,
    body: bytes,
    expected_successor_digest: str | None = None,
) -> str:
    try:
        document = json.loads(receipt.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ConfigUpdateError("el recibo causal del backup es invalido") from None
    expected_keys = {
        "schemaVersion", "alias", "backup", "bodySha256", "successorSha256", "hmacSha256",
    }
    if not isinstance(document, dict) or set(document) != expected_keys:
        raise ConfigUpdateError("el recibo causal del backup es invalido")
    supplied_mac = document.pop("hmacSha256")
    successor_digest = document.get("successorSha256")
    if (document.get("schemaVersion") != BACKUP_RECEIPT_VERSION
            or document.get("alias") != alias
            or document.get("backup") != name
            or document.get("bodySha256") != content_digest(body)
            or not isinstance(successor_digest, str)
            or DIGEST_RE.fullmatch(successor_digest) is None
            or (expected_successor_digest is not None
                and successor_digest != expected_successor_digest)
            or not isinstance(supplied_mac, str)
            or re.fullmatch(r"[a-f0-9]{64}", supplied_mac) is None):
        raise ConfigUpdateError("el backup no pertenece al estado sucesor actual")
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    message = b"cauce-v3-config-backup-v2\0" + canonical + b"\0" + body
    expected_mac = hmac.new(key, message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied_mac, expected_mac):
        raise ConfigUpdateError("la autenticacion del backup no coincide")
    return successor_digest


def consumption_journal_body(key: bytes, journal: ConsumptionJournal) -> bytes:
    payload: dict[str, object] = {
        "schemaVersion": BACKUP_CONSUMPTION_VERSION,
        "state": journal.state,
        "alias": journal.alias,
        "backup": journal.backup,
        "successorSha256": journal.successor_digest,
        "targetSha256": journal.target_digest,
        "replacementBackup": journal.replacement_backup,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    message = b"cauce-v3-config-consumption-v1\0" + canonical
    payload["hmacSha256"] = hmac.new(key, message, hashlib.sha256).hexdigest()
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def parse_consumption_journal(
    body: bytes, key: bytes, alias: str, name: str,
) -> ConsumptionJournal:
    if body == b"consumed\n":
        raise ConfigUpdateError("el backup causal ya fue consumido")
    try:
        document = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ConfigUpdateError("el journal de consumo del backup es invalido") from None
    expected_keys = {
        "schemaVersion", "state", "alias", "backup", "successorSha256", "targetSha256",
        "replacementBackup", "hmacSha256",
    }
    if not isinstance(document, dict) or set(document) != expected_keys:
        raise ConfigUpdateError("el journal de consumo del backup es invalido")
    supplied_mac = document.pop("hmacSha256")
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    expected_mac = hmac.new(
        key, b"cauce-v3-config-consumption-v1\0" + canonical, hashlib.sha256,
    ).hexdigest()
    successor_digest = document.get("successorSha256")
    target_digest = document.get("targetSha256")
    replacement_backup = document.get("replacementBackup")
    replacement_match = (
        BACKUP_RE.fullmatch(replacement_backup) if isinstance(replacement_backup, str) else None
    )
    if (document.get("schemaVersion") != BACKUP_CONSUMPTION_VERSION
            or document.get("state") not in ("pending", "committed")
            or document.get("alias") != alias
            or document.get("backup") != name
            or not isinstance(successor_digest, str)
            or DIGEST_RE.fullmatch(successor_digest) is None
            or not isinstance(target_digest, str)
            or DIGEST_RE.fullmatch(target_digest) is None
            or replacement_match is None
            or replacement_match.group("alias") != alias
            or replacement_backup == name
            or not isinstance(supplied_mac, str)
            or re.fullmatch(r"[a-f0-9]{64}", supplied_mac) is None
            or not hmac.compare_digest(supplied_mac, expected_mac)):
        raise ConfigUpdateError("el journal de consumo del backup es invalido")
    return ConsumptionJournal(
        state=document["state"],
        alias=alias,
        backup=name,
        successor_digest=successor_digest,
        target_digest=target_digest,
        replacement_backup=replacement_backup,
    )


def read_consumption_journal(
    backups_fd: int, key: bytes, alias: str, name: str,
) -> ConsumptionJournal | None:
    journal_name = f"{name}{BACKUP_RECEIPT_SUFFIX}{BACKUP_USED_SUFFIX}"
    try:
        journal_fd = open_regular_at(backups_fd, journal_name, os.O_RDONLY)
    except FileNotFoundError:
        return None
    try:
        assert_private_regular(journal_fd, "journal de consumo del backup")
        body = read_all(journal_fd, "journal de consumo del backup")
    finally:
        os.close(journal_fd)
    return parse_consumption_journal(body, key, alias, name)


def write_consumption_journal(
    backups_fd: int,
    key: bytes,
    journal: ConsumptionJournal,
    *,
    create: bool,
) -> None:
    journal_name = f"{journal.backup}{BACKUP_RECEIPT_SUFFIX}{BACKUP_USED_SUFFIX}"
    temporary_name = f".{journal_name}.cas-{os.getpid()}-{secrets.token_hex(8)}"
    temporary_fd: int | None = None
    try:
        temporary_fd = open_regular_at(
            backups_fd,
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode=0o600,
        )
        os.fchmod(temporary_fd, 0o600)
        write_all(temporary_fd, consumption_journal_body(key, journal))
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        if create:
            try:
                os.stat(journal_name, dir_fd=backups_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ConfigUpdateError("el journal de consumo ya existe")
            os.replace(
                temporary_name,
                journal_name,
                src_dir_fd=backups_fd,
                dst_dir_fd=backups_fd,
            )
            os.fsync(backups_fd)
        else:
            current_fd = open_regular_at(backups_fd, journal_name, os.O_RDONLY)
            try:
                assert_private_regular(current_fd, "journal de consumo del backup")
            finally:
                os.close(current_fd)
            os.replace(
                temporary_name,
                journal_name,
                src_dir_fd=backups_fd,
                dst_dir_fd=backups_fd,
            )
            os.fsync(backups_fd)
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=backups_fd)
        except FileNotFoundError:
            pass


def read_backup(backups_fd: int, alias: str, name: str) -> tuple[EnvDocument, str]:
    matched = BACKUP_RE.fullmatch(name)
    if matched is None or matched.group("alias") != alias:
        raise ConfigUpdateError("el nombre de backup no pertenece al alias")
    fd = open_regular_at(backups_fd, name, os.O_RDONLY)
    try:
        assert_private_regular(fd, "backup del alias")
        body = read_all(fd, "backup del alias")
    finally:
        os.close(fd)
    expected_hex = name.split(".", 2)[1]
    if content_digest(body) != f"sha256:{expected_hex}":
        raise ConfigUpdateError("el backup no coincide con el digest de su nombre")
    key = load_backup_auth_key(backups_fd, create=False)
    try:
        receipt_fd = open_regular_at(backups_fd, f"{name}{BACKUP_RECEIPT_SUFFIX}", os.O_RDONLY)
    except FileNotFoundError:
        raise ConfigUpdateError("el backup no tiene autenticacion emitida por el helper") from None
    try:
        assert_private_regular(receipt_fd, "recibo de autenticacion del backup")
        receipt = read_all(receipt_fd, "recibo de autenticacion del backup")
    finally:
        os.close(receipt_fd)
    successor_digest = parse_backup_receipt(receipt, key, alias, name, body)
    return parse_document(body, "backup del alias"), successor_digest


def validate_pending_consumption(
    backups_fd: int,
    journal: ConsumptionJournal,
    *,
    successor_digest: str,
    target_digest: str,
) -> None:
    if (journal.successor_digest != successor_digest
            or journal.target_digest != target_digest):
        raise ConfigUpdateError("el journal de consumo no coincide con la reversa solicitada")
    replacement_document, replacement_successor = read_backup(
        backups_fd, journal.alias, journal.replacement_backup,
    )
    if (content_digest(replacement_document.body) != successor_digest
            or replacement_successor != target_digest):
        raise ConfigUpdateError("el journal de consumo no conserva una reversa autenticada")
