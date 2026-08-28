#!/usr/bin/env python3
"""Actualiza un ``<alias>.env`` de forma atomica, reversible y con CAS.

Los ficheros de configuracion de los adaptadores se consideran privados aunque hoy no deban
contener secretos. Esta herramienta nunca escribe valores en stdout/stderr: solo alias, digests,
nombres de claves y el nombre opaco del backup. Los cambios se serializan con ``flock``, comparan
el digest esperado bajo el lock, respaldan los bytes anteriores con modo 0600 y publican mediante
``fsync`` + ``rename`` + ``fsync`` del directorio.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import stat
import sys
import time
from dataclasses import replace

_scripts_dir = str(pathlib.Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from update_alias_lib import (
    ALIAS_RE,
    BACKUP_AUTH_KEY,
    BACKUP_AUTH_KEY_BYTES,
    BACKUP_CONSUMPTION_VERSION,
    BACKUP_RE,
    BACKUP_RECEIPT_SUFFIX,
    BACKUP_RECEIPT_VERSION,
    BACKUP_USED_SUFFIX,
    DIGEST_RE,
    KEY_RE,
    AliasPolicy,
    ConfigUpdateError,
    ConsumptionJournal,
    EnvDocument,
    SafeArgumentParser,
    assert_private_regular,
    assert_secure_directory,
    content_digest,
    ensure_backups_directory,
    file_identity,
    load_inventory,
    open_absolute_directory,
    open_regular_at,
    parse_document,
    parse_sets,
    read_all,
    render_update,
    validate_absolute,
    validate_restore_policy,
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


def require_enabled_fleet_alias(flota_json: pathlib.Path, alias: str) -> None:
    """Same allowlist provision-agent-identity.sh / issue-alias-token.py enforce: fleet[alias].enabled."""
    try:
        fd = os.open(flota_json, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise ConfigUpdateError("no se pudo leer el snapshot de flota (ops/flota.json)") from None
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o022:
            raise ConfigUpdateError(
                "el snapshot de flota debe ser regular y no escribible por grupo u otros"
            )
        body = read_all(fd, "snapshot de flota")
    finally:
        os.close(fd)
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ConfigUpdateError("el snapshot de flota no es JSON valido") from None
    fleet = document.get("fleet") if isinstance(document, dict) else None
    entry = fleet.get(alias) if isinstance(fleet, dict) else None
    if not isinstance(entry, dict) or entry.get("enabled") is not True:
        raise ConfigUpdateError("el alias no esta habilitado en el snapshot de flota (ops/flota.json)")


def read_source_file(root: pathlib.Path, name: str, missing_message: str) -> bytes:
    """Read a small non-secret source file (cert/example) with the same no-follow discipline
    as the rest of this tool, collapsing every way it can be absent into one clear message."""
    try:
        root_fd = open_absolute_directory(root, "raiz de origen")
    except OSError:
        raise ConfigUpdateError(missing_message) from None
    try:
        try:
            fd = open_regular_at(root_fd, name, os.O_RDONLY)
        except OSError:
            raise ConfigUpdateError(missing_message) from None
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ConfigUpdateError(missing_message)
            return read_all(fd, name)
        finally:
            os.close(fd)
    finally:
        os.close(root_fd)


def ensure_root_directory(path: pathlib.Path, label: str) -> None:
    validate_absolute(path, label)
    if path.is_symlink():
        raise ConfigUpdateError(f"{label} no puede ser un symlink")
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def publish_created_file(directory_fd: int, name: str, body: bytes, mode: int) -> None:
    """Create-only publish: never overwrites, rolls itself back on any failed write."""
    try:
        fd = open_regular_at(directory_fd, name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode=mode)
    except FileExistsError:
        raise ConfigUpdateError(f"{name} ya existe; nada fue sobrescrito") from None
    published = False
    try:
        os.fchmod(fd, mode)
        write_all(fd, body)
        os.fsync(fd)
        published = True
    finally:
        os.close(fd)
        if not published:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass


def init_alias(
    config_root: pathlib.Path,
    pki_root: pathlib.Path,
    agent_pki_root: pathlib.Path,
    flota_json: pathlib.Path,
    examples_root: pathlib.Path,
    alias: str,
    *,
    dry_run: bool,
) -> dict[str, object]:
    """Create a brand-new alias's container-pki/<alias>/{ca.crt,client.crt,client.key} and
    <alias>.env. Every file is create-only (never overwrites). The pki trio is all-or-nothing
    within itself (a failed file rolls back the whole trio), and so is the env file, but the two
    pieces are independent: a finished piece is never undone by the other piece failing, so a
    retry after a genuine mid-way fault only has to finish the piece that did not land."""
    require_enabled_fleet_alias(flota_json, alias)

    example_body = read_source_file(
        examples_root,
        f"{alias}.env.example",
        f"falta el ejemplo generado para {alias}; corre generate-container-units.py primero",
    )
    identity_missing = f"falta la identidad mTLS de {alias}: corre provision-agent-identity primero"
    ca_body = read_source_file(
        agent_pki_root, "ca.crt", "falta la CA de la flota; aprovisiona la CA antes de continuar",
    )
    leaf_cert_body = read_source_file(agent_pki_root, f"agent-{alias}.crt", identity_missing)
    leaf_key_body = read_source_file(agent_pki_root, f"agent-{alias}.key", identity_missing)

    pki_target = pki_root / alias
    env_target = config_root / f"{alias}.env"

    if dry_run:
        return {
            "status": "dry-run",
            "alias": alias,
            "pkiDir": str(pki_target),
            "configFile": str(env_target),
            "pkiDirConflict": pki_target.is_symlink() or pki_target.exists(),
            "configFileConflict": env_target.is_symlink() or env_target.exists(),
        }

    ensure_root_directory(pki_root, "raiz de container-pki")
    ensure_root_directory(config_root, "raiz de configuracion")

    pki_root_fd = open_absolute_directory(pki_root, "raiz de container-pki")
    created_pki_dir = False
    try:
        assert_secure_directory(pki_root_fd, "raiz de container-pki")
        try:
            os.mkdir(alias, 0o700, dir_fd=pki_root_fd)
        except FileExistsError:
            raise ConfigUpdateError(f"container-pki/{alias} ya existe; nada fue sobrescrito") from None
        created_pki_dir = True

        alias_pki_fd = os.open(
            alias, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=pki_root_fd,
        )
        try:
            assert_secure_directory(alias_pki_fd, f"container-pki/{alias}", 0o700)
            for name, body in (
                ("ca.crt", ca_body), ("client.crt", leaf_cert_body), ("client.key", leaf_key_body),
            ):
                publish_created_file(alias_pki_fd, name, body, 0o600)
            os.fsync(alias_pki_fd)
        finally:
            os.close(alias_pki_fd)
        os.fsync(pki_root_fd)
    except BaseException:
        if created_pki_dir:
            for name in ("ca.crt", "client.crt", "client.key"):
                try:
                    os.unlink(f"{alias}/{name}", dir_fd=pki_root_fd)
                except FileNotFoundError:
                    pass
            try:
                os.rmdir(alias, dir_fd=pki_root_fd)
            except OSError:
                pass
        os.close(pki_root_fd)
        raise
    os.close(pki_root_fd)

    config_root_fd = open_absolute_directory(config_root, "raiz de configuracion")
    try:
        assert_secure_directory(config_root_fd, "raiz de configuracion")
        publish_created_file(config_root_fd, f"{alias}.env", example_body, 0o600)
        os.fsync(config_root_fd)
    finally:
        os.close(config_root_fd)

    return {
        "status": "created",
        "alias": alias,
        "pkiDir": str(pki_target),
        "configFile": str(env_target),
    }


def inspect(config_root: pathlib.Path, alias: str) -> dict[str, object]:
    root_fd = open_absolute_directory(config_root, "raiz de configuracion")
    try:
        assert_secure_directory(root_fd, "raiz de configuracion")
        lock_fd = with_lock(root_fd, alias, exclusive=False)
        try:
            current, _ = read_current(root_fd, alias)
            return {"status": "ok", "alias": alias, "digest": content_digest(current.body)}
        finally:
            os.close(lock_fd)
    finally:
        os.close(root_fd)


def mutate(
    config_root: pathlib.Path,
    pki_root: pathlib.Path,
    policy: AliasPolicy,
    expected_digest: str,
    *,
    updates: dict[str, str] | None = None,
    unsets: frozenset[str] = frozenset(),
    backup_name: str | None = None,
) -> dict[str, object]:
    if DIGEST_RE.fullmatch(expected_digest) is None:
        raise ConfigUpdateError("expected-old-digest debe ser un digest sha256 exacto")
    root_fd = open_absolute_directory(config_root, "raiz de configuracion")
    try:
        assert_secure_directory(root_fd, "raiz de configuracion")
        lock_fd = with_lock(root_fd, policy.alias, exclusive=True)
        try:
            current, current_stat = read_current(root_fd, policy.alias)
            old_digest = content_digest(current.body)
            if old_digest != expected_digest:
                raise ConfigUpdateError("compare-and-swap fallo: el digest anterior cambio")

            removed: list[str] = []
            if backup_name is None:
                target, removed = render_update(current, policy, pki_root, updates or {}, unsets)
                if target.body == current.body:
                    return {
                        "status": "unchanged",
                        "alias": policy.alias,
                        "oldDigest": old_digest,
                        "newDigest": old_digest,
                        "backup": None,
                        "removedKeys": removed,
                    }
                backups_fd = ensure_backups_directory(root_fd)
                try:
                    created_backup = create_backup(
                        backups_fd,
                        policy.alias,
                        current.body,
                        content_digest(target.body),
                    )
                finally:
                    os.close(backups_fd)
                atomic_replace(root_fd, f"{policy.alias}.env", target.body, current_stat)
                return {
                    "status": "updated",
                    "alias": policy.alias,
                    "oldDigest": old_digest,
                    "newDigest": content_digest(target.body),
                    "backup": created_backup,
                    "removedKeys": removed,
                }

            backups_fd = ensure_backups_directory(root_fd)
            try:
                target, successor_digest = read_backup(backups_fd, policy.alias, backup_name)
                validate_restore_policy(target, policy, pki_root)
                target_digest = content_digest(target.body)
                if target_digest == successor_digest:
                    raise ConfigUpdateError("el recibo causal del backup no describe una mutacion")
                key = load_backup_auth_key(backups_fd, create=False)
                journal = read_consumption_journal(
                    backups_fd, key, policy.alias, backup_name,
                )
                if journal is None:
                    if old_digest != successor_digest:
                        raise ConfigUpdateError("el backup no pertenece al estado sucesor actual")
                    created_backup = create_backup(
                        backups_fd,
                        policy.alias,
                        current.body,
                        target_digest,
                    )
                    journal = ConsumptionJournal(
                        state="pending",
                        alias=policy.alias,
                        backup=backup_name,
                        successor_digest=successor_digest,
                        target_digest=target_digest,
                        replacement_backup=created_backup,
                    )
                    write_consumption_journal(backups_fd, key, journal, create=True)
                else:
                    if journal.state == "committed":
                        raise ConfigUpdateError("el backup causal ya fue consumido")
                    validate_pending_consumption(
                        backups_fd,
                        journal,
                        successor_digest=successor_digest,
                        target_digest=target_digest,
                    )
                    created_backup = journal.replacement_backup
                    if old_digest == target_digest:
                        write_consumption_journal(
                            backups_fd, key, replace(journal, state="committed"), create=False,
                        )
                        return {
                            "status": "unchanged",
                            "alias": policy.alias,
                            "oldDigest": old_digest,
                            "newDigest": target_digest,
                            "backup": created_backup,
                            "removedKeys": removed,
                        }
                    if old_digest != successor_digest:
                        raise ConfigUpdateError(
                            "el journal de consumo no coincide con el estado actual"
                        )
            finally:
                os.close(backups_fd)

            atomic_replace(root_fd, f"{policy.alias}.env", target.body, current_stat)
            backups_fd = ensure_backups_directory(root_fd)
            try:
                durable_journal = read_consumption_journal(
                    backups_fd, key, policy.alias, backup_name,
                )
                if durable_journal != journal or durable_journal.state != "pending":
                    raise ConfigUpdateError("el journal de consumo cambio durante la publicacion")
                write_consumption_journal(
                    backups_fd, key, replace(journal, state="committed"), create=False,
                )
            finally:
                os.close(backups_fd)
            return {
                "status": "updated",
                "alias": policy.alias,
                "oldDigest": old_digest,
                "newDigest": target_digest,
                "backup": created_backup,
                "removedKeys": removed,
            }
        finally:
            os.close(lock_fd)
    finally:
        os.close(root_fd)


def defaults() -> tuple[
    pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path,
]:
    ops_root = pathlib.Path(__file__).resolve().parents[1]
    inventory = ops_root / "container-aliases.json"
    hermes_runtime = ops_root / "hermes-runtime.json"
    flota = ops_root / "flota.json"
    generated_root = ops_root / "generated" / "container-systemd"
    if os.geteuid() == 0:
        config_root = pathlib.Path("/etc/cauce-v3/container-aliases")
        pki_root = pathlib.Path("/etc/cauce-v3/container-pki")
        agent_pki_root = pathlib.Path("/etc/cauce-v3/pki")
        examples_root = generated_root / "configs"
    else:
        config_home = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config"))
        config_root = config_home / "cauce-v3/container-aliases"
        pki_root = config_home / "cauce-v3/container-pki"
        agent_pki_root = config_home / "cauce-v3/pki"
        examples_root = generated_root / "rootless" / "configs"
    return inventory, hermes_runtime, flota, config_root, pki_root, agent_pki_root, examples_root


def parser() -> SafeArgumentParser:
    inventory, hermes_runtime, flota, config_root, pki_root, agent_pki_root, examples_root = defaults()
    root = SafeArgumentParser(description="Actualizacion CAS de configs Cauce por alias")
    root.add_argument("--inventory", type=pathlib.Path, default=inventory)
    root.add_argument("--hermes-runtime", type=pathlib.Path, default=hermes_runtime)
    root.add_argument("--config-root", type=pathlib.Path, default=config_root)
    root.add_argument("--pki-root", type=pathlib.Path, default=pki_root)
    actions = root.add_subparsers(
        dest="action", required=True, parser_class=SafeArgumentParser
    )
    for action in ("inspect", "apply", "restore", "init"):
        command = actions.add_parser(action)
        command.add_argument("--alias", required=True)
        if action not in ("inspect", "init"):
            command.add_argument("--expected-old-digest", required=True)
        if action == "apply":
            command.add_argument("--set", action="append", default=[])
            command.add_argument("--unset", action="append", default=[])
        if action == "restore":
            command.add_argument("--backup", required=True)
        if action == "init":
            # --config-root also exists on the root parser; SUPPRESS here means an operator who
            # omits it keeps that inherited default instead of this subparser silently blanking it.
            command.add_argument("--config-root", type=pathlib.Path, default=argparse.SUPPRESS)
            command.add_argument("--flota-json", type=pathlib.Path, default=flota)
            command.add_argument("--agent-pki-root", type=pathlib.Path, default=agent_pki_root)
            command.add_argument("--examples-root", type=pathlib.Path, default=examples_root)
            command.add_argument("--dry-run", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    alias = arguments.alias
    if ALIAS_RE.fullmatch(alias) is None:
        raise ConfigUpdateError("el alias tiene formato invalido")
    if arguments.action == "init":
        result = init_alias(
            arguments.config_root,
            arguments.pki_root,
            arguments.agent_pki_root,
            arguments.flota_json,
            arguments.examples_root,
            alias,
            dry_run=arguments.dry_run,
        )
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    policy = load_inventory(arguments.inventory, alias, arguments.hermes_runtime)
    if arguments.action == "inspect":
        result = inspect(arguments.config_root, alias)
    elif arguments.action == "apply":
        updates = parse_sets(arguments.set)
        unsets = frozenset(arguments.unset)
        if any(KEY_RE.fullmatch(key) is None for key in unsets):
            raise ConfigUpdateError("una clave --unset tiene formato invalido")
        overlap = sorted(frozenset(updates) & unsets)
        if overlap:
            raise ConfigUpdateError(
                "una clave no puede aparecer a la vez en --set y --unset: " + ",".join(overlap)
            )
        result = mutate(
            arguments.config_root,
            arguments.pki_root,
            policy,
            arguments.expected_old_digest,
            updates=updates,
            unsets=unsets,
        )
    else:
        result = mutate(
            arguments.config_root,
            arguments.pki_root,
            policy,
            arguments.expected_old_digest,
            backup_name=arguments.backup,
        )
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigUpdateError as error:
        print(f"config update failed: {error}", file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print("config update failed: error operacional no divulgado", file=sys.stderr)
        raise SystemExit(2) from None
