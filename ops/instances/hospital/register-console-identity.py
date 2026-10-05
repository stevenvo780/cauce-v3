#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import json
import ssl
import subprocess
from pathlib import Path

LOCK_SPEC = importlib.util.spec_from_file_location("identity_registry_lock", Path(__file__).with_name("identity-registry-lock.py"))
LOCK_MODULE = importlib.util.module_from_spec(LOCK_SPEC)
LOCK_SPEC.loader.exec_module(LOCK_MODULE)
RegistryLock = LOCK_MODULE.RegistryLock


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
    with RegistryLock(registry) as lock:
        _register_locked(lock, certificate)
        lock.validate()


def _register_locked(lock: RegistryLock, certificate: Path) -> None:
    if certificate.is_symlink():
        raise ValueError("identity paths cannot be symlinks")
    original, metadata = lock.read()
    document = json.loads(original)
    identities = document.get("identities") if isinstance(document, dict) else None
    if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(identities, list):
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
    lock.replace(document, original, metadata)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    args = parser.parse_args()
    register(args.registry, args.certificate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
