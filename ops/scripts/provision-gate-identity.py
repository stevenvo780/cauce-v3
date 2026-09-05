#!/usr/bin/env python3
"""Issue and register only the dedicated, model-free gate principal."""

from __future__ import annotations

import ctypes
import datetime
import fcntl
import importlib.util
import json
import os
import pathlib
import secrets
import stat
import subprocess
import tempfile

SPEC = importlib.util.spec_from_file_location(
    "register_agent_identity", pathlib.Path(__file__).with_name("register-agent-identity.py"),
)
assert SPEC and SPEC.loader
REGISTRY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REGISTRY)
from update_alias_lib import SafeArgumentParser  # noqa: E402

PRINCIPAL = {
    "tenant_id": "Steven", "alias": "gate-probe", "session_id": "gate-probe",
    "channel": "gate", "roles": ["agent"], "permissions": ["route", "read"],
}


def openssl(*arguments: str, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["openssl", *arguments], input=input_data, capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError("gate identity: cryptographic validation or issuance failed")
    return result.stdout


def validate_file(path: pathlib.Path, private: bool) -> None:
    parent = REGISTRY.open_absolute_directory(path.parent, "credential parent")
    try:
        REGISTRY.assert_secure_directory(parent, "credential parent")
        fd = REGISTRY.open_regular_at(parent, path.name, os.O_RDONLY)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022)):
                raise RuntimeError("gate identity: unsafe credential ownership or mode")
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def certificate_expiry(cert: pathlib.Path) -> datetime.datetime:
    expiry = openssl("x509", "-in", str(cert), "-noout", "-enddate").decode("ascii").strip()
    return datetime.datetime.strptime(expiry, "notAfter=%b %d %H:%M:%S %Y GMT").replace(tzinfo=datetime.timezone.utc)


def validate_pair(directory: pathlib.Path, ca_cert: pathlib.Path) -> dict[str, object]:
    cert, key = directory / "gate-probe.crt", directory / "gate-probe.key"
    validate_file(cert, False)
    validate_file(key, True)
    openssl("verify", "-purpose", "sslclient", "-CAfile", str(ca_cert), str(cert))
    openssl("x509", "-in", str(cert), "-noout", "-checkend", "86400")
    subject = openssl("x509", "-in", str(cert), "-noout", "-subject", "-nameopt", "RFC2253").strip()
    if subject != b"subject=CN=gate-probe":
        raise RuntimeError("gate identity: unexpected certificate subject")
    public = openssl("x509", "-in", str(cert), "-pubkey", "-noout")
    if public != openssl("pkey", "-in", str(key), "-pubout"):
        raise RuntimeError("gate identity: certificate/key mismatch")
    text = openssl("x509", "-in", str(cert), "-noout", "-text")
    if b"TLS Web Client Authentication" not in text or b"CA:FALSE" not in text:
        raise RuntimeError("gate identity: expected client-only leaf")
    expires_at = min(certificate_expiry(cert), certificate_expiry(ca_cert))
    return {
        "certificate_sha256": REGISTRY.certificate_sha256_from_pem(cert.read_text(encoding="ascii")),
        "expires_at": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "principal": PRINCIPAL.copy(),
    }


def issue(directory: pathlib.Path, ca_cert: pathlib.Path, ca_key: pathlib.Path) -> None:
    validate_file(ca_key, True)
    openssl("x509", "-in", str(ca_cert), "-noout", "-checkend", "172800")
    if b"CA:TRUE" not in openssl("x509", "-in", str(ca_cert), "-noout", "-text"):
        raise RuntimeError("gate identity: signer is not a CA")
    if openssl("x509", "-in", str(ca_cert), "-pubkey", "-noout") != openssl("pkey", "-in", str(ca_key), "-pubout"):
        raise RuntimeError("gate identity: CA certificate/key mismatch")
    days = min(365, (certificate_expiry(ca_cert) - datetime.datetime.now(datetime.timezone.utc)).days)
    if days < 2:
        raise RuntimeError("gate identity: signer validity is too short")
    # Publish the complete pair together; never replace an existing credential directory.
    with tempfile.TemporaryDirectory(prefix=".gate-probe-", dir=directory.parent) as temporary:
        work = pathlib.Path(temporary)
        pair = work / "pair"
        pair.mkdir(mode=0o700)
        key, cert, csr = pair / "gate-probe.key", pair / "gate-probe.crt", work / "client.csr"
        openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(key))
        openssl("req", "-new", "-sha256", "-key", str(key), "-subj", "/CN=gate-probe", "-out", str(csr))
        openssl(
            "x509", "-req", "-sha256", "-in", str(csr), "-CA", str(ca_cert), "-CAkey", str(ca_key),
            "-set_serial", "0x" + secrets.token_hex(16), "-days", str(days), "-extfile", "/dev/stdin", "-out", str(cert),
            input_data=b"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n",
        )
        key.chmod(0o400)
        cert.chmod(0o444)
        validate_pair(pair, ca_cert)
        for path in (key, cert):
            with path.open("rb") as handle:
                os.fsync(handle.fileno())
        pair_fd = os.open(pair, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(pair_fd)
        finally:
            os.close(pair_fd)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(pair), -100, os.fsencode(directory), 1):
            raise OSError(ctypes.get_errno(), "gate identity: exclusive publication failed")
        parent = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)


def provision(directory: pathlib.Path, ca_cert: pathlib.Path, ca_key: pathlib.Path,
              identities: pathlib.Path) -> dict[str, object]:
    for path in (directory, ca_cert, ca_key, identities):
        REGISTRY.validate_absolute(path, "gate identity path")
    validate_file(ca_cert, False)
    parent = REGISTRY.open_absolute_directory(directory.parent, "credential parent")
    identity_fd = REGISTRY.open_absolute_directory(identities, "identity directory")
    lock_fd = None
    try:
        REGISTRY.assert_secure_directory(parent, "credential parent")
        REGISTRY.assert_secure_directory(identity_fd, "identity directory")
        lock_fd = REGISTRY.open_regular_at(
            identity_fd, ".mtls_identities.json.lock", os.O_RDWR | os.O_CREAT, mode=0o600,
        )
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        document, original = REGISTRY.read_identity_document(identity_fd)
        existing = [record for record in document["identities"]
                    if isinstance(record, dict) and isinstance(record.get("principal"), dict)
                    and record["principal"].get("alias") == "gate-probe"]
        if len(existing) > 1 or (existing and existing[0].get("principal") != PRINCIPAL):
            raise RuntimeError("gate identity: conflicting reserved principal; nothing replaced")
        if not directory.exists() and not directory.is_symlink():
            if existing:
                raise RuntimeError("gate identity: registered credential is missing; explicit recovery required")
            issue(directory, ca_cert, ca_key)
        record = validate_pair(directory, ca_cert)
        if existing:
            if existing[0] != record:
                raise RuntimeError("gate identity: existing registration differs; nothing replaced")
            return {"alias": "gate-probe", "already_registered": True}
        if any(item.get("certificate_sha256") == record["certificate_sha256"]
               for item in document["identities"] if isinstance(item, dict)):
            raise RuntimeError("gate identity: certificate already belongs to another principal")
        document["identities"].append(record)
        REGISTRY.publish_identity_document(identity_fd, lock_fd, document, original)
        return {"alias": "gate-probe", "already_registered": False, "identities_added": 1}
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(identity_fd)
        os.close(parent)


def main() -> int:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--ca-cert", type=pathlib.Path, required=True)
    parser.add_argument("--ca-key", type=pathlib.Path, required=True)
    parser.add_argument("--identities-dir", type=pathlib.Path, required=True)
    try:
        args = parser.parse_args()
    except RuntimeError:
        print("gate identity: invalid command line")
        return 2
    try:
        result = provision(args.output_dir, args.ca_cert, args.ca_key, args.identities_dir)
    except (OSError, RuntimeError, ValueError):
        print("gate identity: provisioning failed; no existing credential replaced")
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
