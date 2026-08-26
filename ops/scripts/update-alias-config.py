#!/usr/bin/env python3
"""Actualiza un ``<alias>.env`` de forma atomica, reversible y con CAS.

Los ficheros de configuracion de los adaptadores se consideran privados aunque hoy no deban
contener secretos. Esta herramienta nunca escribe valores en stdout/stderr: solo alias, digests,
nombres de claves y el nombre opaco del backup. Los cambios se serializan con ``flock``, comparan
el digest esperado bajo el lock, respaldan los bytes anteriores con modo 0600 y publican mediante
``fsync`` + ``rename`` + ``fsync`` del directorio.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import stat
import sys
import time
from dataclasses import dataclass, replace
from typing import Any


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
    """Argparse normalmente repite el token invalido, que podria contener ``KEY=valor``."""

    def error(self, message: str) -> None:  # noqa: ARG002 - no se debe reflejar el mensaje crudo
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
    if not stat.S_ISDIR(details.st_mode) or details.st_uid != os.geteuid():
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
        or details.st_uid != os.geteuid()
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


def load_inventory(
    path: pathlib.Path,
    alias: str,
    hermes_runtime_path: pathlib.Path,
) -> AliasPolicy:
    try:
        inventory_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            details = os.fstat(inventory_fd)
            if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o022:
                raise ConfigUpdateError(
                    "el inventario debe ser regular y no escribible por grupo u otros"
                )
            inventory_body = read_all(inventory_fd, "inventario")
        finally:
            os.close(inventory_fd)
        raw: Any = json.loads(inventory_body.decode("utf-8"))
    except ConfigUpdateError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigUpdateError("no se pudo leer un inventario valido") from error
    if not isinstance(raw, dict) or not isinstance(raw.get("aliases"), dict):
        raise ConfigUpdateError("el inventario no declara aliases validos")
    aliases: dict[str, Any] = raw["aliases"]
    entry = aliases.get(alias)
    if not isinstance(entry, dict):
        raise ConfigUpdateError("el alias no existe en el inventario activo")
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


def is_absolute_value(value: str) -> bool:
    return (
        ABSOLUTE_RE.fullmatch(value) is not None
        and "//" not in value
        and all(component not in (".", "..") for component in value.split("/")[1:])
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
    """Autoriza una reversa exacta sólo después de autenticar su procedencia.

    Un backup es la imagen *anterior* a una mutacion. Puede preceder a una clave requerida o a una
    allowlist nueva, de modo que validarlo contra la politica de hoy convierte una reversa real en
    imposible. ``read_backup`` exige nombre/digest, fichero privado y un recibo HMAC emitido por
    este helper para el mismo alias y ligado al digest sucesor que produjo esa mutación. La reversa
    es causal y de un solo uso: no es un selector histórico reproducible contra estados arbitrarios.
    Aquí conservamos estructura y la ruta PKI que el supervisor exige; los bytes se publican sin
    reinterpretarlos.

    Esto no permite usar un fichero arbitrario como restore: sin el recibo autenticado falla antes
    de llegar aquí. Y la siguiente operacion ``apply`` vuelve a imponer toda la politica vigente.
    """

    if not isinstance(document, EnvDocument):  # pragma: no cover - guarda de contrato interno
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


def load_backup_auth_key(backups_fd: int, *, create: bool) -> bytes:
    while True:
        try:
            fd = open_regular_at(backups_fd, BACKUP_AUTH_KEY, os.O_RDONLY)
        except FileNotFoundError:
            if not create:
                raise ConfigUpdateError("el backup no tiene autenticacion emitida por el helper") from None
            candidate = secrets.token_bytes(BACKUP_AUTH_KEY_BYTES)
            try:
                fd = open_regular_at(
                    backups_fd,
                    BACKUP_AUTH_KEY,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    mode=0o600,
                )
            except FileExistsError:
                continue
            try:
                os.fchmod(fd, 0o600)
                write_all(fd, candidate)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(backups_fd)
            continue
        try:
            assert_private_regular(fd, "clave de autenticacion de backups")
            key = read_all(fd, "clave de autenticacion de backups")
        finally:
            os.close(fd)
        if len(key) != BACKUP_AUTH_KEY_BYTES:
            raise ConfigUpdateError("la clave de autenticacion de backups es invalida")
        return key


def backup_receipt(
    key: bytes, alias: str, name: str, body: bytes, successor_digest: str,
) -> bytes:
    """Authenticate a causal edge ``body -> successor`` rather than a free-standing snapshot."""

    if DIGEST_RE.fullmatch(successor_digest) is None:
        raise ConfigUpdateError("el sucesor del backup no es un digest valido")
    payload: dict[str, object] = {
        "schemaVersion": BACKUP_RECEIPT_VERSION,
        "alias": alias,
        "backup": name,
        "bodySha256": content_digest(body),
        "successorSha256": successor_digest,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    message = b"cauce-v3-config-backup-v2\0" + canonical + b"\0" + body
    payload["hmacSha256"] = hmac.new(key, message, hashlib.sha256).hexdigest()
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def create_backup(backups_fd: int, alias: str, body: bytes, successor_digest: str) -> str:
    key = load_backup_auth_key(backups_fd, create=True)
    digest_hex = content_digest(body).removeprefix("sha256:")
    for _ in range(8):
        name = f"{alias}.{digest_hex}.{time.time_ns()}.{secrets.token_hex(8)}.env"
        receipt_name = f"{name}{BACKUP_RECEIPT_SUFFIX}"
        body_created = False
        receipt_created = False
        try:
            fd = open_regular_at(
                backups_fd,
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                mode=0o600,
            )
        except FileExistsError:
            continue
        try:
            body_created = True
            os.fchmod(fd, 0o600)
            write_all(fd, body)
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            receipt_fd = open_regular_at(
                backups_fd,
                receipt_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                mode=0o600,
            )
            try:
                receipt_created = True
                os.fchmod(receipt_fd, 0o600)
                write_all(receipt_fd, backup_receipt(key, alias, name, body, successor_digest))
                os.fsync(receipt_fd)
            finally:
                os.close(receipt_fd)
            os.fsync(backups_fd)
            return name
        except BaseException:
            if receipt_created:
                os.unlink(receipt_name, dir_fd=backups_fd)
            if body_created:
                os.unlink(name, dir_fd=backups_fd)
            os.fsync(backups_fd)
            raise
    raise ConfigUpdateError("no se pudo reservar un nombre de backup unico")


def atomic_replace(config_root_fd: int, config_name: str, body: bytes, original: os.stat_result) -> None:
    temporary_name = f".{config_name}.cas-{os.getpid()}-{secrets.token_hex(8)}"
    temporary_fd: int | None = None
    try:
        temporary_fd = open_regular_at(
            config_root_fd,
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode=0o600,
        )
        os.fchown(temporary_fd, original.st_uid, original.st_gid)
        os.fchmod(temporary_fd, 0o600)
        write_all(temporary_fd, body)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None

        current_fd = open_regular_at(config_root_fd, config_name, os.O_RDONLY)
        try:
            current = assert_private_regular(current_fd, "configuracion del alias")
            if file_identity(current) != file_identity(original):
                raise ConfigUpdateError("compare-and-swap fallo: el fichero cambio durante la actualizacion")
        finally:
            os.close(current_fd)
        os.replace(
            temporary_name,
            config_name,
            src_dir_fd=config_root_fd,
            dst_dir_fd=config_root_fd,
        )
        os.fsync(config_root_fd)
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=config_root_fd)
        except FileNotFoundError:
            pass


def read_current(config_root_fd: int, alias: str) -> tuple[EnvDocument, os.stat_result]:
    fd = open_regular_at(config_root_fd, f"{alias}.env", os.O_RDONLY)
    try:
        details = assert_private_regular(fd, "configuracion del alias")
        body = read_all(fd, "configuracion del alias")
    finally:
        os.close(fd)
    return parse_document(body), details


def with_lock(config_root_fd: int, alias: str, exclusive: bool) -> int:
    lock_fd = open_regular_at(
        config_root_fd,
        f".{alias}.config.lock",
        os.O_RDWR | os.O_CREAT,
        mode=0o600,
    )
    assert_private_regular(lock_fd, "lock de configuracion")
    fcntl.flock(lock_fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
    return lock_fd


def parse_backup_receipt(
    receipt: bytes,
    key: bytes,
    alias: str,
    name: str,
    body: bytes,
    expected_successor_digest: str | None = None,
) -> str:
    try:
        document = json.loads(receipt.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ConfigUpdateError("el recibo causal del backup es invalido") from None
    expected_keys = {
        "schemaVersion", "alias", "backup", "bodySha256", "successorSha256", "hmacSha256",
    }
    if not isinstance(document, dict) or set(document) != expected_keys:
        raise ConfigUpdateError("el recibo causal del backup es invalido")
    supplied_mac = document.pop("hmacSha256")
    successor_digest = document.get("successorSha256")
    if (document.get("schemaVersion") != BACKUP_RECEIPT_VERSION
            or document.get("alias") != alias
            or document.get("backup") != name
            or document.get("bodySha256") != content_digest(body)
            or not isinstance(successor_digest, str)
            or DIGEST_RE.fullmatch(successor_digest) is None
            or (expected_successor_digest is not None
                and successor_digest != expected_successor_digest)
            or not isinstance(supplied_mac, str)
            or re.fullmatch(r"[a-f0-9]{64}", supplied_mac) is None):
        raise ConfigUpdateError("el backup no pertenece al estado sucesor actual")
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    message = b"cauce-v3-config-backup-v2\0" + canonical + b"\0" + body
    expected_mac = hmac.new(key, message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied_mac, expected_mac):
        raise ConfigUpdateError("la autenticacion del backup no coincide")
    return successor_digest


def consumption_journal_body(key: bytes, journal: ConsumptionJournal) -> bytes:
    payload: dict[str, object] = {
        "schemaVersion": BACKUP_CONSUMPTION_VERSION,
        "state": journal.state,
        "alias": journal.alias,
        "backup": journal.backup,
        "successorSha256": journal.successor_digest,
        "targetSha256": journal.target_digest,
        "replacementBackup": journal.replacement_backup,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    message = b"cauce-v3-config-consumption-v1\0" + canonical
    payload["hmacSha256"] = hmac.new(key, message, hashlib.sha256).hexdigest()
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def parse_consumption_journal(
    body: bytes, key: bytes, alias: str, name: str,
) -> ConsumptionJournal:
    # Version 0 was a durable one-way marker. It cannot be recovered, but it remains consumed
    # rather than accidentally becoming reusable after this upgrade.
    if body == b"consumed\n":
        raise ConfigUpdateError("el backup causal ya fue consumido")
    try:
        document = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ConfigUpdateError("el journal de consumo del backup es invalido") from None
    expected_keys = {
        "schemaVersion", "state", "alias", "backup", "successorSha256", "targetSha256",
        "replacementBackup", "hmacSha256",
    }
    if not isinstance(document, dict) or set(document) != expected_keys:
        raise ConfigUpdateError("el journal de consumo del backup es invalido")
    supplied_mac = document.pop("hmacSha256")
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    expected_mac = hmac.new(
        key, b"cauce-v3-config-consumption-v1\0" + canonical, hashlib.sha256,
    ).hexdigest()
    successor_digest = document.get("successorSha256")
    target_digest = document.get("targetSha256")
    replacement_backup = document.get("replacementBackup")
    replacement_match = (
        BACKUP_RE.fullmatch(replacement_backup) if isinstance(replacement_backup, str) else None
    )
    if (document.get("schemaVersion") != BACKUP_CONSUMPTION_VERSION
            or document.get("state") not in ("pending", "committed")
            or document.get("alias") != alias
            or document.get("backup") != name
            or not isinstance(successor_digest, str)
            or DIGEST_RE.fullmatch(successor_digest) is None
            or not isinstance(target_digest, str)
            or DIGEST_RE.fullmatch(target_digest) is None
            or replacement_match is None
            or replacement_match.group("alias") != alias
            or replacement_backup == name
            or not isinstance(supplied_mac, str)
            or re.fullmatch(r"[a-f0-9]{64}", supplied_mac) is None
            or not hmac.compare_digest(supplied_mac, expected_mac)):
        raise ConfigUpdateError("el journal de consumo del backup es invalido")
    return ConsumptionJournal(
        state=document["state"],
        alias=alias,
        backup=name,
        successor_digest=successor_digest,
        target_digest=target_digest,
        replacement_backup=replacement_backup,
    )


def read_consumption_journal(
    backups_fd: int, key: bytes, alias: str, name: str,
) -> ConsumptionJournal | None:
    journal_name = f"{name}{BACKUP_RECEIPT_SUFFIX}{BACKUP_USED_SUFFIX}"
    try:
        journal_fd = open_regular_at(backups_fd, journal_name, os.O_RDONLY)
    except FileNotFoundError:
        return None
    try:
        assert_private_regular(journal_fd, "journal de consumo del backup")
        body = read_all(journal_fd, "journal de consumo del backup")
    finally:
        os.close(journal_fd)
    return parse_consumption_journal(body, key, alias, name)


def write_consumption_journal(
    backups_fd: int,
    key: bytes,
    journal: ConsumptionJournal,
    *,
    create: bool,
) -> None:
    journal_name = f"{journal.backup}{BACKUP_RECEIPT_SUFFIX}{BACKUP_USED_SUFFIX}"
    temporary_name = f".{journal_name}.cas-{os.getpid()}-{secrets.token_hex(8)}"
    temporary_fd: int | None = None
    try:
        temporary_fd = open_regular_at(
            backups_fd,
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode=0o600,
        )
        os.fchmod(temporary_fd, 0o600)
        write_all(temporary_fd, consumption_journal_body(key, journal))
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        if create:
            try:
                os.stat(journal_name, dir_fd=backups_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ConfigUpdateError("el journal de consumo ya existe")
            # All legitimate writers hold the exclusive alias lock. Publishing the complete,
            # fsynced inode with one rename means a crash leaves either no journal or one valid
            # single-link journal; a hard-link publish would leave nlink=2 if killed mid-cleanup.
            os.replace(
                temporary_name,
                journal_name,
                src_dir_fd=backups_fd,
                dst_dir_fd=backups_fd,
            )
            os.fsync(backups_fd)
        else:
            current_fd = open_regular_at(backups_fd, journal_name, os.O_RDONLY)
            try:
                assert_private_regular(current_fd, "journal de consumo del backup")
            finally:
                os.close(current_fd)
            os.replace(
                temporary_name,
                journal_name,
                src_dir_fd=backups_fd,
                dst_dir_fd=backups_fd,
            )
            os.fsync(backups_fd)
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=backups_fd)
        except FileNotFoundError:
            pass


def read_backup(backups_fd: int, alias: str, name: str) -> tuple[EnvDocument, str]:
    matched = BACKUP_RE.fullmatch(name)
    if matched is None or matched.group("alias") != alias:
        raise ConfigUpdateError("el nombre de backup no pertenece al alias")
    fd = open_regular_at(backups_fd, name, os.O_RDONLY)
    try:
        assert_private_regular(fd, "backup del alias")
        body = read_all(fd, "backup del alias")
    finally:
        os.close(fd)
    expected_hex = name.split(".", 2)[1]
    if content_digest(body) != f"sha256:{expected_hex}":
        raise ConfigUpdateError("el backup no coincide con el digest de su nombre")
    key = load_backup_auth_key(backups_fd, create=False)
    try:
        receipt_fd = open_regular_at(backups_fd, f"{name}{BACKUP_RECEIPT_SUFFIX}", os.O_RDONLY)
    except FileNotFoundError:
        raise ConfigUpdateError("el backup no tiene autenticacion emitida por el helper") from None
    try:
        assert_private_regular(receipt_fd, "recibo de autenticacion del backup")
        receipt = read_all(receipt_fd, "recibo de autenticacion del backup")
    finally:
        os.close(receipt_fd)
    successor_digest = parse_backup_receipt(receipt, key, alias, name, body)
    return parse_document(body, "backup del alias"), successor_digest


def validate_pending_consumption(
    backups_fd: int,
    journal: ConsumptionJournal,
    *,
    successor_digest: str,
    target_digest: str,
) -> None:
    if (journal.successor_digest != successor_digest
            or journal.target_digest != target_digest):
        raise ConfigUpdateError("el journal de consumo no coincide con la reversa solicitada")
    replacement_document, replacement_successor = read_backup(
        backups_fd, journal.alias, journal.replacement_backup,
    )
    if (content_digest(replacement_document.body) != successor_digest
            or replacement_successor != target_digest):
        raise ConfigUpdateError("el journal de consumo no conserva una reversa autenticada")


def inspect(config_root: pathlib.Path, alias: str) -> dict[str, object]:
    root_fd = open_absolute_directory(config_root, "raiz de configuracion")
    try:
        assert_secure_directory(root_fd, "raiz de configuracion")
        lock_fd = with_lock(root_fd, alias, exclusive=False)
        try:
            current, _ = read_current(root_fd, alias)
            return {"status": "ok", "alias": alias, "digest": content_digest(current.body)}
        finally:
            os.close(lock_fd)
    finally:
        os.close(root_fd)


def mutate(
    config_root: pathlib.Path,
    pki_root: pathlib.Path,
    policy: AliasPolicy,
    expected_digest: str,
    *,
    updates: dict[str, str] | None = None,
    unsets: frozenset[str] = frozenset(),
    backup_name: str | None = None,
) -> dict[str, object]:
    if DIGEST_RE.fullmatch(expected_digest) is None:
        raise ConfigUpdateError("expected-old-digest debe ser un digest sha256 exacto")
    root_fd = open_absolute_directory(config_root, "raiz de configuracion")
    try:
        assert_secure_directory(root_fd, "raiz de configuracion")
        lock_fd = with_lock(root_fd, policy.alias, exclusive=True)
        try:
            current, current_stat = read_current(root_fd, policy.alias)
            old_digest = content_digest(current.body)
            if old_digest != expected_digest:
                raise ConfigUpdateError("compare-and-swap fallo: el digest anterior cambio")

            removed: list[str] = []
            if backup_name is None:
                target, removed = render_update(current, policy, pki_root, updates or {}, unsets)
                if target.body == current.body:
                    return {
                        "status": "unchanged",
                        "alias": policy.alias,
                        "oldDigest": old_digest,
                        "newDigest": old_digest,
                        "backup": None,
                        "removedKeys": removed,
                    }
                backups_fd = ensure_backups_directory(root_fd)
                try:
                    created_backup = create_backup(
                        backups_fd,
                        policy.alias,
                        current.body,
                        content_digest(target.body),
                    )
                finally:
                    os.close(backups_fd)
                atomic_replace(root_fd, f"{policy.alias}.env", target.body, current_stat)
                return {
                    "status": "updated",
                    "alias": policy.alias,
                    "oldDigest": old_digest,
                    "newDigest": content_digest(target.body),
                    "backup": created_backup,
                    "removedKeys": removed,
                }

            backups_fd = ensure_backups_directory(root_fd)
            try:
                target, successor_digest = read_backup(backups_fd, policy.alias, backup_name)
                validate_restore_policy(target, policy, pki_root)
                target_digest = content_digest(target.body)
                if target_digest == successor_digest:
                    raise ConfigUpdateError("el recibo causal del backup no describe una mutacion")
                key = load_backup_auth_key(backups_fd, create=False)
                journal = read_consumption_journal(
                    backups_fd, key, policy.alias, backup_name,
                )
                if journal is None:
                    if old_digest != successor_digest:
                        raise ConfigUpdateError("el backup no pertenece al estado sucesor actual")
                    created_backup = create_backup(
                        backups_fd,
                        policy.alias,
                        current.body,
                        target_digest,
                    )
                    journal = ConsumptionJournal(
                        state="pending",
                        alias=policy.alias,
                        backup=backup_name,
                        successor_digest=successor_digest,
                        target_digest=target_digest,
                        replacement_backup=created_backup,
                    )
                    write_consumption_journal(backups_fd, key, journal, create=True)
                else:
                    if journal.state == "committed":
                        raise ConfigUpdateError("el backup causal ya fue consumido")
                    validate_pending_consumption(
                        backups_fd,
                        journal,
                        successor_digest=successor_digest,
                        target_digest=target_digest,
                    )
                    created_backup = journal.replacement_backup
                    if old_digest == target_digest:
                        write_consumption_journal(
                            backups_fd, key, replace(journal, state="committed"), create=False,
                        )
                        return {
                            "status": "unchanged",
                            "alias": policy.alias,
                            "oldDigest": old_digest,
                            "newDigest": target_digest,
                            "backup": created_backup,
                            "removedKeys": removed,
                        }
                    if old_digest != successor_digest:
                        raise ConfigUpdateError(
                            "el journal de consumo no coincide con el estado actual"
                        )
            finally:
                os.close(backups_fd)

            # The pending record is durable before publication. A crash on either side of this
            # replace is recovered under the same alias lock from the observed config digest.
            atomic_replace(root_fd, f"{policy.alias}.env", target.body, current_stat)
            backups_fd = ensure_backups_directory(root_fd)
            try:
                durable_journal = read_consumption_journal(
                    backups_fd, key, policy.alias, backup_name,
                )
                if durable_journal != journal or durable_journal.state != "pending":
                    raise ConfigUpdateError("el journal de consumo cambio durante la publicacion")
                write_consumption_journal(
                    backups_fd, key, replace(journal, state="committed"), create=False,
                )
            finally:
                os.close(backups_fd)
            return {
                "status": "updated",
                "alias": policy.alias,
                "oldDigest": old_digest,
                "newDigest": target_digest,
                "backup": created_backup,
                "removedKeys": removed,
            }
        finally:
            os.close(lock_fd)
    finally:
        os.close(root_fd)


def defaults() -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path]:
    ops_root = pathlib.Path(__file__).resolve().parents[1]
    inventory = ops_root / "container-aliases.json"
    hermes_runtime = ops_root / "hermes-runtime.json"
    if os.geteuid() == 0:
        config_root = pathlib.Path("/etc/cauce-v3/container-aliases")
        pki_root = pathlib.Path("/etc/cauce-v3/container-pki")
    else:
        config_home = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config"))
        config_root = config_home / "cauce-v3/container-aliases"
        pki_root = config_home / "cauce-v3/container-pki"
    return inventory, hermes_runtime, config_root, pki_root


def parser() -> SafeArgumentParser:
    inventory, hermes_runtime, config_root, pki_root = defaults()
    root = SafeArgumentParser(description="Actualizacion CAS de configs Cauce por alias")
    root.add_argument("--inventory", type=pathlib.Path, default=inventory)
    root.add_argument("--hermes-runtime", type=pathlib.Path, default=hermes_runtime)
    root.add_argument("--config-root", type=pathlib.Path, default=config_root)
    root.add_argument("--pki-root", type=pathlib.Path, default=pki_root)
    actions = root.add_subparsers(
        dest="action", required=True, parser_class=SafeArgumentParser
    )
    for action in ("inspect", "apply", "restore"):
        command = actions.add_parser(action)
        command.add_argument("--alias", required=True)
        if action != "inspect":
            command.add_argument("--expected-old-digest", required=True)
        if action == "apply":
            command.add_argument("--set", action="append", default=[])
            command.add_argument("--unset", action="append", default=[])
        if action == "restore":
            command.add_argument("--backup", required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    alias = arguments.alias
    if ALIAS_RE.fullmatch(alias) is None:
        raise ConfigUpdateError("el alias tiene formato invalido")
    policy = load_inventory(arguments.inventory, alias, arguments.hermes_runtime)
    if arguments.action == "inspect":
        result = inspect(arguments.config_root, alias)
    elif arguments.action == "apply":
        updates = parse_sets(arguments.set)
        unsets = frozenset(arguments.unset)
        if any(KEY_RE.fullmatch(key) is None for key in unsets):
            raise ConfigUpdateError("una clave --unset tiene formato invalido")
        overlap = sorted(frozenset(updates) & unsets)
        if overlap:
            raise ConfigUpdateError(
                "una clave no puede aparecer a la vez en --set y --unset: " + ",".join(overlap)
            )
        result = mutate(
            arguments.config_root,
            arguments.pki_root,
            policy,
            arguments.expected_old_digest,
            updates=updates,
            unsets=unsets,
        )
    else:
        result = mutate(
            arguments.config_root,
            arguments.pki_root,
            policy,
            arguments.expected_old_digest,
            backup_name=arguments.backup,
        )
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigUpdateError as error:
        print(f"config update failed: {error}", file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        # No se refleja el error crudo: una excepcion de parser o filesystem podria cargar la linea
        # o el contenido que fallo. El detalle operacional vive en los gates, no en valores.
        print("config update failed: error operacional no divulgado", file=sys.stderr)
        raise SystemExit(2) from None
