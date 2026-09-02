#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
from dataclasses import dataclass
from typing import Any

_scripts_dir = str(pathlib.Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from container_alias_lib import (  # noqa: E402  same-directory ops library (stdlib-only)
    AliasNotDeclaredError,
    ContainerAliasError,
    InventoryAccessError,
    InventorySizeError,
    read_alias_entry,
)

MAX_CONFIG_BYTES = 1024 * 1024
ALIAS_RE = re.compile(r"[a-z][a-z0-9-]*\Z")
KEY_RE = re.compile(r"[A-Z][A-Z0-9_]*\Z")
DIGEST_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
SEMVER_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
RELEASE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
COMMIT_RE = re.compile(r"[a-f0-9]{40}\Z")
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z")
LABEL_KEY_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\Z")
LABEL_VALUE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
RELAY_RE = re.compile(
    r"wss://(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::(?P<port>[0-9]{1,5}))?"
    r"(?:/[A-Za-z0-9._~%/-]*)?\Z"
)
LOOPBACK_OPENCLAW_RE = re.compile(
    r"https?://(?:127\.0\.0\.1|localhost)(?::(?P<port>[0-9]{1,5}))?/v1/chat/completions\Z"
)
ABSOLUTE_RE = re.compile(r"/(?:[^/\x00]+/)*[^/\x00]+\Z")
BACKUP_RE = re.compile(
    r"(?P<alias>[a-z][a-z0-9-]*)\.[a-f0-9]{64}\.[0-9]{16,20}\.[a-f0-9]{16}\.env\Z"
)
BACKUP_AUTH_KEY = ".backup-auth-key"
BACKUP_AUTH_KEY_BYTES = 32
BACKUP_RECEIPT_SUFFIX = ".receipt"
BACKUP_USED_SUFFIX = ".used"
BACKUP_RECEIPT_VERSION = 2
BACKUP_CONSUMPTION_VERSION = 1

COMMON_ALLOWED = frozenset(
    {
        "BUNDLE_RELEASE",
        "BUNDLE_SHA256",
        "PKI_DIR",
        "RELAY_URL",
        "EXPECTED_IMAGE_ID",
        "EXPECTED_LABEL_KEY",
        "EXPECTED_LABEL_VALUE",
        "MOUNT_TYPE",
        "MOUNT_SOURCE",
        "MOUNT_NAME",
        "MOUNT_DESTINATION",
        "MOUNT_RW",
        "DEFAULT_TIMEOUT_MS",
        "CAUCE_SEMBRAR_PERFIL",
    }
)
COMMON_REQUIRED = frozenset(
    {
        "BUNDLE_RELEASE",
        "BUNDLE_SHA256",
        "PKI_DIR",
        "RELAY_URL",
        "EXPECTED_IMAGE_ID",
        "CAUCE_SEMBRAR_PERFIL",
    }
)
HARNESS_ALLOWED: dict[str, frozenset[str]] = {
    "claude": frozenset(
        {"EXPECTED_CLI_VERSION", "SHARED_SESSION", "SHARED_SESSION_WORKSPACE", "CONFIG_POR_ALIAS"}
    ),
    "codex": frozenset({"SHARED_SESSION", "SHARED_SESSION_WORKSPACE", "CONFIG_POR_ALIAS"}),
    "hermes": frozenset(
        {"HERMES_HOME", "HERMES_INFERENCE_MODEL", "HERMES_PYTHON", "HERMES_SOURCE_COMMIT"}
    ),
    "openclaw": frozenset(
        {
            "OPENCLAW_TRANSPORT",
            "OPENCLAW_API_URL",
            "OPENCLAW_TOKEN_FILE",
            "OPENCLAW_AGENT_TARGET",
            "OPENCLAW_DIST_DIR",
            "OPENCLAW_WORKSPACE",
        }
    ),
}
HARNESS_REQUIRED: dict[str, frozenset[str]] = {
    "claude": frozenset({"EXPECTED_CLI_VERSION"}),
    "codex": frozenset(),
    "hermes": frozenset(
        {"HERMES_HOME", "HERMES_INFERENCE_MODEL", "HERMES_PYTHON", "HERMES_SOURCE_COMMIT"}
    ),
    "openclaw": frozenset({"OPENCLAW_WORKSPACE"}),
}


class ConfigUpdateError(RuntimeError):
    """Fallo esperado cuyo texto esta garantizado que no contiene valores de config."""


class SafeArgumentParser(argparse.ArgumentParser):
    """Argparse normalmente repite el token invalido, que podria contener KEY=valor."""

    def error(self, message: str) -> None:
        raise ConfigUpdateError("linea de comandos invalida")


@dataclass(frozen=True)
class AliasPolicy:
    alias: str
    harness: str
    allowed: frozenset[str]
    required: frozenset[str]
    home: str
    state_directory: str | None
    canonical_workspace: str | None
    requires_isolated_config: bool
    approved_hermes_commit: str | None
    approved_hermes_runtime_root: str | None
    approved_hermes_runtime_id: str | None


@dataclass(frozen=True)
class EnvDocument:
    body: bytes
    lines: tuple[str, ...]
    keys: dict[str, tuple[int, str]]


@dataclass(frozen=True)
class ConsumptionJournal:
    state: str
    alias: str
    backup: str
    successor_digest: str
    target_digest: str
    replacement_backup: str


def content_digest(body: bytes) -> str:
    return f"sha256:{hashlib.sha256(body).hexdigest()}"


def validate_absolute(path: pathlib.Path, label: str) -> None:
    raw = os.fspath(path)
    if (
        not raw.startswith("/")
        or "//" in raw
        or "\x00" in raw
        or any(component in ("", ".", "..") for component in raw.split("/")[1:])
    ):
        raise ConfigUpdateError(f"{label} debe ser una ruta absoluta canonica")


def open_absolute_directory(path: pathlib.Path, label: str) -> int:
    """Abre cada componente sin seguir symlinks."""
    validate_absolute(path, label)
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in os.fspath(path).split("/")[1:]:
            following = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=current,
            )
            os.close(current)
            current = following
        return current
    except Exception:
        os.close(current)
        raise


def assert_secure_directory(fd: int, label: str, mode: int | None = None) -> os.stat_result:
    details = os.fstat(fd)
    if not stat.S_ISDIR(details.st_mode) or (os.geteuid() != 0 and details.st_uid != os.geteuid()):
        raise ConfigUpdateError(f"{label} debe pertenecer al usuario efectivo")
    if details.st_mode & 0o022:
        raise ConfigUpdateError(f"{label} no puede ser escribible por grupo u otros")
    if mode is not None and stat.S_IMODE(details.st_mode) != mode:
        raise ConfigUpdateError(f"{label} debe tener modo {mode:04o}")
    return details


def open_regular_at(
    directory_fd: int,
    name: str,
    flags: int,
    *,
    mode: int | None = None,
) -> int:
    options = flags | os.O_NOFOLLOW | os.O_CLOEXEC
    if mode is None:
        return os.open(name, options, dir_fd=directory_fd)
    return os.open(name, options, mode, dir_fd=directory_fd)


def assert_private_regular(fd: int, label: str) -> os.stat_result:
    details = os.fstat(fd)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or (os.geteuid() != 0 and details.st_uid != os.geteuid())
        or stat.S_IMODE(details.st_mode) != 0o600
    ):
        raise ConfigUpdateError(
            f"{label} debe ser un fichero regular de un enlace, del usuario efectivo y modo 0600"
        )
    return details


def file_identity(details: os.stat_result) -> tuple[int, ...]:
    return (
        details.st_dev,
        details.st_ino,
        details.st_size,
        details.st_mtime_ns,
        details.st_ctime_ns,
        details.st_uid,
        details.st_gid,
        stat.S_IMODE(details.st_mode),
        details.st_nlink,
    )


def read_all(fd: int, label: str) -> bytes:
    details = os.fstat(fd)
    if details.st_size > MAX_CONFIG_BYTES:
        raise ConfigUpdateError(f"{label} excede el limite permitido")
    os.lseek(fd, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_CONFIG_BYTES:
            raise ConfigUpdateError(f"{label} excede el limite permitido")
    return b"".join(chunks)


def parse_document(body: bytes, label: str = "configuracion") -> EnvDocument:
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ConfigUpdateError(f"{label} no es UTF-8 valido") from error
    if "\x00" in text or "\r" in text:
        raise ConfigUpdateError(f"{label} contiene bytes prohibidos")
    if text and not text.endswith("\n"):
        raise ConfigUpdateError(f"{label} debe terminar con salto de linea")
    lines = tuple(text.splitlines(keepends=True))
    parsed: dict[str, tuple[int, str]] = {}
    for index, line_with_newline in enumerate(lines):
        line = line_with_newline.removesuffix("\n")
        if line == "" or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigUpdateError(f"{label} tiene sintaxis invalida")
        key, value = line.split("=", 1)
        if KEY_RE.fullmatch(key) is None or value == "":
            raise ConfigUpdateError(f"{label} tiene sintaxis invalida")
        if key in parsed:
            raise ConfigUpdateError(f"{label} duplica la clave {key}")
        parsed[key] = (index, value)
    return EnvDocument(body=body, lines=lines, keys=parsed)


def load_approved_hermes_runtime(path: pathlib.Path) -> tuple[str, str, str]:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            details = os.fstat(fd)
            if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o022:
                raise ConfigUpdateError(
                    "el manifest Hermes debe ser regular y no escribible por grupo u otros"
                )
            body = read_all(fd, "manifest Hermes")
        finally:
            os.close(fd)
        raw: Any = json.loads(body.decode("utf-8"))
        commit = raw.get("commit") if isinstance(raw, dict) else None
        runtime_root = raw.get("runtimeRoot") if isinstance(raw, dict) else None
        runtime_id = raw.get("runtimeId") if isinstance(raw, dict) else None
    except ConfigUpdateError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigUpdateError("no se pudo leer el manifest Hermes aprobado") from error
    if not isinstance(commit, str) or COMMIT_RE.fullmatch(commit) is None:
        raise ConfigUpdateError("el manifest Hermes no fija un commit valido")
    if runtime_root != "/opt/cauce-v3-hermes-runtime":
        raise ConfigUpdateError("el manifest Hermes no fija la raiz inmutable aprobada")
    if not isinstance(runtime_id, str) or RELEASE_RE.fullmatch(runtime_id) is None:
        raise ConfigUpdateError("el manifest Hermes no fija un runtime ID valido")
    return commit, runtime_root, runtime_id


def is_absolute_value(value: str) -> bool:
    return (
        ABSOLUTE_RE.fullmatch(value) is not None
        and "//" not in value
        and all(component not in (".", "..") for component in value.split("/")[1:])
    )


def load_inventory(
    path: pathlib.Path,
    alias: str,
    hermes_runtime_path: pathlib.Path,
) -> AliasPolicy:
    """Derive the runtime policy of ``alias`` from the inventory at ``path``.

    The canonical reader owns the hardened open (no symlink, regular file, not writable by
    group or others) and the alias-entry shape; the policy below stays here because only this
    tool knows which keys each harness requires.
    """
    try:
        aliases, entry = read_alias_entry(path, alias, hardened=True)
    except InventorySizeError as error:
        raise ConfigUpdateError("inventario excede el limite permitido") from error
    except InventoryAccessError as error:
        raise ConfigUpdateError(
            "el inventario debe ser regular y no escribible por grupo u otros"
        ) from error
    except AliasNotDeclaredError as error:
        raise ConfigUpdateError("el alias no existe en el inventario activo") from error
    except ContainerAliasError as error:
        raise ConfigUpdateError("el inventario no declara aliases validos") from error
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigUpdateError("no se pudo leer un inventario valido") from error
    harness = entry.get("harness")
    container = entry.get("container")
    home = entry.get("home")
    state_directory = entry.get("stateDirectory")
    docker_host = entry.get("dockerHost", "local")
    if (
        harness not in HARNESS_ALLOWED
        or not isinstance(container, str)
        or not container
        or not isinstance(home, str)
        or not is_absolute_value(home)
        or (state_directory is not None and not isinstance(state_directory, str))
        or (isinstance(state_directory, str) and not is_absolute_value(state_directory))
    ):
        raise ConfigUpdateError("el alias tiene una politica de runtime invalida")
    physical_count = sum(
        1
        for candidate in aliases.values()
        if isinstance(candidate, dict)
        and candidate.get("container") == container
        and candidate.get("dockerHost", "local") == docker_host
    )
    requires_isolated = physical_count > 1 and harness in {"claude", "codex"}
    required = COMMON_REQUIRED | HARNESS_REQUIRED[harness]
    if requires_isolated:
        required |= frozenset({"CONFIG_POR_ALIAS"})
    workspace = entry.get("workspace")
    approved_hermes = (
        load_approved_hermes_runtime(hermes_runtime_path) if harness == "hermes" else None
    )
    return AliasPolicy(
        alias=alias,
        harness=harness,
        allowed=COMMON_ALLOWED | HARNESS_ALLOWED[harness],
        required=required,
        home=home,
        state_directory=state_directory,
        canonical_workspace=workspace if isinstance(workspace, str) else None,
        requires_isolated_config=requires_isolated,
        approved_hermes_commit=approved_hermes[0] if approved_hermes is not None else None,
        approved_hermes_runtime_root=approved_hermes[1] if approved_hermes is not None else None,
        approved_hermes_runtime_id=approved_hermes[2] if approved_hermes is not None else None,
    )


def validate_policy(document: EnvDocument, policy: AliasPolicy, pki_root: pathlib.Path) -> None:
    present = frozenset(document.keys)
    incompatible = sorted(present - policy.allowed)
    if incompatible:
        raise ConfigUpdateError(
            "la configuracion conserva claves incompatibles: " + ",".join(incompatible)
        )
    missing = sorted(policy.required - present)
    if missing:
        raise ConfigUpdateError("la configuracion omite claves requeridas: " + ",".join(missing))

    values = {key: pair[1] for key, pair in document.keys.items()}
    validate_absolute(pki_root, "raiz PKI")
    expected_pki = os.fspath(pki_root / policy.alias)
    if values.get("PKI_DIR") != expected_pki:
        raise ConfigUpdateError("PKI_DIR no coincide con la ruta acotada del alias")
    if values.get("CAUCE_SEMBRAR_PERFIL") != "1":
        raise ConfigUpdateError("CAUCE_SEMBRAR_PERFIL debe ser exactamente 1")
    if "CONFIG_POR_ALIAS" in values and values["CONFIG_POR_ALIAS"] != "1":
        raise ConfigUpdateError("CONFIG_POR_ALIAS debe ser exactamente 1")
    if policy.requires_isolated_config and values.get("CONFIG_POR_ALIAS") != "1":
        raise ConfigUpdateError("el alias compartido requiere CONFIG_POR_ALIAS=1")
    if policy.harness == "claude" and SEMVER_RE.fullmatch(values.get("EXPECTED_CLI_VERSION", "")) is None:
        raise ConfigUpdateError("EXPECTED_CLI_VERSION debe ser una version semantica exacta")
    release = values.get("BUNDLE_RELEASE", "")
    if RELEASE_RE.fullmatch(release) is None or release == "current":
        raise ConfigUpdateError("BUNDLE_RELEASE tiene formato invalido")
    relay = RELAY_RE.fullmatch(values.get("RELAY_URL", ""))
    if relay is None or "@" in values.get("RELAY_URL", ""):
        raise ConfigUpdateError("RELAY_URL debe ser una URL wss sin credenciales, query ni fragmento")
    if relay.group("port") is not None and int(relay.group("port")) > 65535:
        raise ConfigUpdateError("RELAY_URL declara un puerto invalido")
    if "SHARED_SESSION" in values and values["SHARED_SESSION"] != "1":
        raise ConfigUpdateError("SHARED_SESSION debe ser exactamente 1")
    if "SHARED_SESSION_WORKSPACE" in values:
        if values.get("SHARED_SESSION") != "1":
            raise ConfigUpdateError("SHARED_SESSION_WORKSPACE requiere SHARED_SESSION=1")
        if not is_absolute_value(values["SHARED_SESSION_WORKSPACE"]):
            raise ConfigUpdateError("SHARED_SESSION_WORKSPACE debe ser una ruta absoluta canonica")
    if policy.harness == "openclaw":
        if policy.canonical_workspace is None:
            raise ConfigUpdateError("el inventario openclaw no declara workspace canonico")
        if values.get("OPENCLAW_WORKSPACE") != policy.canonical_workspace:
            raise ConfigUpdateError("OPENCLAW_WORKSPACE no coincide con el inventario")
        if not values["OPENCLAW_WORKSPACE"].startswith(f"{policy.home}/"):
            raise ConfigUpdateError("OPENCLAW_WORKSPACE debe vivir bajo el home inventariado")
        transport = values.get("OPENCLAW_TRANSPORT", "cli")
        if transport == "cli":
            if "OPENCLAW_API_URL" in values or "OPENCLAW_TOKEN_FILE" in values:
                raise ConfigUpdateError("OPENCLAW_API_URL/TOKEN_FILE requieren transporte api")
        elif transport == "api":
            api_url = LOOPBACK_OPENCLAW_RE.fullmatch(values.get("OPENCLAW_API_URL", ""))
            if api_url is None:
                raise ConfigUpdateError("OPENCLAW_API_URL debe ser el endpoint loopback verificado")
            if api_url.group("port") is not None and int(api_url.group("port")) > 65535:
                raise ConfigUpdateError("OPENCLAW_API_URL declara un puerto invalido")
            expected_token = f"/opt/cauce-v3-secrets/{policy.alias}/openclaw-token"
            if values.get("OPENCLAW_TOKEN_FILE") != expected_token:
                raise ConfigUpdateError("OPENCLAW_TOKEN_FILE no usa la ruta acotada del alias")
        else:
            raise ConfigUpdateError("OPENCLAW_TRANSPORT debe ser cli o api")
        if "OPENCLAW_AGENT_TARGET" in values and LABEL_KEY_RE.fullmatch(values["OPENCLAW_AGENT_TARGET"]) is None:
            raise ConfigUpdateError("OPENCLAW_AGENT_TARGET tiene formato invalido")
        if "OPENCLAW_DIST_DIR" in values and not is_absolute_value(values["OPENCLAW_DIST_DIR"]):
            raise ConfigUpdateError("OPENCLAW_DIST_DIR debe ser una ruta absoluta canonica")
    for key in ("PKI_DIR", "MOUNT_SOURCE", "MOUNT_DESTINATION", "HERMES_HOME", "HERMES_PYTHON"):
        if key in values and not is_absolute_value(values[key]):
            raise ConfigUpdateError(f"{key} debe ser una ruta absoluta canonica")
    if "BUNDLE_SHA256" in values and DIGEST_RE.fullmatch(values["BUNDLE_SHA256"]) is None:
        raise ConfigUpdateError("BUNDLE_SHA256 debe ser un digest sha256 exacto")
    if "EXPECTED_IMAGE_ID" in values and DIGEST_RE.fullmatch(values["EXPECTED_IMAGE_ID"]) is None:
        raise ConfigUpdateError("EXPECTED_IMAGE_ID debe ser un digest sha256 exacto")
    if "EXPECTED_LABEL_KEY" in values or "EXPECTED_LABEL_VALUE" in values:
        if "EXPECTED_LABEL_KEY" not in values or "EXPECTED_LABEL_VALUE" not in values:
            raise ConfigUpdateError("las claves EXPECTED_LABEL deben declararse juntas")
        if LABEL_KEY_RE.fullmatch(values["EXPECTED_LABEL_KEY"]) is None:
            raise ConfigUpdateError("EXPECTED_LABEL_KEY tiene formato invalido")
        if LABEL_VALUE_RE.fullmatch(values["EXPECTED_LABEL_VALUE"]) is None:
            raise ConfigUpdateError("EXPECTED_LABEL_VALUE tiene formato invalido")
    if "MOUNT_TYPE" in values and values["MOUNT_TYPE"] not in {"bind", "volume"}:
        raise ConfigUpdateError("MOUNT_TYPE debe ser bind o volume")
    if "MOUNT_RW" in values and values["MOUNT_RW"] != "true":
        raise ConfigUpdateError("MOUNT_RW debe ser true")
    if "MOUNT_NAME" in values:
        if values.get("MOUNT_TYPE") != "volume" or RELEASE_RE.fullmatch(values["MOUNT_NAME"]) is None:
            raise ConfigUpdateError("MOUNT_NAME requiere un volumen y formato valido")
    if "MOUNT_DESTINATION" in values and policy.state_directory is not None:
        destination = values["MOUNT_DESTINATION"].rstrip("/")
        if policy.state_directory != destination and not policy.state_directory.startswith(f"{destination}/"):
            raise ConfigUpdateError("MOUNT_DESTINATION no contiene el state directory inventariado")
    if "DEFAULT_TIMEOUT_MS" in values:
        timeout = values["DEFAULT_TIMEOUT_MS"]
        if not timeout.isdecimal() or len(timeout) > 9 or not 60_000 <= int(timeout) <= 604_800_000:
            raise ConfigUpdateError("DEFAULT_TIMEOUT_MS esta fuera del intervalo permitido")
    if policy.harness == "hermes":
        source_commit = values.get("HERMES_SOURCE_COMMIT", "")
        expected_home = f"{policy.home}/.local/share/cauce-v3/hermes/{policy.alias}"
        expected_python = (
            f"{policy.approved_hermes_runtime_root}/{policy.alias}/"
            f"{policy.approved_hermes_runtime_id}/venv/bin/python"
        )
        if COMMIT_RE.fullmatch(source_commit) is None:
            raise ConfigUpdateError("HERMES_SOURCE_COMMIT debe ser un commit Git exacto")
        if source_commit != policy.approved_hermes_commit:
            raise ConfigUpdateError("HERMES_SOURCE_COMMIT no coincide con el pin operacional aprobado")
        if values.get("HERMES_HOME") != expected_home:
            raise ConfigUpdateError("HERMES_HOME no usa el perfil persistente exacto del alias")
        if values.get("HERMES_PYTHON") != expected_python:
            raise ConfigUpdateError("HERMES_PYTHON no usa el runtime inmutable exacto del alias")
        if MODEL_RE.fullmatch(values.get("HERMES_INFERENCE_MODEL", "")) is None:
            raise ConfigUpdateError("HERMES_INFERENCE_MODEL tiene formato invalido")


def parse_sets(raw_sets: list[str]) -> dict[str, str]:
    updates: dict[str, str] = {}
    for raw in raw_sets:
        if "=" not in raw:
            raise ConfigUpdateError("una asignacion --set tiene sintaxis invalida")
        key, value = raw.split("=", 1)
        if KEY_RE.fullmatch(key) is None or value == "" or "\n" in value or "\r" in value or "\x00" in value:
            raise ConfigUpdateError("una asignacion --set tiene sintaxis invalida")
        if key in updates:
            raise ConfigUpdateError(f"la clave {key} aparece mas de una vez en --set")
        updates[key] = value
    return updates


def render_update(
    original: EnvDocument,
    policy: AliasPolicy,
    pki_root: pathlib.Path,
    updates: dict[str, str],
    requested_unsets: frozenset[str],
) -> tuple[EnvDocument, list[str]]:
    invalid_requested = sorted((frozenset(updates) | requested_unsets) - policy.allowed)
    if invalid_requested:
        raise ConfigUpdateError(
            "la actualizacion pide claves incompatibles: " + ",".join(invalid_requested)
        )
    incompatible = sorted(frozenset(original.keys) - policy.allowed)
    removed = frozenset(incompatible) | requested_unsets
    rendered: list[str] = []
    replaced: set[str] = set()
    for index, line in enumerate(original.lines):
        key = next((name for name, pair in original.keys.items() if pair[0] == index), None)
        if key is None:
            rendered.append(line)
            continue
        if key in removed:
            continue
        if key in updates:
            rendered.append(f"{key}={updates[key]}\n")
            replaced.add(key)
        else:
            rendered.append(line)
    for key in sorted(frozenset(updates) - replaced):
        rendered.append(f"{key}={updates[key]}\n")
    target = parse_document("".join(rendered).encode("utf-8"))
    validate_policy(target, policy, pki_root)
    return target, incompatible


def validate_restore_policy(
    document: EnvDocument, policy: AliasPolicy, pki_root: pathlib.Path,
) -> None:
    if not isinstance(document, EnvDocument):
        raise ConfigUpdateError("backup estructuralmente invalido")
    values = {key: pair[1] for key, pair in document.keys.items()}
    validate_absolute(pki_root, "raiz PKI")
    if values.get("PKI_DIR") != os.fspath(pki_root / policy.alias):
        raise ConfigUpdateError("el backup no conserva la ruta PKI acotada del alias")


def ensure_backups_directory(config_root_fd: int) -> int:
    try:
        os.mkdir("backups", 0o700, dir_fd=config_root_fd)
        os.fsync(config_root_fd)
    except FileExistsError:
        pass
    backups_fd = os.open(
        "backups",
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=config_root_fd,
    )
    assert_secure_directory(backups_fd, "directorio de backups", 0o700)
    return backups_fd


def write_all(fd: int, body: bytes) -> None:
    offset = 0
    while offset < len(body):
        written = os.write(fd, body[offset:])
        if written <= 0:
            raise ConfigUpdateError("no se pudo completar una escritura atomica")
        offset += written
