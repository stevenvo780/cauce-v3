#!/usr/bin/env python3
"""Validate the effective production terminal mTLS topology without exposing key material."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlparse


class TerminalReleaseError(ValueError):
    pass


SAFE_CN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TerminalReleaseError(f"{label} must be an object")
    return value


def text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise TerminalReleaseError(f"{label} must be non-empty text")
    return value


def secret_sources(service: dict[str, Any], label: str) -> set[str]:
    values = service.get("secrets")
    if not isinstance(values, list):
        raise TerminalReleaseError(f"{label}.secrets must be an array")
    result: set[str] = set()
    for index, value in enumerate(values):
        if isinstance(value, str):
            source = value
        else:
            source = text(mapping(value, f"{label}.secrets[{index}]").get("source"), f"{label}.secrets[{index}].source")
        result.add(source)
    return result


def regular_private_path(value: Any, label: str) -> pathlib.Path:
    raw = text(value, label)
    path = pathlib.Path(raw)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise TerminalReleaseError(f"{label} must be an absolute regular non-symlink file")
    return path


def openssl(*arguments: str, input_bytes: bytes | None = None) -> bytes:
    try:
        return subprocess.run(
            ["openssl", *arguments], input=input_bytes, capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise TerminalReleaseError("OpenSSL certificate validation failed") from error


def public_key_digest_from_certificate(path: pathlib.Path) -> str:
    public_key = openssl("x509", "-in", str(path), "-pubkey", "-noout")
    normalized = openssl("pkey", "-pubin", "-outform", "DER", input_bytes=public_key)
    return hashlib.sha256(normalized).hexdigest()


def public_key_digest_from_key(path: pathlib.Path) -> str:
    normalized = openssl("pkey", "-in", str(path), "-pubout", "-outform", "DER")
    return hashlib.sha256(normalized).hexdigest()


def validate_client_certificate(
    certificate: pathlib.Path,
    key: pathlib.Path,
    ca: pathlib.Path,
    label: str,
    expected_cn: str | None = None,
) -> None:
    openssl("x509", "-in", str(certificate), "-noout", "-checkend", "3600")
    openssl("verify", "-purpose", "sslclient", "-CAfile", str(ca), str(certificate))
    details = openssl("x509", "-in", str(certificate), "-noout", "-text").decode("utf-8", "replace")
    if "TLS Web Client Authentication" not in details:
        raise TerminalReleaseError(f"{label} certificate lacks clientAuth EKU")
    if public_key_digest_from_certificate(certificate) != public_key_digest_from_key(key):
        raise TerminalReleaseError(f"{label} certificate/key do not match")
    if expected_cn is not None:
        subject = openssl(
            "x509", "-in", str(certificate), "-noout", "-subject", "-nameopt", "RFC2253",
        ).decode("utf-8", "replace").strip()
        common_names = re.findall(r"(?:^|,)CN=([^,]+)", subject.removeprefix("subject="))
        if common_names != [expected_cn]:
            raise TerminalReleaseError(f"{label} certificate CN must be {expected_cn}")


def validate_server_certificate(
    certificate: pathlib.Path,
    key: pathlib.Path,
    ca: pathlib.Path,
    label: str,
    expected_host: str,
) -> None:
    openssl("x509", "-in", str(certificate), "-noout", "-checkend", "3600")
    openssl("verify", "-purpose", "sslserver", "-CAfile", str(ca), str(certificate))
    host_check = openssl(
        "x509", "-in", str(certificate), "-noout", "-checkhost", expected_host,
    ).decode("utf-8", "replace").strip()
    if not host_check.endswith("does match certificate"):
        raise TerminalReleaseError(f"{label} certificate SAN does not match {expected_host}")
    details = openssl("x509", "-in", str(certificate), "-noout", "-text").decode("utf-8", "replace")
    if "TLS Web Server Authentication" not in details:
        raise TerminalReleaseError(f"{label} certificate lacks serverAuth EKU")
    if public_key_digest_from_certificate(certificate) != public_key_digest_from_key(key):
        raise TerminalReleaseError(f"{label} certificate/key do not match")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose-json", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        document = mapping(json.loads(args.compose_json.read_text(encoding="utf-8")), "compose")
        services = mapping(document.get("services"), "compose.services")
        gateway = mapping(services.get("gateway"), "compose.services.gateway")
        relay = mapping(services.get("terminal-relay"), "compose.services.terminal-relay")
        gateway_environment = mapping(gateway.get("environment"), "gateway.environment")
        relay_environment = mapping(relay.get("environment"), "terminal-relay.environment")
        if str(gateway_environment.get("CAUCE_TERMINAL_ENABLED")) != "1":
            raise TerminalReleaseError("gateway terminal capability must be enabled for this release")
        relay_url = text(gateway_environment.get("CAUCE_TERMINAL_RELAY_URL"), "gateway terminal relay URL")
        parsed = urlparse(relay_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise TerminalReleaseError("gateway terminal relay URL must be a credential-free HTTPS URL")

        common_names_raw = text(
            relay_environment.get("CAUCE_TERMINAL_RELAY_CONSOLE_CN"), "terminal relay client CN list",
        )
        common_names = [item.strip() for item in common_names_raw.split(",")]
        if any(not SAFE_CN.fullmatch(item) for item in common_names) or len(common_names) != len(set(common_names)):
            raise TerminalReleaseError("terminal relay client CN list must contain unique safe comma-separated names")
        if "gateway-relay-client" not in common_names or len(common_names) < 2:
            raise TerminalReleaseError(
                "terminal relay client CN list must retain console and gateway-relay-client principals"
            )

        spool_file = relay_environment.get("CAUCE_TERMINAL_CLOSE_SPOOL_FILE")
        if spool_file != "/var/lib/cauce-terminal/close-reports.json":
            raise TerminalReleaseError("terminal close reports must use the canonical persistent spool path")
        relay_volumes = relay.get("volumes")
        if not isinstance(relay_volumes, list) or not any(
            isinstance(volume, dict)
            and volume.get("type") == "volume"
            and volume.get("target") == "/var/lib/cauce-terminal"
            and isinstance(volume.get("source"), str)
            and bool(volume.get("source"))
            and volume.get("read_only") is not True
            for volume in relay_volumes
        ):
            raise TerminalReleaseError("terminal close report spool must have a writable named volume")

        required_by_service = {
            "gateway": {
                "gateway_tls_cert", "gateway_tls_key",
                "gateway_relay_client_cert", "gateway_relay_client_key",
            },
            "terminal-relay": {
                "terminal_relay_tls_cert", "terminal_relay_tls_key",
                "terminal_gateway_client_cert", "terminal_gateway_client_key", "gateway_client_ca",
            },
        }
        for service_name, required in required_by_service.items():
            missing = required - secret_sources(mapping(services[service_name], service_name), service_name)
            if missing:
                raise TerminalReleaseError(f"{service_name} is missing required terminal mTLS secrets")

        secrets = mapping(document.get("secrets"), "compose.secrets")
        paths = {
            name: regular_private_path(mapping(secrets.get(name), f"secrets.{name}").get("file"), f"secrets.{name}.file")
            for name in (
                "gateway_relay_client_cert", "gateway_relay_client_key",
                "terminal_gateway_client_cert", "terminal_gateway_client_key", "gateway_client_ca",
                "gateway_tls_cert", "gateway_tls_key", "terminal_relay_tls_cert", "terminal_relay_tls_key",
            )
        }
        required_modes = {
            "gateway_relay_client_cert": 0o444,
            "gateway_relay_client_key": 0o400,
            "terminal_gateway_client_cert": 0o444,
            "terminal_gateway_client_key": 0o400,
            "gateway_tls_cert": 0o444,
            "gateway_tls_key": 0o400,
            "terminal_relay_tls_cert": 0o444,
            "terminal_relay_tls_key": 0o400,
        }
        for name, expected_mode in required_modes.items():
            metadata = paths[name].stat()
            if metadata.st_uid != 1000 or metadata.st_mode & 0o777 != expected_mode:
                raise TerminalReleaseError(
                    f"secrets.{name}.file must be uid 1000 mode {expected_mode:04o}"
                )
        if len({os.path.realpath(path) for path in paths.values()}) != len(paths):
            raise TerminalReleaseError("terminal mTLS certificate, key and CA paths must be distinct")
        server_certificates = {
            os.path.realpath(paths[name]) for name in ("gateway_tls_cert", "terminal_relay_tls_cert")
        }
        if any(os.path.realpath(paths[name]) in server_certificates for name in (
            "gateway_relay_client_cert", "terminal_gateway_client_cert",
        )):
            raise TerminalReleaseError("terminal client certificates must not reuse a server certificate")

        validate_client_certificate(
            paths["gateway_relay_client_cert"], paths["gateway_relay_client_key"],
            paths["gateway_client_ca"], "gateway to relay", expected_cn="gateway-relay-client",
        )
        validate_client_certificate(
            paths["terminal_gateway_client_cert"], paths["terminal_gateway_client_key"],
            paths["gateway_client_ca"], "relay to gateway", expected_cn="terminal-relay-client",
        )
        validate_server_certificate(
            paths["gateway_tls_cert"], paths["gateway_tls_key"], paths["gateway_client_ca"],
            "gateway server", expected_host="gateway",
        )
        validate_server_certificate(
            paths["terminal_relay_tls_cert"], paths["terminal_relay_tls_key"], paths["gateway_client_ca"],
            "terminal relay server", expected_host=parsed.hostname,
        )
    except (OSError, json.JSONDecodeError, TerminalReleaseError) as error:
        print(f"terminal release gate failed: {error}", file=sys.stderr)
        return 1
    print("terminal release gate passed: enabled HTTPS, distinct clientAuth principals, verified CA/key pairs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
