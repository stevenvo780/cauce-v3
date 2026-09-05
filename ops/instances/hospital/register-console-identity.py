#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import ssl
import stat
import subprocess
import tempfile
from pathlib import Path


def certificate_fingerprint(path: Path) -> tuple[str, str]:
    pem = path.read_text(encoding="ascii")
    der = ssl.PEM_cert_to_DER_cert(pem)
    fingerprint = hashlib.sha256(der).hexdigest()
    result = subprocess.run(
        ["openssl", "x509", "-in", str(path), "-noout", "-enddate"],
        check=True,
        capture_output=True,
        text=True,
    )
    not_after = result.stdout.strip().removeprefix("notAfter=")
    if not not_after:
        raise ValueError("certificate expiry is missing")
    expiry = datetime.datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
    return fingerprint, expiry.strftime("%Y-%m-%dT%H:%M:%SZ")


def register(registry: Path, certificate: Path) -> None:
    if registry.is_symlink() or certificate.is_symlink():
        raise ValueError("identity paths cannot be symlinks")
    metadata = registry.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o400:
        raise ValueError("identity registry must be a private single-link regular file")
    document = json.loads(registry.read_text(encoding="utf-8"))
    identities = document.get("identities") if isinstance(document, dict) else None
    if document.get("version") != 1 or not isinstance(identities, list):
        raise ValueError("identity registry is invalid")
    fingerprint, expires_at = certificate_fingerprint(certificate)
    principal = {
        "tenant_id": "Hospital",
        "alias": "console-proxy",
        "session_id": "console-proxy",
        "channel": "console",
        "roles": ["adapter"],
        "permissions": ["read"],
    }
    record = {
        "certificate_sha256": fingerprint,
        "expires_at": expires_at,
        "principal": principal,
    }
    matching = [
        item
        for item in identities
        if isinstance(item, dict)
        and isinstance(item.get("principal"), dict)
        and item["principal"].get("tenant_id") == "Hospital"
        and item["principal"].get("alias") == "console-proxy"
    ]
    if matching:
        if matching != [record]:
            raise ValueError("console identity differs from the registered certificate")
        return
    if any(isinstance(item, dict) and item.get("certificate_sha256") == fingerprint for item in identities):
        raise ValueError("console certificate belongs to another principal")
    identities.append(record)
    identities.sort(
        key=lambda item: (
            str(item.get("principal", {}).get("tenant_id", "")),
            str(item.get("principal", {}).get("alias", "")),
        )
    )
    body = json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=".mtls-identities-", dir=registry.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.chmod(temporary, 0o400)
        os.replace(temporary, registry)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    args = parser.parse_args()
    register(args.registry, args.certificate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
