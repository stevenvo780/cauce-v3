#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import os
import pathlib
import re
import sys


# Domain separation for the PTY ticket key hierarchy. Changing either string invalidates every
# derived key, which is exactly how a key rotation is performed.
TICKET_SALT = b"cauce-v3/pty-ticket/v1"
INFO_PREFIX = "pty:"
KEY_LENGTH = 32
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
HEX_MASTER_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = KEY_LENGTH) -> bytes:
    """RFC 5869 extract-then-expand, single block. Only hmac/hashlib, no third-party crypto:
    the same twelve lines are reimplemented by the gateway in TypeScript and both must agree
    byte for byte with the golden vector in tests/test_hkdf.py."""
    if length > hashlib.sha256().digest_size:
        raise ValueError("this derivation only emits one HMAC block")
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


def alias_key(master: bytes, tenant: str, alias: str) -> bytes:
    if len(master) != 32:
        raise ValueError("the master key must be exactly 32 bytes")
    if not NAME_RE.fullmatch(tenant) or not NAME_RE.fullmatch(alias):
        raise ValueError("tenant and alias must be simple identifiers")
    info = (INFO_PREFIX + tenant + ":" + alias).encode("utf-8")
    return hkdf_sha256(master, TICKET_SALT, info)


def decode_master(body: str) -> bytes:
    """The master key lives ONLY in agora. It is decoded here, used, and never copied anywhere.

    Hex is probed first: 64 hex characters are also valid base64, so probing base64 first would
    silently turn a hex master into 48 unrelated bytes.
    """
    text = body.strip()
    if HEX_MASTER_RE.fullmatch(text):
        material = bytes.fromhex(text)
    else:
        try:
            material = base64.b64decode(text, validate=True)
        except ValueError:
            raise SystemExit("master key must be base64 or hex of 32 bytes") from None
    if len(material) != 32:
        raise SystemExit("master key must decode to exactly 32 bytes")
    return material


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Derive the per-alias PTY ticket key (run on agora)")
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--alias", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--master-file", type=pathlib.Path, help="file holding the base64/hex master key")
    source.add_argument("--master-env", help="environment variable holding the base64/hex master key")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.master_env is not None:
        value = os.environ.get(args.master_env)
        if not value:
            raise SystemExit(f"environment variable is empty or unset: {args.master_env}")
        master = decode_master(value)
    else:
        master = decode_master(args.master_file.read_text(encoding="utf-8"))
    try:
        derived = alias_key(master, args.tenant, args.alias)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    # Only the derived key reaches stdout, and only ever this one: it authorises exactly one alias,
    # so copying it to kratos does not put the other thirteen at risk. The master never leaves agora.
    sys.stdout.write(derived.hex() + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
