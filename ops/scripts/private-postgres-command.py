#!/usr/bin/env python3
"""Run one libpq client command using a private URL file without secret argv/env.

The child receives only ``service=cauce_restore``.  Connection metadata lives in a
mode-0600 service file and the password lives in a separate mode-0600 pgpass file;
both are removed before this process exits.  No URL component is ever printed.
"""
from __future__ import annotations

import fcntl
import hashlib
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse

MAX_URL_BYTES = 16_384
PRIVATE_MODES = {0o400, 0o600}
ALLOWED_QUERY_KEYS = {
    "application_name",
    "channel_binding",
    "connect_timeout",
    "gssencmode",
    "krbsrvname",
    "sslmode",
    "sslrootcert",
    "sslcompression",
    "ssl_min_protocol_version",
    "ssl_max_protocol_version",
    "target_session_attrs",
}

ORIGIN_SIGNATURE_FIELDS = (
    "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size",
    "st_mtime_ns", "st_ctime_ns",
)


def metadata_signature(metadata: os.stat_result) -> tuple[int, ...]:
    return tuple(getattr(metadata, field) for field in ORIGIN_SIGNATURE_FIELDS)


def private_text(path: pathlib.Path) -> tuple[str, tuple[int, ...], bytes]:
    if not path.is_absolute():
        raise ValueError("connection file must be absolute")
    before = path.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_IMODE(before.st_mode) not in PRIVATE_MODES
        or before.st_nlink != 1
        or before.st_uid not in {0, os.geteuid()}
        or not 0 < before.st_size <= MAX_URL_BYTES
    ):
        raise ValueError("connection file is not an owned private single-link regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("connection file changed while opening")
        content = os.read(descriptor, MAX_URL_BYTES + 1)
        if len(content) != opened.st_size:
            raise ValueError("connection file changed while reading")
        final = os.fstat(descriptor)
        if metadata_signature(final) != metadata_signature(opened):
            raise ValueError("connection file changed while reading")
    finally:
        os.close(descriptor)
    try:
        value = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("connection file is not UTF-8") from error
    lines = value.splitlines()
    if len(lines) != 1 or not lines[0] or value not in {lines[0], f"{lines[0]}\n"}:
        raise ValueError("connection file must contain one canonical line")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in lines[0]):
        raise ValueError("connection file contains control characters")
    return lines[0], metadata_signature(opened), hashlib.sha256(content).digest()


def revalidate_origin(path: pathlib.Path, signature: tuple[int, ...], digest: bytes) -> None:
    """Prove the named origin still denotes the exact bytes used to build the session."""
    value, observed_signature, observed_digest = private_text(path)
    del value
    if observed_signature != signature or observed_digest != digest:
        raise ValueError("connection file changed during the PostgreSQL session")


def private_regular_bytes(path: pathlib.Path, label: str, *, maximum: int) -> bytes:
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_uid not in {0, os.geteuid()} or not 0 < before.st_size <= maximum):
        raise ValueError(f"{label} is not a readable owned single-link regular file")
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError(f"{label} changed while opening")
        content = os.read(descriptor, maximum + 1)
        final = os.fstat(descriptor)
        if len(content) != opened.st_size or metadata_signature(final) != metadata_signature(opened):
            raise ValueError(f"{label} changed while reading")
        return content
    finally:
        os.close(descriptor)


def parse_connection(value: str) -> tuple[dict[str, str], str]:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or parsed.fragment:
        raise ValueError("connection URL must be host-based PostgreSQL without a fragment")
    if not parsed.username or parsed.password is None:
        raise ValueError("connection URL must contain user and password")
    try:
        port = parsed.port or 5432
    except ValueError as error:
        raise ValueError("connection URL has an invalid port") from error
    database = urllib.parse.unquote(parsed.path.removeprefix("/"))
    user = urllib.parse.unquote(parsed.username)
    password = urllib.parse.unquote(parsed.password)
    host = parsed.hostname
    if not database or "/" in database or not user or not password:
        raise ValueError("connection URL must identify one database, user and password")
    for label, component in (("host", host), ("database", database), ("user", user), ("password", password)):
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in component):
            raise ValueError(f"connection URL {label} contains control characters")

    query: dict[str, str] = {}
    for key, item in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True):
        if key in query:
            raise ValueError("connection URL repeats a query parameter")
        if key not in ALLOWED_QUERY_KEYS:
            raise ValueError("connection URL contains an unsupported query parameter")
        if not item or any(ord(character) < 0x20 or ord(character) == 0x7F for character in item):
            raise ValueError("connection URL contains an invalid query parameter")
        query[key] = item
    if query.get("sslmode") != "verify-full":
        raise ValueError("connection URL must require sslmode=verify-full")
    root_certificate = query.get("sslrootcert", "")
    if not pathlib.Path(root_certificate).is_absolute():
        raise ValueError("connection URL must name an absolute sslrootcert")

    values = {
        "host": host,
        "port": str(port),
        "dbname": database,
        "user": user,
        **query,
    }
    return values, password


def service_value(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise ValueError("service value contains a line break")
    return value.replace("\\", "\\\\")


def pgpass_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:")


def write_private(path: pathlib.Path, content: str | bytes) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    try:
        payload = content.encode("utf-8") if isinstance(content, str) else content
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def inherited_read_descriptor(raw: str) -> int:
    try:
        descriptor = int(raw, 10)
    except ValueError as error:
        raise ValueError("preserved descriptor must be a decimal integer") from error
    if descriptor < 3:
        raise ValueError("preserved descriptor must not be a standard stream")
    metadata = os.fstat(descriptor)
    flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
    if not stat.S_ISREG(metadata.st_mode) or flags & os.O_ACCMODE != os.O_RDONLY:
        raise ValueError("preserved descriptor must be a read-only regular file")
    return descriptor


def main() -> int:
    arguments = sys.argv[1:]
    if len(arguments) < 3:
        raise SystemExit("usage: private-postgres-command.py URL_FILE [--pass-fd FD] -- COMMAND [ARG ...]")
    url_file = pathlib.Path(arguments[0])
    cursor = 1
    pass_fds: tuple[int, ...] = ()
    if arguments[cursor] == "--pass-fd":
        if len(arguments) < 5:
            raise SystemExit("usage: private-postgres-command.py URL_FILE [--pass-fd FD] -- COMMAND [ARG ...]")
        try:
            pass_fds = (inherited_read_descriptor(arguments[cursor + 1]),)
        except (OSError, ValueError):
            raise SystemExit("private PostgreSQL preserved descriptor is invalid") from None
        cursor += 2
    if arguments[cursor] != "--" or len(arguments) <= cursor + 1:
        raise SystemExit("usage: private-postgres-command.py URL_FILE [--pass-fd FD] -- COMMAND [ARG ...]")
    command = arguments[cursor + 1:]
    try:
        connection, origin_signature, origin_digest = private_text(url_file)
        values, password = parse_connection(connection)
    except (OSError, ValueError):
        raise SystemExit("private PostgreSQL connection file is invalid") from None

    directory = pathlib.Path(tempfile.mkdtemp(prefix="cauce-restore-libpq-"))
    os.chmod(directory, 0o700)
    try:
        service_file = directory / "pg_service.conf"
        pass_file = directory / ".pgpass"
        root_ca_file = directory / "postgres-root-ca.crt"
        try:
            root_ca = private_regular_bytes(
                pathlib.Path(values["sslrootcert"]), "PostgreSQL root CA", maximum=4 * 1024 * 1024,
            )
        except (OSError, ValueError):
            raise SystemExit("private PostgreSQL root CA is invalid") from None
        write_private(root_ca_file, root_ca)
        values["sslrootcert"] = os.fspath(root_ca_file)
        service = "[cauce_restore]\n" + "".join(
            f"{key}={service_value(value)}\n" for key, value in values.items()
        )
        pass_line = ":".join(
            pgpass_value(value)
            for value in (values["host"], values["port"], values["dbname"], values["user"], password)
        ) + "\n"
        write_private(service_file, service)
        write_private(pass_file, pass_line)
        environment = os.environ.copy()
        for key in (
            "DATABASE_URL", "DATABASE_URL_FILE", "PGPASSWORD", "PGPASSFILE", "PGSERVICE",
            "PGSERVICEFILE", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE",
            "PGSSLROOTCERT", "PGOPTIONS",
        ):
            environment.pop(key, None)
        environment.update({
            "PGSERVICE": "cauce_restore",
            "PGSERVICEFILE": os.fspath(service_file),
            "PGPASSFILE": os.fspath(pass_file),
            "CAUCE_PRIVATE_POSTGRES_SESSION": "prepared-v1",
        })
        completed = subprocess.run(command, check=False, env=environment, pass_fds=pass_fds)
        try:
            revalidate_origin(url_file, origin_signature, origin_digest)
        except (OSError, ValueError):
            print("private PostgreSQL connection origin changed during the session", file=sys.stderr)
            return 74
        return completed.returncode
    finally:
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
