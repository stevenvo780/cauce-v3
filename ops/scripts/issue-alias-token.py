#!/usr/bin/env python3
"""Issue a bearer-token identity for one enabled fleet agent (provisioning piece 2 of 5).

Publishes ``<alias>.token`` (mode 0400, created once, never overwritten) under --tokens-dir and
appends its SHA-256 digest as a new record to ``token_hashes.json`` under --identities-dir,
serialized with flock and published via tmp-file + fsync + rename (the file is never edited
in place, matching the CAS pattern in update_alias_lib.py / update-alias-config.py).

``mtls_identities.json`` lives in the same --identities-dir but its records are keyed by
``certificate_sha256``, the fingerprint of an X.509 leaf this script never sees (that material
belongs to provision-agent-identity.sh and register-agent-identity.py). This script therefore
only ever touches token_hashes.json and ``<alias>.token``.

``--revoke`` reverses the above for one alias: it removes every token_hashes.json record whose
principal alias matches (fail-closed — the gateway trusts whatever hashes remain in the file, so
an unrecognized "revoked" flag would keep granting access) and deletes ``<alias>.token``. Both
sides are idempotent: nothing to remove is success, not an error.
"""

from __future__ import annotations

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys

_scripts_dir = str(pathlib.Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from update_alias_lib import (  # noqa: E402  (sys.path shim above must run first)
    assert_secure_directory,
    open_absolute_directory,
    open_regular_at,
    publish_json_document_cas,
    read_all,
    validate_absolute,
    write_all,
)

ALIAS_RE = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")  # packages/protocol/src/schemas/core.ts AliasSchema
TENANT_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")  # ...TenantSchema
TOKEN_HASHES_FILE = "token_hashes.json"
TOKEN_FILE_MODE = 0o400
IDENTITY_FILE_MODE = 0o400
IDENTITY_SCHEMA_VERSION = 1
DEFAULT_TTL_DAYS = 730  # matches the mTLS leaf validity issued by provision-agent-identity.sh


class IssueTokenError(RuntimeError):
    """Expected failure; message is guaranteed to never contain the token or its digest."""


def load_enabled_tenant(flota_path: pathlib.Path, alias: str) -> str:
    """Enforce the allowlist: only an alias enabled in the fleet snapshot may get a token."""
    try:
        fd = os.open(flota_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        raise IssueTokenError(f"no se pudo abrir el snapshot de flota: {flota_path}") from error
    try:
        raw = read_all(fd, "snapshot de flota")
    finally:
        os.close(fd)
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise IssueTokenError("el snapshot de flota no es JSON valido") from error
    fleet = document.get("fleet") if isinstance(document, dict) else None
    entry = fleet.get(alias) if isinstance(fleet, dict) else None
    if not isinstance(entry, dict) or entry.get("enabled") is not True:
        raise IssueTokenError(f"el alias {alias!r} no esta habilitado en el snapshot de flota")
    tenant = entry.get("tenant")
    if not isinstance(tenant, str) or TENANT_RE.fullmatch(tenant) is None:
        raise IssueTokenError("el snapshot de flota declara un tenant invalido para el alias")
    return tenant


def build_principal(tenant: str, alias: str) -> dict[str, object]:
    # Mirrors the adapter-channel identities already issued for agents in mtls_identities.json
    # (e.g. jarvis, kant): same channel/roles/permissions, this is just the bearer-token twin.
    return {
        "tenant_id": tenant,
        "alias": alias,
        "session_id": f"adapter-{alias}",
        "channel": "adapter",
        "roles": ["adapter"],
        "permissions": ["route", "read"],
    }


def assert_readonly_regular(fd: int, label: str) -> os.stat_result:
    details = os.fstat(fd)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or (os.geteuid() != 0 and details.st_uid != os.geteuid())
        or stat.S_IMODE(details.st_mode) != IDENTITY_FILE_MODE
    ):
        raise IssueTokenError(
            f"{label} debe ser un fichero regular de un enlace, del usuario efectivo y modo 0400"
        )
    return details


def read_identity_document(identities_fd: int) -> tuple[dict[str, object], os.stat_result | None]:
    try:
        fd = open_regular_at(identities_fd, TOKEN_HASHES_FILE, os.O_RDONLY)
    except FileNotFoundError:
        return {"version": IDENTITY_SCHEMA_VERSION, "identities": []}, None
    try:
        details = assert_readonly_regular(fd, TOKEN_HASHES_FILE)
        body = read_all(fd, TOKEN_HASHES_FILE)
    finally:
        os.close(fd)
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise IssueTokenError(f"{TOKEN_HASHES_FILE} no es JSON valido") from error
    if (
        not isinstance(document, dict)
        or document.get("version") != IDENTITY_SCHEMA_VERSION
        or not isinstance(document.get("identities"), list)
    ):
        raise IssueTokenError(f"{TOKEN_HASHES_FILE} no respeta el formato version 1 / identities[]")
    return document, details


def reject_existing_alias(document: dict[str, object], tenant: str, alias: str) -> None:
    for record in document["identities"]:  # type: ignore[index]
        principal = record.get("principal") if isinstance(record, dict) else None
        if isinstance(principal, dict) and principal.get("tenant_id") == tenant and principal.get("alias") == alias:
            raise IssueTokenError(
                f"ya existe una identidad de token para {tenant}:{alias}; revocarla antes de reemitir"
            )


def publish_identity_document(
    identities_fd: int, lock_fd: int, document: dict[str, object], original: os.stat_result | None,
) -> None:
    publish_json_document_cas(
        identities_fd,
        lock_fd,
        TOKEN_HASHES_FILE,
        document,
        original,
        mode=IDENTITY_FILE_MODE,
        error_type=IssueTokenError,
        operation="la emision",
    )


def publish_token_file(tokens_fd: int, alias: str, token_hex: str) -> None:
    name = f"{alias}.token"
    try:
        fd = open_regular_at(tokens_fd, name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode=TOKEN_FILE_MODE)
    except FileExistsError as error:
        raise IssueTokenError(f"{name} ya existe; nada fue sobrescrito (revocar y reemitir explicitamente)") from error
    published = False
    try:
        os.fchmod(fd, TOKEN_FILE_MODE)
        write_all(fd, (token_hex + "\n").encode("ascii"))
        os.fsync(fd)
        published = True
    finally:
        os.close(fd)
        if not published:
            try:
                os.unlink(name, dir_fd=tokens_fd)
            except FileNotFoundError:
                pass


def remove_token_file(tokens_dir: pathlib.Path, alias: str) -> bool:
    """Atomically unlinks <alias>.token if present. Returns whether it existed."""
    try:
        tokens_fd = open_absolute_directory(tokens_dir, "directorio de tokens")
    except FileNotFoundError:
        return False
    try:
        os.unlink(f"{alias}.token", dir_fd=tokens_fd)
        return True
    except FileNotFoundError:
        return False
    finally:
        os.close(tokens_fd)


def revoke(alias: str, tokens_dir: pathlib.Path, identities_dir: pathlib.Path) -> dict[str, object]:
    if ALIAS_RE.fullmatch(alias) is None:
        raise IssueTokenError("el alias tiene formato invalido")
    validate_absolute(tokens_dir, "directorio de tokens")
    validate_absolute(identities_dir, "directorio de identidades")

    identities_removed = 0
    identities_fd = open_absolute_directory(identities_dir, "directorio de identidades")
    try:
        assert_secure_directory(identities_fd, "directorio de identidades")
        lock_fd = open_regular_at(
            identities_fd, f".{TOKEN_HASHES_FILE}.lock", os.O_RDWR | os.O_CREAT, mode=0o600,
        )
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            document, original = read_identity_document(identities_fd)
            kept: list[object] = []
            for record in document["identities"]:  # type: ignore[union-attr]
                principal = record.get("principal") if isinstance(record, dict) else None
                if isinstance(principal, dict) and principal.get("alias") == alias:
                    identities_removed += 1
                    continue
                kept.append(record)
            # Only publish (and take the CAS/fsync cost) when something actually changed.
            if identities_removed:
                document["identities"] = kept  # type: ignore[index]
                publish_identity_document(identities_fd, lock_fd, document, original)
        finally:
            os.close(lock_fd)
    finally:
        os.close(identities_fd)

    # Hash removal above is what the gateway actually enforces; the raw token file is deleted
    # afterwards so a crash between the two steps still leaves the credential unusable.
    token_removed = remove_token_file(tokens_dir, alias)

    return {
        "alias": alias,
        "identities_removed": identities_removed,
        "identities_file": str(identities_dir / TOKEN_HASHES_FILE),
        "token_file": str(tokens_dir / f"{alias}.token"),
        "token_removed": token_removed,
    }


def describe_revoke_dry_run(alias: str, tokens_dir: pathlib.Path, identities_dir: pathlib.Path) -> str:
    if ALIAS_RE.fullmatch(alias) is None:
        raise IssueTokenError("el alias tiene formato invalido")
    validate_absolute(tokens_dir, "directorio de tokens")
    validate_absolute(identities_dir, "directorio de identidades")
    identities_fd = open_absolute_directory(identities_dir, "directorio de identidades")
    try:
        assert_secure_directory(identities_fd, "directorio de identidades")
        document, _ = read_identity_document(identities_fd)
    finally:
        os.close(identities_fd)
    matching = sum(
        1
        for record in document["identities"]  # type: ignore[union-attr]
        if isinstance(record, dict)
        and isinstance(record.get("principal"), dict)
        and record["principal"].get("alias") == alias  # type: ignore[union-attr]
    )
    token_path = tokens_dir / f"{alias}.token"
    return (
        f"dry-run --revoke: alias={alias} identities_a_eliminar={matching} "
        f"identities_file={identities_dir / TOKEN_HASHES_FILE} "
        f"token_file={token_path} ({'se borraria' if token_path.exists() else 'ya no existe'})"
    )


def ensure_tokens_directory(path: pathlib.Path) -> None:
    validate_absolute(path, "directorio de tokens")
    if path.is_symlink():
        raise IssueTokenError("el directorio de tokens no puede ser un symlink")
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def issue(
    alias: str, tokens_dir: pathlib.Path, identities_dir: pathlib.Path, flota_json: pathlib.Path, ttl_days: int,
) -> dict[str, object]:
    if ALIAS_RE.fullmatch(alias) is None:
        raise IssueTokenError("el alias tiene formato invalido")
    if not 1 <= ttl_days <= 3650:
        raise IssueTokenError("--ttl-days debe estar entre 1 y 3650")
    validate_absolute(tokens_dir, "directorio de tokens")
    validate_absolute(identities_dir, "directorio de identidades")

    tenant = load_enabled_tenant(flota_json, alias)
    expires_at = (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=ttl_days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    ensure_tokens_directory(tokens_dir)
    tokens_fd = open_absolute_directory(tokens_dir, "directorio de tokens")
    token_published = False
    try:
        assert_secure_directory(tokens_fd, "directorio de tokens")
        token_hex = secrets.token_hex(32)
        publish_token_file(tokens_fd, alias, token_hex)
        token_published = True

        identities_fd = open_absolute_directory(identities_dir, "directorio de identidades")
        try:
            assert_secure_directory(identities_fd, "directorio de identidades")
            lock_fd = open_regular_at(
                identities_fd, f".{TOKEN_HASHES_FILE}.lock", os.O_RDWR | os.O_CREAT, mode=0o600,
            )
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                document, original = read_identity_document(identities_fd)
                reject_existing_alias(document, tenant, alias)
                digest = hashlib.sha256(token_hex.encode("ascii")).hexdigest()
                document["identities"].append(  # type: ignore[union-attr]
                    {
                        "token_sha256": digest,
                        "expires_at": expires_at,
                        "principal": build_principal(tenant, alias),
                    }
                )
                publish_identity_document(identities_fd, lock_fd, document, original)
            finally:
                os.close(lock_fd)
        finally:
            os.close(identities_fd)
    except BaseException:
        if token_published:
            try:
                os.unlink(f"{alias}.token", dir_fd=tokens_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(tokens_fd)

    return {
        "alias": alias,
        "tenant": tenant,
        "token_file": str(tokens_dir / f"{alias}.token"),
        "identities_file": str(identities_dir / TOKEN_HASHES_FILE),
        "token_sha256": digest,
        "expires_at": expires_at,
        "identity_count": len(document["identities"]),  # type: ignore[arg-type]
    }


def describe_dry_run(
    alias: str, tokens_dir: pathlib.Path, identities_dir: pathlib.Path, flota_json: pathlib.Path, ttl_days: int,
) -> str:
    if ALIAS_RE.fullmatch(alias) is None:
        raise IssueTokenError("el alias tiene formato invalido")
    if not 1 <= ttl_days <= 3650:
        raise IssueTokenError("--ttl-days debe estar entre 1 y 3650")
    validate_absolute(tokens_dir, "directorio de tokens")
    validate_absolute(identities_dir, "directorio de identidades")
    tenant = load_enabled_tenant(flota_json, alias)
    token_path = tokens_dir / f"{alias}.token"
    conflict = token_path.exists() or token_path.is_symlink()
    expires_at = (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=ttl_days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        f"dry-run: alias={alias} tenant={tenant} "
        f"token_file={token_path} ({'YA EXISTE - fallaria' if conflict else 'se crearia, modo 0400'}) "
        f"identities_file={identities_dir / TOKEN_HASHES_FILE} (se le anexaria 1 identidad) "
        f"channel=adapter roles=adapter permissions=route,read expires_at={expires_at}"
    )


def build_parser() -> argparse.ArgumentParser:
    default_flota = pathlib.Path(__file__).resolve().parents[1] / "flota.json"
    parser = argparse.ArgumentParser(description="Emite un token bearer para un agente habilitado de la flota")
    parser.add_argument("--alias", required=True)
    parser.add_argument("--tokens-dir", required=True, type=pathlib.Path)
    parser.add_argument("--identities-dir", required=True, type=pathlib.Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--flota-json", type=pathlib.Path, default=default_flota)
    parser.add_argument("--ttl-days", type=int, default=DEFAULT_TTL_DAYS)
    parser.add_argument(
        "--revoke", action="store_true",
        help="elimina el hash de token y <alias>.token en vez de emitir uno nuevo",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.revoke:
        if arguments.dry_run:
            print(describe_revoke_dry_run(arguments.alias, arguments.tokens_dir, arguments.identities_dir))
            return 0
        result = revoke(arguments.alias, arguments.tokens_dir, arguments.identities_dir)
        print(
            "alias token revoked: {alias} -> identities_removed={identities_removed} "
            "token_removed={token_removed}; {identities_file}".format(**result)
        )
        return 0
    if arguments.dry_run:
        print(
            describe_dry_run(
                arguments.alias, arguments.tokens_dir, arguments.identities_dir,
                arguments.flota_json, arguments.ttl_days,
            )
        )
        return 0
    result = issue(
        arguments.alias, arguments.tokens_dir, arguments.identities_dir,
        arguments.flota_json, arguments.ttl_days,
    )
    print(
        "alias token issued: {alias} -> {token_file} (mode 0400); {identities_file} "
        "identities={identity_count} sha256={token_sha256} expires_at={expires_at}".format(**result)
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IssueTokenError as error:
        print(f"issue alias token failed: {error}", file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print("issue alias token failed: error operacional no divulgado", file=sys.stderr)
        raise SystemExit(2) from None
