from __future__ import annotations

import hashlib
import http.client
import json
import os
import pathlib
import ssl
import stat
from urllib.parse import urlsplit


def checked_reference(filename: str, private: bool = False) -> bytes:
    path = pathlib.Path(filename)
    if not path.is_absolute() or ".." in path.parts or str(path) != str(pathlib.PurePosixPath(str(path))):
        raise ValueError("invalid Cauce credential reference")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = following
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & (0o077 if private else 0o022)
            or metadata.st_size > 1048576
        ):
            raise ValueError("unsafe Cauce credential reference")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(1048577)
        if len(raw) > 1048576:
            raise ValueError("Cauce credential reference exceeds limit")
        return raw
    finally:
        os.close(descriptor)


def rejected(origin: str, context: ssl.SSLContext, phase: str, token: str | None = None) -> bool:
    url = urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("revocation requires verified TLS")
    connection = http.client.HTTPSConnection(url.hostname, url.port, context=context, timeout=10)
    try:
        headers = {"x-cauce-bootstrap-phase": phase}
        if token is not None:
            headers["authorization"] = "Bearer " + token
        connection.request(
            "GET", "/v3/bootstrap/credentials/" + ("mtls" if token is None else "token"), headers=headers
        )
        response = connection.getresponse()
        raw = response.read(16385)
        return len(raw) <= 16384 and response.status == 401 and json.loads(raw) == {"error": "CREDENTIAL_REJECTED"}
    finally:
        connection.close()


def revoke(packet: dict) -> dict:
    if packet["account_id"] is not None or packet["identity"] != "cauce-runtime:" + packet["agent"]["runtime_key"]:
        raise ValueError("revocation may only target Cauce runtime credentials")
    references = packet["cauce_credentials"]
    target = packet["agent"]
    legacy = references.get("legacy")
    if references.get("fleet_baseline") != target.get("fleet_baseline") \
            or legacy is not None and references.get("fleet_baseline") is not True:
        raise ValueError("Cauce revocation baseline authority differs")
    if references.get("fleet_baseline") is True and legacy is None:
        raise ValueError("baseline Cauce credentials have no exact approved inventory")
    if not references["credentials"] and legacy is None and references.get("fleet_baseline") is not False:
        raise ValueError("empty Cauce credentials have no durable absence authority")
    if 'central' in references:
        from fleet_executor_authority import verify_absence
        verify_absence(references['central'], target, packet['operation_id'])
    else:
        from fleet_executor_legacy_credentials import verify_absence
        verify_absence(references, target, checked_reference)
    origin = packet["transport"]["gateway_url"]
    credentials = list(references["credentials"].items())
    if legacy is not None:
        if legacy.get("tenant_id") != target["tenant_id"] or legacy.get("alias") != target["alias"] \
                or legacy.get("expected_absent") != (not legacy.get("credentials")):
            raise ValueError("legacy Cauce inventory identity differs")
        credentials += [(credential["phase"], credential) for credential in legacy["credentials"]]
    for phase, credential in credentials:
        if phase not in {"bootstrap", "normal"}:
            raise ValueError("unknown credential namespace")
        context = ssl.create_default_context(cafile=packet["transport"]["ca_certificate"])
        if "certificate_path" in credential:
            pem = checked_reference(credential["certificate_path"])
            checked_reference(credential["key_path"], True)
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode("ascii"))).hexdigest()
            if fingerprint != credential["certificate_fingerprint"]:
                raise ValueError("Cauce certificate reference changed")
            context.load_cert_chain(credential["certificate_path"], credential["key_path"])
            if not rejected(origin, context, phase):
                raise ValueError("revoked Cauce certificate was not rejected")
        if "token_path" in credential:
            raw = checked_reference(credential["token_path"], True).strip()
            if hashlib.sha256(raw).hexdigest() != credential["token_sha256"]:
                raise ValueError("Cauce token reference changed")
            if "certificate_path" not in credential:
                raise ValueError("bearer revocation requires an authorized TLS client transport")
            if not rejected(origin, context, phase, raw.decode("ascii")):
                raise ValueError("revoked Cauce bearer was not rejected")
    return {"revocation_verified": True}
