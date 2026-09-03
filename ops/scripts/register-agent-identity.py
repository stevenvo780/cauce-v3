#!/usr/bin/env python3
"""Register the mTLS identity for one fleet agent's already-issued leaf (provisioning piece 1b).

Reads ``agent-<alias>.crt`` (published 0444 by provision-agent-identity.sh, piece 1) under
--cert-dir, computes its SHA-256 fingerprint the same way the gateway does when it authenticates
a live TLS connection (services/gateway/src/auth.ts: ``certificate.fingerprint256``, which is
Node's SHA-256 digest of the certificate's raw DER encoding — not the PEM text), and appends a
new record to ``mtls_identities.json`` under --identities-dir, serialized with flock and
published via tmp-file + fsync + rename (the file is never edited in place, matching the CAS
pattern in update_alias_lib.py / issue-alias-token.py).

This script never issues or modifies key material and never touches token_hashes.json (that is
issue-alias-token.py's job, piece 2) — the certificate must already exist under --cert-dir.

``--revoke --tenant <tenant> --alias <alias>`` reverses the above for one identity: it removes
every mtls_identities.json record whose principal matches (tenant_id, alias) — no certificate or
fingerprint needed, since the leaf may already be destroyed by the time an agent is retired — and
never opens --cert-dir (so --cert-dir is required only outside --revoke). Same lock/CAS pattern as
issue-alias-token.py::revoke(); idempotent (nothing to remove is success, not an error); --dry-run
compatible. Invoked by `cauce <alias> retirar` alongside issue-alias-token.py --revoke, which
calls it as exactly ``--revoke --tenant <tenant> --alias <alias>`` — no --identities-dir, so a
--revoke with that flag omitted falls back to DEFAULT_IDENTITIES_DIR, the same
/etc/cauce-v3/secrets/identities that ops/cli/cauce's IDENTIDADES_DIR points at.
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
import ssl
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
)

ALIAS_RE = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")  # packages/protocol/src/schemas/core.ts AliasSchema
TENANT_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")  # ...TenantSchema
MTLS_IDENTITIES_FILE = "mtls_identities.json"
CERT_FILE_MODE = 0o444  # matches provision-agent-identity.sh: chmod 0444 "$work/client.crt"
IDENTITY_FILE_MODE = 0o400
IDENTITY_SCHEMA_VERSION = 1
DEFAULT_TTL_DAYS = 730  # matches the mTLS leaf validity issued by provision-agent-identity.sh
MAX_CERT_BYTES = 16_384
DEFAULT_IDENTITIES_DIR = pathlib.Path("/etc/cauce-v3/secrets/identities")


class RegisterIdentityError(RuntimeError):
    """Expected failure; message is guaranteed to never contain certificate key material."""


def load_enabled_tenant(flota_path: pathlib.Path, alias: str) -> str:
    """Enforce the allowlist: only an alias enabled in the fleet snapshot may get an identity."""
    try:
        fd = os.open(flota_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        raise RegisterIdentityError(f"no se pudo abrir el snapshot de flota: {flota_path}") from error
    try:
        raw = read_all(fd, "snapshot de flota")
    finally:
        os.close(fd)
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise RegisterIdentityError("el snapshot de flota no es JSON valido") from error
    fleet = document.get("fleet") if isinstance(document, dict) else None
    entry = fleet.get(alias) if isinstance(fleet, dict) else None
    if not isinstance(entry, dict) or entry.get("enabled") is not True:
        raise RegisterIdentityError(f"el alias {alias!r} no esta habilitado en el snapshot de flota")
    tenant = entry.get("tenant")
    if not isinstance(tenant, str) or TENANT_RE.fullmatch(tenant) is None:
        raise RegisterIdentityError("el snapshot de flota declara un tenant invalido para el alias")
    return tenant


def build_principal(tenant: str, alias: str) -> dict[str, object]:
    # Mirrors every adapter-channel identity already in mtls_identities.json (jarvis, kant, ...)
    # and issue-alias-token.py's bearer-token twin: same channel/roles/permissions shape.
    return {
        "tenant_id": tenant,
        "alias": alias,
        "session_id": f"adapter-{alias}",
        "channel": "adapter",
        "roles": ["adapter"],
        "permissions": ["route", "read"],
    }


def assert_readonly_regular(fd: int, label: str, expected_mode: int) -> os.stat_result:
    details = os.fstat(fd)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or (os.geteuid() != 0 and details.st_uid != os.geteuid())
        or stat.S_IMODE(details.st_mode) != expected_mode
    ):
        raise RegisterIdentityError(
            f"{label} debe ser un fichero regular de un enlace, del usuario efectivo y modo {expected_mode:04o}"
        )
    return details


def certificate_sha256_from_pem(pem_text: str) -> str:
    """SHA-256 of the DER encoding — identical to Node's X509Certificate.fingerprint256."""
    try:
        der = ssl.PEM_cert_to_DER_cert(pem_text)
    except ValueError as error:
        raise RegisterIdentityError("el certificado no es un bloque PEM valido") from error
    return hashlib.sha256(der).hexdigest()


def read_certificate(cert_dir: pathlib.Path, alias: str) -> str:
    try:
        cert_dir_fd = open_absolute_directory(cert_dir, "directorio de certificados")
    except OSError as error:
        raise RegisterIdentityError(f"no se pudo abrir el directorio de certificados: {cert_dir}") from error
    try:
        try:
            fd = open_regular_at(cert_dir_fd, f"agent-{alias}.crt", os.O_RDONLY)
        except FileNotFoundError as error:
            raise RegisterIdentityError(f"no existe agent-{alias}.crt en {cert_dir}") from error
        try:
            assert_readonly_regular(fd, f"agent-{alias}.crt", CERT_FILE_MODE)
            body = read_all(fd, f"agent-{alias}.crt")
        finally:
            os.close(fd)
    finally:
        os.close(cert_dir_fd)
    if len(body) > MAX_CERT_BYTES:
        raise RegisterIdentityError(f"agent-{alias}.crt excede el limite permitido")
    try:
        return body.decode("ascii")
    except UnicodeDecodeError as error:
        raise RegisterIdentityError(f"agent-{alias}.crt no es PEM ASCII valido") from error


def read_identity_document(identities_fd: int) -> tuple[dict[str, object], os.stat_result | None]:
    try:
        fd = open_regular_at(identities_fd, MTLS_IDENTITIES_FILE, os.O_RDONLY)
    except FileNotFoundError:
        return {"version": IDENTITY_SCHEMA_VERSION, "identities": []}, None
    try:
        details = assert_readonly_regular(fd, MTLS_IDENTITIES_FILE, IDENTITY_FILE_MODE)
        body = read_all(fd, MTLS_IDENTITIES_FILE)
    finally:
        os.close(fd)
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise RegisterIdentityError(f"{MTLS_IDENTITIES_FILE} no es JSON valido") from error
    if (
        not isinstance(document, dict)
        or document.get("version") != IDENTITY_SCHEMA_VERSION
        or not isinstance(document.get("identities"), list)
    ):
        raise RegisterIdentityError(f"{MTLS_IDENTITIES_FILE} no respeta el formato version 1 / identities[]")
    return document, details


def find_matching_records(
    document: dict[str, object], certificate_sha256: str, tenant: str, alias: str,
) -> tuple[dict[str, object] | None, dict[str, object] | None]:
    same_certificate: dict[str, object] | None = None
    same_identity: dict[str, object] | None = None
    for record in document["identities"]:  # type: ignore[union-attr]
        if not isinstance(record, dict):
            continue
        if record.get("certificate_sha256") == certificate_sha256:
            same_certificate = record
        principal = record.get("principal")
        if (
            isinstance(principal, dict)
            and principal.get("tenant_id") == tenant
            and principal.get("alias") == alias
            and principal.get("channel") == "adapter"
        ):
            same_identity = record
    return same_certificate, same_identity


def publish_identity_document(
    identities_fd: int, lock_fd: int, document: dict[str, object], original: os.stat_result | None,
) -> None:
    publish_json_document_cas(
        identities_fd,
        lock_fd,
        MTLS_IDENTITIES_FILE,
        document,
        original,
        mode=IDENTITY_FILE_MODE,
        error_type=RegisterIdentityError,
        operation="el registro",
    )


def register(
    alias: str, cert_dir: pathlib.Path, identities_dir: pathlib.Path, flota_json: pathlib.Path, ttl_days: int,
) -> dict[str, object]:
    if ALIAS_RE.fullmatch(alias) is None:
        raise RegisterIdentityError("el alias tiene formato invalido")
    if not 1 <= ttl_days <= 3650:
        raise RegisterIdentityError("--ttl-days debe estar entre 1 y 3650")
    validate_absolute(cert_dir, "directorio de certificados")
    validate_absolute(identities_dir, "directorio de identidades")

    tenant = load_enabled_tenant(flota_json, alias)
    certificate_sha256 = certificate_sha256_from_pem(read_certificate(cert_dir, alias))
    expires_at = (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=ttl_days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    identities_fd = open_absolute_directory(identities_dir, "directorio de identidades")
    try:
        assert_secure_directory(identities_fd, "directorio de identidades")
        lock_fd = open_regular_at(
            identities_fd, f".{MTLS_IDENTITIES_FILE}.lock", os.O_RDWR | os.O_CREAT, mode=0o600,
        )
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            document, original = read_identity_document(identities_fd)
            same_certificate, same_identity = find_matching_records(document, certificate_sha256, tenant, alias)
            if same_certificate is not None:
                # Exact cert already registered (e.g. a repeated `cauce <alias> aprovisionar`
                # where step [1] skipped re-issuing an unchanged cert): a no-op, not an error.
                return {
                    "alias": alias,
                    "tenant": tenant,
                    "certificate_sha256": certificate_sha256,
                    "identities_file": str(identities_dir / MTLS_IDENTITIES_FILE),
                    "identity_count": len(document["identities"]),  # type: ignore[arg-type]
                    "already_registered": True,
                }
            if same_identity is not None:
                raise RegisterIdentityError(
                    f"ya existe una identidad mTLS distinta para {tenant}:{alias}; revocarla antes de registrar esta"
                )
            document["identities"].append(  # type: ignore[union-attr]
                {
                    "certificate_sha256": certificate_sha256,
                    "expires_at": expires_at,
                    "principal": build_principal(tenant, alias),
                }
            )
            publish_identity_document(identities_fd, lock_fd, document, original)
        finally:
            os.close(lock_fd)
    finally:
        os.close(identities_fd)

    return {
        "alias": alias,
        "tenant": tenant,
        "certificate_sha256": certificate_sha256,
        "identities_file": str(identities_dir / MTLS_IDENTITIES_FILE),
        "identity_count": len(document["identities"]),  # type: ignore[arg-type]
        "already_registered": False,
    }


def describe_dry_run(
    alias: str, cert_dir: pathlib.Path, identities_dir: pathlib.Path, flota_json: pathlib.Path, ttl_days: int,
) -> str:
    if ALIAS_RE.fullmatch(alias) is None:
        raise RegisterIdentityError("el alias tiene formato invalido")
    if not 1 <= ttl_days <= 3650:
        raise RegisterIdentityError("--ttl-days debe estar entre 1 y 3650")
    validate_absolute(cert_dir, "directorio de certificados")
    validate_absolute(identities_dir, "directorio de identidades")
    tenant = load_enabled_tenant(flota_json, alias)
    certificate_sha256 = certificate_sha256_from_pem(read_certificate(cert_dir, alias))

    identities_fd = open_absolute_directory(identities_dir, "directorio de identidades")
    try:
        assert_secure_directory(identities_fd, "directorio de identidades")
        document, _ = read_identity_document(identities_fd)
    finally:
        os.close(identities_fd)
    same_certificate, same_identity = find_matching_records(document, certificate_sha256, tenant, alias)
    if same_certificate is not None:
        outcome = "ya registrado (no-op)"
    elif same_identity is not None:
        outcome = "CONFLICTO: ya existe una identidad distinta para este alias; fallaria"
    else:
        outcome = "se anexaria 1 identidad"
    return (
        f"dry-run: alias={alias} tenant={tenant} certificate_sha256={certificate_sha256} "
        f"identities_file={identities_dir / MTLS_IDENTITIES_FILE} ({outcome}) "
        f"channel=adapter roles=adapter permissions=route,read"
    )


def revoke(tenant: str, alias: str, identities_dir: pathlib.Path) -> dict[str, object]:
    if ALIAS_RE.fullmatch(alias) is None:
        raise RegisterIdentityError("el alias tiene formato invalido")
    if TENANT_RE.fullmatch(tenant) is None:
        raise RegisterIdentityError("el tenant tiene formato invalido")
    validate_absolute(identities_dir, "directorio de identidades")

    identities_removed = 0
    identities_fd = open_absolute_directory(identities_dir, "directorio de identidades")
    try:
        assert_secure_directory(identities_fd, "directorio de identidades")
        lock_fd = open_regular_at(
            identities_fd, f".{MTLS_IDENTITIES_FILE}.lock", os.O_RDWR | os.O_CREAT, mode=0o600,
        )
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            document, original = read_identity_document(identities_fd)
            kept: list[object] = []
            for record in document["identities"]:  # type: ignore[union-attr]
                principal = record.get("principal") if isinstance(record, dict) else None
                if (
                    isinstance(principal, dict)
                    and principal.get("tenant_id") == tenant
                    and principal.get("alias") == alias
                ):
                    identities_removed += 1
                    continue
                kept.append(record)
            if identities_removed:
                document["identities"] = kept  # type: ignore[index]
                publish_identity_document(identities_fd, lock_fd, document, original)
        finally:
            os.close(lock_fd)
    finally:
        os.close(identities_fd)

    return {
        "tenant": tenant,
        "alias": alias,
        "identities_removed": identities_removed,
        "identities_file": str(identities_dir / MTLS_IDENTITIES_FILE),
    }


def describe_revoke_dry_run(tenant: str, alias: str, identities_dir: pathlib.Path) -> str:
    if ALIAS_RE.fullmatch(alias) is None:
        raise RegisterIdentityError("el alias tiene formato invalido")
    if TENANT_RE.fullmatch(tenant) is None:
        raise RegisterIdentityError("el tenant tiene formato invalido")
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
        and record["principal"].get("tenant_id") == tenant  # type: ignore[union-attr]
        and record["principal"].get("alias") == alias  # type: ignore[union-attr]
    )
    return (
        f"dry-run --revoke: tenant={tenant} alias={alias} identities_a_eliminar={matching} "
        f"identities_file={identities_dir / MTLS_IDENTITIES_FILE}"
    )


def build_parser() -> argparse.ArgumentParser:
    default_flota = pathlib.Path(__file__).resolve().parents[1] / "flota.json"
    parser = argparse.ArgumentParser(
        description="Registra la identidad mTLS de un agente cuyo certificado ya fue emitido"
    )
    parser.add_argument("--alias", required=True)
    parser.add_argument("--tenant", help="requerido con --revoke; ignorado al registrar (sale de --flota-json)")
    parser.add_argument("--cert-dir", type=pathlib.Path)
    parser.add_argument("--identities-dir", type=pathlib.Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--flota-json", type=pathlib.Path, default=default_flota)
    parser.add_argument("--ttl-days", type=int, default=DEFAULT_TTL_DAYS)
    parser.add_argument(
        "--revoke", action="store_true",
        help="elimina la identidad mTLS de --tenant:--alias en vez de registrar una nueva",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)

    if arguments.revoke:
        if arguments.tenant is None:
            parser.error("--revoke requiere --tenant")
        identities_dir = arguments.identities_dir or DEFAULT_IDENTITIES_DIR
        if arguments.dry_run:
            print(describe_revoke_dry_run(arguments.tenant, arguments.alias, identities_dir))
            return 0
        result = revoke(arguments.tenant, arguments.alias, identities_dir)
        print(
            "agent identity revoked: {tenant}:{alias} -> identities_removed={identities_removed}; "
            "{identities_file}".format(**result)
        )
        return 0

    if arguments.cert_dir is None:
        parser.error("--cert-dir es requerido (fuera de --revoke)")
    if arguments.identities_dir is None:
        parser.error("--identities-dir es requerido (fuera de --revoke)")

    if arguments.dry_run:
        print(
            describe_dry_run(
                arguments.alias, arguments.cert_dir, arguments.identities_dir,
                arguments.flota_json, arguments.ttl_days,
            )
        )
        return 0
    result = register(
        arguments.alias, arguments.cert_dir, arguments.identities_dir,
        arguments.flota_json, arguments.ttl_days,
    )
    if result["already_registered"]:
        print(
            "agent identity already registered: {alias} sha256={certificate_sha256} "
            "(no cambios; {identities_file})".format(**result)
        )
    else:
        print(
            "agent identity registered: {alias} -> {identities_file} "
            "identities={identity_count} sha256={certificate_sha256}".format(**result)
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RegisterIdentityError as error:
        print(f"register agent identity failed: {error}", file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print("register agent identity failed: error operacional no divulgado", file=sys.stderr)
        raise SystemExit(2) from None
