#!/usr/bin/env python3
"""Rollout transaccional del agente PTY en los dos managers de la flota.

El controlador se ejecuta desde un checkout de Cauce. El mismo fichero se envia como codigo
efimero al manager remoto: no presupone que el host ya tenga una copia mutable del deployer. Las
releases, en cambio, si quedan publicadas por digest y nunca se sobrescriben.

Este programa no lee ni transporta el contenido de configuraciones, claves o certificados. El
preflight local existente los valida en el manager que ya los custodia.
"""
from __future__ import annotations

import argparse
import base64
import dataclasses
import datetime as dt
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final


SCHEMA_VERSION: Final = 1
MANAGERS: Final = ("server", "kratos")
RETIRED_REQUIRED_DISABLED: Final = frozenset(("gaia", "heraclito", "tales"))
NAME_RE: Final = re.compile(r"^[a-z][a-z0-9.-]*$")
SHA_RE: Final = re.compile(r"^[a-f0-9]{64}$")
UNIT_RE: Final = re.compile(r"^cauce-v3-pty@([a-z][a-z0-9.-]*)\.service$")
MODE_RE: Final = re.compile(r"^[a-z][a-z0-9_-]*$")
RELEASE_FILES: Final = (
    "container-aliases.json",
    "scripts/container-alias-query.py",
    "scripts/container_alias_lib.py",
    "pty-agent/cauce-pty-launcher.sh",
    "pty-agent/cauce_pty_agent.py",
    "pty-agent/derive-alias-key.py",
    "pty-agent/install-pty-agent.sh",
    "pty-agent/systemd/cauce-v3-pty@.service",
    "pty-agent/rollout-pty.py",
)
EXECUTABLE_FILES: Final = frozenset(
    path for path in RELEASE_FILES if path.endswith((".py", ".sh"))
)


class RolloutError(RuntimeError):
    """Fallo cerrado y apto para mostrar sin material sensible."""


def fail(message: str) -> "None":
    raise RolloutError(message)


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode()


def duplicate_safe_json(raw: bytes, label: str) -> dict[str, Any]:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"{label} contiene una clave duplicada: {key}")
            result[key] = value
        return result

    try:
        value = json.loads(raw, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} no es JSON UTF-8 valido: {error}")
    if not isinstance(value, dict):
        fail(f"{label} debe ser un objeto JSON")
    return value


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def manager_for_entry(entry: Mapping[str, Any], alias: str) -> str:
    docker_host = entry.get("dockerHost", "local")
    if docker_host == "local":
        return "server"
    if docker_host == "kratos":
        return "kratos"
    fail(f"{alias}.dockerHost no pertenece a los dos managers admitidos: {docker_host!r}")


@dataclasses.dataclass(frozen=True)
class Fleet:
    raw: bytes
    aliases: dict[str, dict[str, Any]]
    retired: frozenset[str]
    placements: dict[str, str]

    @classmethod
    def load(cls, raw: bytes) -> "Fleet":
        document = duplicate_safe_json(raw, "container-aliases.json")
        if document.get("schemaVersion") != 2:
            fail("container-aliases.json no usa schemaVersion 2")
        aliases = document.get("aliases")
        historical = document.get("historicalAliases")
        if not isinstance(aliases, dict) or not aliases:
            fail("container-aliases.json no declara aliases")
        if not isinstance(historical, dict):
            fail("container-aliases.json no declara historicalAliases")
        parsed: dict[str, dict[str, Any]] = {}
        placements: dict[str, str] = {}
        for alias, value in sorted(aliases.items()):
            if not isinstance(alias, str) or NAME_RE.fullmatch(alias) is None:
                fail(f"alias activo invalido: {alias!r}")
            if not isinstance(value, dict):
                fail(f"mapping de {alias} no es un objeto")
            for field in ("container", "systemdUser", "user", "home", "harness"):
                if not isinstance(value.get(field), str) or not value[field]:
                    fail(f"mapping de {alias} no contiene {field}")
            parsed[alias] = dict(value)
            placements[alias] = manager_for_entry(value, alias)
        retired = frozenset(historical)
        overlap = set(parsed) & retired
        if overlap:
            fail(f"aliases activos e historicos se solapan: {sorted(overlap)}")
        if not RETIRED_REQUIRED_DISABLED.issubset(retired):
            fail("el catalogo perdio aliases historicos que deben seguir retirados")
        for alias, value in historical.items():
            if not isinstance(value, dict) or value.get("expectedEnabled") is not False:
                fail(f"alias historico {alias} no permanece explicitamente deshabilitado")
        if set(placements.values()) != set(MANAGERS):
            fail("el catalogo no cubre exactamente los managers server y kratos")
        return cls(raw=raw, aliases=parsed, retired=retired, placements=placements)

    def entry_digest(self, alias: str) -> str:
        return sha256(canonical_json(self.aliases[alias]))


@dataclasses.dataclass(frozen=True)
class ReleaseBundle:
    release_sha: str
    mapping_sha: str
    files: dict[str, bytes]
    digests: dict[str, str]
    manifest: bytes

    @classmethod
    def from_ops_root(cls, ops_root: pathlib.Path) -> "ReleaseBundle":
        files: dict[str, bytes] = {}
        for relative in RELEASE_FILES:
            source = ops_root / relative
            try:
                info = source.lstat()
            except FileNotFoundError:
                fail(f"falta un input del release PTY: {relative}")
            if not stat.S_ISREG(info.st_mode) or source.is_symlink():
                fail(f"input del release PTY no es regular: {relative}")
            files[relative] = source.read_bytes()
        Fleet.load(files["container-aliases.json"])
        digests = {path: sha256(body) for path, body in sorted(files.items())}
        release_sha = sha256(canonical_json({"schemaVersion": SCHEMA_VERSION, "files": digests}))
        manifest_value = {
            "schemaVersion": SCHEMA_VERSION,
            "releaseSha": release_sha,
            "mappingSha256": digests["container-aliases.json"],
            "files": digests,
        }
        return cls(
            release_sha=release_sha,
            mapping_sha=digests["container-aliases.json"],
            files=files,
            digests=digests,
            manifest=canonical_json(manifest_value),
        )

    def request_value(self) -> dict[str, Any]:
        return {
            "releaseSha": self.release_sha,
            "manifest": base64.b64encode(self.manifest).decode("ascii"),
            "files": {
                path: base64.b64encode(body).decode("ascii")
                for path, body in sorted(self.files.items())
            },
        }


def decode_release_request(request: Mapping[str, Any]) -> ReleaseBundle:
    release_sha = request.get("releaseSha")
    encoded_manifest = request.get("manifest")
    encoded_files = request.get("files")
    if not isinstance(release_sha, str) or SHA_RE.fullmatch(release_sha) is None:
        fail("releaseSha es invalido")
    if not isinstance(encoded_manifest, str) or not isinstance(encoded_files, dict):
        fail("payload del release es incompleto")
    if set(encoded_files) != set(RELEASE_FILES):
        fail("payload del release no contiene el conjunto exacto de ficheros")
    try:
        manifest = base64.b64decode(encoded_manifest, validate=True)
        files = {
            path: base64.b64decode(body, validate=True)
            for path, body in encoded_files.items()
            if isinstance(path, str) and isinstance(body, str)
        }
    except (ValueError, TypeError) as error:
        fail(f"payload del release no usa base64 valido: {error}")
    if set(files) != set(RELEASE_FILES):
        fail("payload del release contiene nombres o cuerpos invalidos")
    document = duplicate_safe_json(manifest, "manifest del release")
    digests = {path: sha256(body) for path, body in sorted(files.items())}
    computed = sha256(canonical_json({"schemaVersion": SCHEMA_VERSION, "files": digests}))
    expected = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseSha": computed,
        "mappingSha256": digests["container-aliases.json"],
        "files": digests,
    }
    if document != expected or computed != release_sha:
        fail("payload del release no coincide con su digest inmutable")
    Fleet.load(files["container-aliases.json"])
    return ReleaseBundle(
        release_sha=computed,
        mapping_sha=digests["container-aliases.json"],
        files=files,
        digests=digests,
        manifest=manifest,
    )


@dataclasses.dataclass(frozen=True)
class UnitPresence:
    enabled: bool = False
    active: bool = False
    selector: bool = False

    @property
    def present(self) -> bool:
        return self.enabled or self.active or self.selector


@dataclasses.dataclass
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class Runner:
    def run(self, argv: Sequence[str], *, env: Mapping[str, str] | None = None) -> CommandResult:
        process = subprocess.run(
            list(argv),
            env=None if env is None else dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=45,
            check=False,
        )
        return CommandResult(process.returncode, process.stdout, process.stderr)


def require_ok(result: CommandResult, label: str) -> str:
    if result.returncode != 0:
        # Los subprocesos validados no imprimen cuerpos de config. Aun asi, el controlador no
        # reenvia stdout/stderr: una herramienta externa no puede convertirlos en exfiltracion.
        fail(f"{label} fallo con codigo {result.returncode}")
    return result.stdout


def safe_directory(path: pathlib.Path, *, create: bool = False) -> None:
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
        fail(f"directorio operacional inseguro: {path}")
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        fail(f"directorio operacional con owner o modo inseguro: {path}")


def safe_regular(path: pathlib.Path, label: str) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        fail(f"{label} no es un fichero regular")
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        fail(f"{label} tiene owner o modo inseguro")
    return info


def fsync_directory(path: pathlib.Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: pathlib.Path, body: bytes, mode: int = 0o600) -> None:
    safe_directory(path.parent, create=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = pathlib.Path(temporary)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        fsync_directory(path.parent)
    except BaseException:
        if temp_path.exists():
            quarantine = path.parent / f"failed-{path.name}-{uuid.uuid4().hex}"
            os.replace(temp_path, quarantine)
            fsync_directory(path.parent)
        raise


class ManagerWorker:
    def __init__(
        self,
        manager: str,
        *,
        home: pathlib.Path | None = None,
        runner: Runner | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if manager not in MANAGERS:
            fail(f"manager invalido: {manager}")
        if os.geteuid() == 0:
            fail("el rollout PTY debe correr como el usuario systemd de la flota, nunca root")
        self.manager = manager
        self.home = pathlib.Path.home() if home is None else home
        self.runner = Runner() if runner is None else runner
        self.sleep = sleep
        self.release_root = self.home / ".local/share/cauce-v3/pty-releases"
        self.state_root = self.home / ".local/state/cauce-v3/pty-rollout"
        self.unit_root = self.home / ".config/systemd/user"
        self.lock_root = self.state_root / "locks"

    def release_path(self, release_sha: str) -> pathlib.Path:
        if SHA_RE.fullmatch(release_sha) is None:
            fail("release SHA invalido")
        return self.release_root / release_sha

    def validate_release(self, release_sha: str) -> tuple[pathlib.Path, Fleet]:
        root = self.release_path(release_sha)
        safe_directory(root)
        manifest_path = root / "manifest.json"
        safe_regular(manifest_path, "manifest del release")
        document = duplicate_safe_json(manifest_path.read_bytes(), "manifest del release")
        files = document.get("files")
        if (
            document.get("schemaVersion") != SCHEMA_VERSION
            or document.get("releaseSha") != release_sha
            or not isinstance(files, dict)
            or set(files) != set(RELEASE_FILES)
        ):
            fail("manifest del release publicado es invalido")
        calculated: dict[str, str] = {}
        for relative in RELEASE_FILES:
            path = root / relative
            safe_regular(path, f"input publicado {relative}")
            calculated[relative] = sha256(path.read_bytes())
        if files != calculated:
            fail("un release publicado cambio de contenido")
        computed = sha256(canonical_json({"schemaVersion": SCHEMA_VERSION, "files": calculated}))
        if computed != release_sha or document.get("mappingSha256") != calculated["container-aliases.json"]:
            fail("digest del release publicado no cierra")
        return root, Fleet.load((root / "container-aliases.json").read_bytes())

    def publish(self, bundle: ReleaseBundle) -> dict[str, Any]:
        safe_directory(self.release_root, create=True)
        target = self.release_path(bundle.release_sha)
        if target.exists():
            self.validate_release(bundle.release_sha)
            return {"status": "already-published", "releaseSha": bundle.release_sha}
        staging = self.release_root / f".staging-{bundle.release_sha}-{uuid.uuid4().hex}"
        staging.mkdir(mode=0o700)
        try:
            for relative, body in bundle.files.items():
                destination = staging / relative
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                atomic_write(destination, body, 0o500 if relative in EXECUTABLE_FILES else 0o400)
            atomic_write(staging / "manifest.json", bundle.manifest, 0o400)
            for directory in sorted(
                (path for path in staging.rglob("*") if path.is_dir()),
                key=lambda path: len(path.parts),
                reverse=True,
            ):
                os.chmod(directory, 0o500)
            os.chmod(staging, 0o500)
            try:
                os.rename(staging, target)
            except FileExistsError:
                quarantine = self.release_root / f"concurrent-{bundle.release_sha}-{uuid.uuid4().hex}"
                os.rename(staging, quarantine)
            fsync_directory(self.release_root)
            self.validate_release(bundle.release_sha)
            return {"status": "published", "releaseSha": bundle.release_sha}
        except BaseException:
            if staging.exists():
                quarantine = self.release_root / f"failed-{bundle.release_sha}-{uuid.uuid4().hex}"
                os.rename(staging, quarantine)
                fsync_directory(self.release_root)
            raise

    def inventory(self) -> dict[str, UnitPresence]:
        unit_files = self.runner.run(
            ["systemctl", "--user", "list-unit-files", "--no-legend", "--no-pager", "cauce-v3-pty@*.service"]
        )
        units = self.runner.run(
            ["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "--no-pager", "cauce-v3-pty@*.service"]
        )
        require_ok(unit_files, "inventario de unit files")
        require_ok(units, "inventario de units")
        enabled: set[str] = set()
        active: set[str] = set()
        selectors: set[str] = set()
        for line in unit_files.stdout.splitlines():
            fields = line.split()
            match = UNIT_RE.fullmatch(fields[0]) if fields else None
            if match is not None and len(fields) >= 2 and fields[1] not in {"disabled", "masked"}:
                enabled.add(match.group(1))
        for line in units.stdout.splitlines():
            fields = line.lstrip("● ").split()
            match = UNIT_RE.fullmatch(fields[0]) if fields else None
            if match is not None and len(fields) >= 3 and fields[2] in {"active", "activating", "reloading"}:
                active.add(match.group(1))
        if self.unit_root.exists():
            safe_directory(self.unit_root)
            for directory in self.unit_root.glob("cauce-v3-pty@*.service.d"):
                match = re.fullmatch(r"cauce-v3-pty@([a-z][a-z0-9.-]*)\.service\.d", directory.name)
                if match is None:
                    continue
                selector = directory / "20-cauce-release.conf"
                if selector.exists():
                    safe_regular(selector, "selector PTY")
                    selectors.add(match.group(1))
        return {
            alias: UnitPresence(alias in enabled, alias in active, alias in selectors)
            for alias in sorted(enabled | active | selectors)
        }

    def _selector_path(self, alias: str) -> pathlib.Path:
        return self.unit_root / f"cauce-v3-pty@{alias}.service.d/20-cauce-release.conf"

    def _unit(self, alias: str) -> str:
        if NAME_RE.fullmatch(alias) is None:
            fail("alias invalido")
        return f"cauce-v3-pty@{alias}.service"

    def _selector(self, alias: str, release_sha: str, release: pathlib.Path) -> bytes:
        # systemd no interpola variables de Environment en ExecStart. El selector contiene el path
        # inmutable completo; os.replace hace que los lectores vean la version anterior o la nueva.
        return (
            "# Gestionado por rollout-pty.py; no contiene credenciales.\n"
            "[Service]\n"
            f"Environment=CAUCE_PTY_OPS_ROOT={release}\n"
            f"Environment=CAUCE_PTY_AGENT_VERSION={release_sha}\n"
            "ExecStart=\n"
            f"ExecStart={release}/pty-agent/cauce-pty-launcher.sh {alias}\n"
        ).encode()

    def _state(self, unit: str) -> tuple[bool, bool]:
        enabled = self.runner.run(["systemctl", "--user", "is-enabled", "--quiet", unit]).returncode == 0
        active = self.runner.run(["systemctl", "--user", "is-active", "--quiet", unit]).returncode == 0
        return enabled, active

    def preflight_alias(self, bundle: ReleaseBundle, alias: str, expected_manager: str) -> dict[str, Any]:
        fleet = Fleet.load(bundle.files["container-aliases.json"])
        if alias not in fleet.aliases or fleet.placements[alias] != expected_manager or expected_manager != self.manager:
            fail(f"placement de {alias} no coincide con {self.manager}")
        with tempfile.TemporaryDirectory(prefix="cauce-pty-preflight-") as directory:
            root = pathlib.Path(directory)
            for relative, body in bundle.files.items():
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(body)
                if relative in EXECUTABLE_FILES:
                    destination.chmod(0o500)
            env = dict(os.environ)
            env["CAUCE_PTY_OPS_ROOT"] = str(root)
            result = self.runner.run(
                [str(root / "pty-agent/install-pty-agent.sh"), "--preflight-only", alias], env=env
            )
            require_ok(result, f"preflight PTY de {alias}")
        return {"status": "ready", "alias": alias, "manager": self.manager}

    def _preflight_published(self, release: pathlib.Path, alias: str) -> None:
        env = dict(os.environ)
        env["CAUCE_PTY_OPS_ROOT"] = str(release)
        result = self.runner.run(
            [str(release / "pty-agent/install-pty-agent.sh"), "--preflight-only", alias], env=env
        )
        require_ok(result, f"preflight PTY publicado de {alias}")

    def _process_has_release(self, unit: str, release_sha: str) -> bool:
        result = self.runner.run(["systemctl", "--user", "show", "--property=MainPID", "--value", unit])
        if result.returncode != 0 or re.fullmatch(r"[1-9][0-9]*\n?", result.stdout) is None:
            return False
        pid = int(result.stdout.strip())
        try:
            environ = pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
            return False
        expected = f"CAUCE_PTY_AGENT_VERSION={release_sha}".encode()
        return expected in environ

    def _health(
        self,
        alias: str,
        release_sha: str,
        required_modes: frozenset[str],
        *,
        attempts: int,
        delay: float,
        since: int | None,
    ) -> bool:
        unit = self._unit(alias)
        for attempt in range(attempts):
            active = self.runner.run(["systemctl", "--user", "is-active", "--quiet", unit]).returncode == 0
            if active and self._process_has_release(unit, release_sha):
                argv = ["journalctl", "--user", "-u", unit, "--no-pager", "-o", "cat", "-n", "200"]
                if since is not None:
                    argv.extend(["--since", f"@{since}"])
                journal = self.runner.run(argv)
                if journal.returncode == 0:
                    version_ok = re.search(
                        rf"starting alias={re.escape(alias)}\b[^\n]*\bversion={release_sha}(?:\s|$)",
                        journal.stdout,
                    ) is not None
                    accepted = re.findall(
                        rf"relay accepted alias={re.escape(alias)} modes=([a-z0-9_,-]+)",
                        journal.stdout,
                    )
                    modes = frozenset(accepted[-1].split(",")) if accepted else frozenset()
                    if version_ok and required_modes.issubset(modes):
                        return True
            if attempt + 1 < attempts:
                self.sleep(delay)
        return False

    def _transaction(self, alias: str, release_sha: str) -> pathlib.Path:
        safe_directory(self.state_root, create=True)
        alias_root = self.state_root / "transactions" / alias
        safe_directory(alias_root, create=True)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        transaction = alias_root / f"{stamp}-{release_sha[:12]}-{uuid.uuid4().hex[:8]}"
        transaction.mkdir(mode=0o700)
        fsync_directory(alias_root)
        return transaction

    def _snapshot(self, alias: str, release_sha: str) -> tuple[pathlib.Path, dict[str, Any]]:
        unit = self._unit(alias)
        selector = self._selector_path(alias)
        enabled, active = self._state(unit)
        transaction = self._transaction(alias, release_sha)
        selector_body: bytes | None = None
        if selector.exists():
            safe_regular(selector, "selector PTY anterior")
            selector_body = selector.read_bytes()
            atomic_write(transaction / "selector.before", selector_body, 0o600)
        state = {
            "schemaVersion": SCHEMA_VERSION,
            "alias": alias,
            "manager": self.manager,
            "targetReleaseSha": release_sha,
            "selectorExisted": selector_body is not None,
            "selectorBeforeSha256": None if selector_body is None else sha256(selector_body),
            "enabledBefore": enabled,
            "activeBefore": active,
            "consumed": False,
        }
        atomic_write(transaction / "state.json", canonical_json(state), 0o600)
        return transaction, state

    def _write_state(self, transaction: pathlib.Path, state: Mapping[str, Any]) -> None:
        atomic_write(transaction / "state.json", canonical_json(dict(state)), 0o600)

    def _rollback_snapshot(self, transaction: pathlib.Path, state: dict[str, Any]) -> None:
        alias = str(state["alias"])
        unit = self._unit(alias)
        selector = self._selector_path(alias)
        self.runner.run(["systemctl", "--user", "stop", unit])
        if state["selectorExisted"]:
            previous = transaction / "selector.before"
            safe_regular(previous, "backup del selector PTY")
            if sha256(previous.read_bytes()) != state["selectorBeforeSha256"]:
                fail("backup del selector PTY cambio de contenido")
            atomic_write(selector, previous.read_bytes(), 0o600)
        elif selector.exists():
            safe_regular(selector, "selector PTY a retirar")
            recovered = transaction / "selector.rolled-back"
            os.replace(selector, recovered)
            fsync_directory(selector.parent)
        require_ok(self.runner.run(["systemctl", "--user", "daemon-reload"]), "daemon-reload de rollback")
        if state["enabledBefore"]:
            require_ok(self.runner.run(["systemctl", "--user", "enable", unit]), "restaurar enable PTY")
        else:
            self.runner.run(["systemctl", "--user", "disable", unit])
        if state["activeBefore"]:
            require_ok(self.runner.run(["systemctl", "--user", "start", unit]), "restaurar PTY activo")
        else:
            self.runner.run(["systemctl", "--user", "stop", unit])
        state["consumed"] = True
        state["rollbackAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        self._write_state(transaction, state)

    def apply(
        self,
        release_sha: str,
        alias: str,
        expected_manager: str,
        expected_entry_digest: str,
        required_modes: frozenset[str],
        *,
        attempts: int = 20,
        delay: float = 1.0,
        enable: bool = True,
    ) -> dict[str, Any]:
        if alias == "zeus" and enable:
            # Zeus PTY se admite solo porque el controlador lo manda en la ultima operacion y con
            # --include-zeus. Este worker nunca conoce ni invoca la unit del adapter automatico.
            pass
        if attempts < 1 or delay < 0:
            fail("parametros de health invalidos")
        release, fleet = self.validate_release(release_sha)
        if (
            alias not in fleet.aliases
            or fleet.placements[alias] != self.manager
            or expected_manager != self.manager
            or fleet.entry_digest(alias) != expected_entry_digest
        ):
            fail(f"placement o mapping de {alias} cambio entre controlador y manager")
        self._preflight_published(release, alias)
        base_unit = self.unit_root / "cauce-v3-pty@.service"
        safe_regular(base_unit, "template systemd PTY")
        safe_directory(self.lock_root, create=True)
        lock_path = self.lock_root / f"{alias}.lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail(f"otro rollout PTY opera sobre {alias}")
            selector = self._selector_path(alias)
            expected_selector = self._selector(alias, release_sha, release)
            enabled, active = self._state(self._unit(alias))
            if (
                selector.exists()
                and safe_regular(selector, "selector PTY")
                and selector.read_bytes() == expected_selector
                and (enabled or not enable)
                and active
                and self._health(alias, release_sha, required_modes, attempts=1, delay=0, since=None)
            ):
                return {"status": "unchanged", "alias": alias, "releaseSha": release_sha}
            transaction, state = self._snapshot(alias, release_sha)
            try:
                atomic_write(selector, expected_selector, 0o600)
                require_ok(self.runner.run(["systemctl", "--user", "daemon-reload"]), "daemon-reload PTY")
                unit = self._unit(alias)
                if enable:
                    require_ok(self.runner.run(["systemctl", "--user", "enable", unit]), f"enable PTY de {alias}")
                started = int(time.time()) - 1
                require_ok(self.runner.run(["systemctl", "--user", "restart", unit]), f"restart PTY de {alias}")
                if not self._health(
                    alias,
                    release_sha,
                    required_modes,
                    attempts=attempts,
                    delay=delay,
                    since=started,
                ):
                    fail(f"health/capability del PTY de {alias} no acredito release y modos")
                state["committed"] = True
                state["committedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
                self._write_state(transaction, state)
                return {
                    "status": "updated",
                    "alias": alias,
                    "releaseSha": release_sha,
                    "transaction": transaction.name,
                    "modes": sorted(required_modes),
                }
            except BaseException:
                self._rollback_snapshot(transaction, state)
                raise
        finally:
            os.close(descriptor)

    def _latest_transaction(self, alias: str) -> pathlib.Path:
        root = self.state_root / "transactions" / alias
        safe_directory(root)
        candidates = sorted(path for path in root.iterdir() if path.is_dir())
        if not candidates:
            fail(f"no hay backup de rollout para {alias}")
        return candidates[-1]

    def rollback(self, alias: str, transaction_name: str | None = None) -> dict[str, Any]:
        root = self.state_root / "transactions" / alias
        transaction = self._latest_transaction(alias) if transaction_name is None else root / transaction_name
        safe_directory(transaction)
        state_path = transaction / "state.json"
        safe_regular(state_path, "estado del rollback PTY")
        state = duplicate_safe_json(state_path.read_bytes(), "estado del rollback PTY")
        if state.get("alias") != alias or state.get("manager") != self.manager:
            fail("backup PTY no pertenece al alias y manager solicitados")
        if state.get("consumed") is True:
            return {"status": "already-rolled-back", "alias": alias, "transaction": transaction.name}
        self._rollback_snapshot(transaction, state)
        return {"status": "rolled-back", "alias": alias, "transaction": transaction.name}

    def _deactivate_assignment(self, alias: str, reason: str) -> dict[str, Any]:
        transaction, state = self._snapshot(alias, "0" * 64)
        unit = self._unit(alias)
        try:
            require_ok(self.runner.run(["systemctl", "--user", "stop", unit]), f"stop PTY de {alias}")
            # `disable` es idempotente: una instance sólo activa ya estaba acreditada por el
            # inventario y debe quedar también sin selector de arranque.
            self.runner.run(["systemctl", "--user", "disable", unit])
            selector = self._selector_path(alias)
            if selector.exists():
                safe_regular(selector, f"selector PTY de {alias}")
                os.replace(selector, transaction / "selector.retired")
                fsync_directory(selector.parent)
            require_ok(
                self.runner.run(["systemctl", "--user", "daemon-reload"]),
                f"daemon-reload al retirar {alias}",
            )
            current = self.inventory().get(alias, UnitPresence())
            if current.present:
                fail(f"{alias} sigue presente despues de retirarlo")
        except BaseException:
            self._rollback_snapshot(transaction, state)
            raise
        state["assignmentDeactivated"] = True
        state["deactivationReason"] = reason
        self._write_state(transaction, state)
        return {"status": "deactivated", "alias": alias, "transaction": transaction.name}

    def deactivate_for_migration(self, alias: str) -> dict[str, Any]:
        if alias != "kant" or self.manager != "kratos":
            fail("solo la migracion explicita de kant puede retirar un placement")
        return self._deactivate_assignment(alias, "kant-placement-migration")

    def deactivate_retired(self, alias: str, bundle: ReleaseBundle) -> dict[str, Any]:
        fleet = Fleet.load(bundle.files["container-aliases.json"])
        if alias not in fleet.retired:
            fail(f"{alias} no es un alias historico declarado")
        return self._deactivate_assignment(alias, "historical-alias-retirement")


def inventory_value(inventory: Mapping[str, UnitPresence]) -> dict[str, Any]:
    return {
        alias: dataclasses.asdict(presence)
        for alias, presence in sorted(inventory.items())
    }


def parse_inventory(value: Mapping[str, Any]) -> dict[str, UnitPresence]:
    parsed: dict[str, UnitPresence] = {}
    for alias, raw in value.items():
        if NAME_RE.fullmatch(alias) is None or not isinstance(raw, dict):
            fail("inventario remoto contiene un alias invalido")
        if set(raw) != {"enabled", "active", "selector"} or not all(isinstance(item, bool) for item in raw.values()):
            fail(f"inventario remoto de {alias} es invalido")
        parsed[alias] = UnitPresence(**raw)
    return parsed


def validate_inventories(fleet: Fleet, inventories: Mapping[str, Mapping[str, UnitPresence]], *, migrate_kant: bool) -> None:
    if set(inventories) != set(MANAGERS):
        fail("faltan inventarios de los dos managers")
    observed: dict[str, list[str]] = {}
    for manager, inventory in inventories.items():
        for alias, presence in inventory.items():
            if not presence.present:
                continue
            if alias in fleet.retired:
                fail(f"alias retirado {alias} sigue presente en {manager}")
            if alias not in fleet.aliases:
                fail(f"alias desconocido {alias} sigue presente en {manager}")
            observed.setdefault(alias, []).append(manager)
    duplicates = {alias: managers for alias, managers in observed.items() if len(managers) > 1}
    if duplicates:
        fail(f"aliases PTY duplicados entre managers: {duplicates}")
    for alias, managers in observed.items():
        actual = managers[0]
        desired = fleet.placements[alias]
        if actual == desired:
            continue
        if alias == "kant" and actual == "kratos" and desired == "server" and migrate_kant:
            continue
        if alias == "kant" and actual == "kratos" and desired == "server":
            fail("kant requiere --migrate-kant para retirar kratos antes de activar server")
        fail(f"placement drift de {alias}: observado={actual} esperado={desired}")


class Transport:
    def call(self, operation: str, request: Mapping[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class ProcessTransport(Transport):
    def __init__(self, manager: str, target: str, script: pathlib.Path) -> None:
        self.manager = manager
        self.target = target
        self.script = script

    def call(self, operation: str, request: Mapping[str, Any]) -> dict[str, Any]:
        payload = canonical_json(dict(request))
        if self.target == "local":
            argv = [sys.executable, str(self.script), "--worker", operation, "--manager", self.manager]
        elif self.target.startswith(("ssh:", "sudo-ssh:")):
            sudo_user: str | None = None
            if self.target.startswith("sudo-ssh:"):
                parts = self.target.split(":")
                if len(parts) != 3:
                    fail(f"target sudo-ssh invalido para {self.manager}")
                _, host, sudo_user = parts
                if NAME_RE.fullmatch(sudo_user) is None:
                    fail(f"usuario sudo-ssh invalido para {self.manager}")
            else:
                host = self.target.removeprefix("ssh:")
            if NAME_RE.fullmatch(host) is None:
                fail(f"target SSH invalido para {self.manager}")
            source = base64.b64encode(self.script.read_bytes()).decode("ascii")
            bootstrap = (
                "import base64,sys;"
                "code=base64.b64decode(sys.argv[1],validate=True);"
                "sys.argv=sys.argv[2:];"
                "exec(compile(code,'rollout-pty.py','exec'),{'__name__':'__main__'})"
            )
            worker = " ".join(
                shlex.quote(item)
                for item in (
                    "python3", "-c", bootstrap, source,
                    "rollout-pty.py", "--worker", operation, "--manager", self.manager,
                )
            )
            if sudo_user is None:
                remote = worker
            else:
                # El SSH administrativo puede entrar como root, pero el worker debe correr como
                # el dueño del systemd --user. Se deriva su UID en el host remoto y se conecta a
                # SU bus; no se hereda HOME ni el bus de root y no se transporta ningún secreto.
                quoted_user = shlex.quote(sudo_user)
                remote = (
                    f"set -eu; uid=$(id -u -- {quoted_user}); "
                    f"exec sudo -Hu {quoted_user} env "
                    'XDG_RUNTIME_DIR="/run/user/$uid" '
                    'DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" '
                    f"{worker}"
                )
            argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remote]
        else:
            fail(f"target de manager invalido: {self.target}")
        process = subprocess.run(
            argv,
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=False,
        )
        if process.returncode != 0:
            # stderr remoto puede venir de ssh o de una herramienta local. No se replica porque el
            # contrato de esta capa es no convertir fallos externos en un canal de secretos.
            fail(f"operacion {operation} fallo en manager {self.manager} con codigo {process.returncode}")
        response = duplicate_safe_json(process.stdout, f"respuesta de {self.manager}/{operation}")
        if response.get("ok") is not True or not isinstance(response.get("result"), dict):
            fail(f"respuesta de {self.manager}/{operation} no acredita exito")
        return response["result"]


def parse_targets(values: Sequence[str]) -> dict[str, str]:
    targets: dict[str, str] = {}
    for value in values:
        manager, separator, target = value.partition("=")
        if not separator or manager not in MANAGERS or not target or manager in targets:
            fail(f"--manager invalido: {value}")
        targets[manager] = target
    if set(targets) != set(MANAGERS):
        fail("hay que declarar exactamente los managers server y kratos")
    return targets


def parse_modes(values: Sequence[str], fleet: Fleet) -> dict[str, frozenset[str]]:
    result = {
        alias: frozenset(("shell", "harness"))
        if entry.get("harness") in {"claude", "codex", "openclaw", "hermes"}
        else frozenset(("shell",))
        for alias, entry in fleet.aliases.items()
    }
    for value in values:
        alias, separator, modes_text = value.partition("=")
        modes = modes_text.split(",") if separator else []
        if alias not in fleet.aliases or not modes or any(MODE_RE.fullmatch(mode) is None for mode in modes):
            fail(f"--require-mode invalido: {value}")
        result[alias] = frozenset(modes)
    return result


def selected_aliases(value: str | None, fleet: Fleet, include_zeus: bool) -> list[str]:
    if value is None:
        aliases = sorted(fleet.aliases)
    else:
        aliases = value.split(",")
        if len(aliases) != len(set(aliases)) or any(alias not in fleet.aliases for alias in aliases):
            fail("--aliases contiene duplicados o aliases desconocidos")
    if "zeus" in aliases and not include_zeus:
        aliases.remove("zeus")
    # Zeus PTY siempre es la ultima unit. Este orden no toca ni activa cauce-v3-container-zeus.
    return [alias for alias in aliases if alias != "zeus"] + (["zeus"] if "zeus" in aliases else [])


def rollback_applied_results(
    transports: Mapping[str, Transport],
    fleet: Fleet,
    results: Sequence[Mapping[str, Any]],
) -> list[str]:
    """Compensa en orden inverso sólo las mutaciones de esta invocación.

    Un resultado `unchanged` no pertenece a la transacción actual y nunca se toca. Usar el nombre
    exacto del backup evita que un fallo temprano termine consumiendo una transacción histórica.
    """
    failures: list[str] = []
    for result in reversed(results):
        alias = result.get("alias")
        transaction = result.get("transaction")
        if not isinstance(alias, str) or not isinstance(transaction, str):
            continue
        manager = fleet.placements.get(alias)
        if manager is None:
            failures.append(alias)
            continue
        try:
            transports[manager].call(
                "rollback", {"alias": alias, "transaction": transaction}
            )
        except RolloutError:
            failures.append(alias)
    return failures


def controller(args: argparse.Namespace) -> dict[str, Any]:
    script = pathlib.Path(__file__).resolve()
    ops_root = script.parents[1]
    bundle = ReleaseBundle.from_ops_root(ops_root)
    fleet = Fleet.load(bundle.files["container-aliases.json"])
    targets = parse_targets(args.manager)
    transports = {
        manager: ProcessTransport(manager, targets[manager], script)
        for manager in MANAGERS
    }
    inventories = {
        manager: parse_inventory(transports[manager].call("inventory", {}).get("inventory", {}))
        for manager in MANAGERS
    }
    retirement_results: list[dict[str, Any]] = []
    if getattr(args, "preflight_only", False) and getattr(args, "retire_historical", False):
        fail("--preflight-only no puede combinarse con --retire-historical")
    if args.command == "retire-historical" or getattr(args, "retire_historical", False):
        for manager in MANAGERS:
            for alias, presence in sorted(inventories[manager].items()):
                if alias not in fleet.retired or not presence.present:
                    continue
                retirement_results.append(
                    transports[manager].call(
                        "deactivate-retired",
                        {"alias": alias, "bundle": bundle.request_value()},
                    )
                )
        inventories = {
            manager: parse_inventory(transports[manager].call("inventory", {}).get("inventory", {}))
            for manager in MANAGERS
        }
    validate_inventories(
        fleet,
        inventories,
        # El comando acotado sólo retira históricos. Puede coexistir con el placement legacy de
        # kant para que el siguiente paso lo migre explícitamente; cualquier otro drift falla.
        migrate_kant=args.migrate_kant or args.command == "retire-historical",
    )
    if args.command == "retire-historical":
        return {
            "status": "ok",
            "retired": retirement_results,
            "inventory": {manager: inventory_value(value) for manager, value in inventories.items()},
        }
    if args.command == "status":
        return {
            "status": "ok",
            "releaseSha": bundle.release_sha,
            "mappingSha256": bundle.mapping_sha,
            "inventory": {manager: inventory_value(value) for manager, value in inventories.items()},
        }
    if args.command == "rollback":
        alias = args.alias
        manager = fleet.placements.get(alias)
        if manager is None:
            fail("rollback solicitado para alias desconocido")
        result = transports[manager].call(
            "rollback", {"alias": alias, "transaction": args.transaction}
        )
        return {"status": "ok", "result": result}

    aliases = selected_aliases(args.aliases, fleet, args.include_zeus)
    modes = parse_modes(args.require_mode, fleet)
    preflight_results = []
    for alias in aliases:
        manager = fleet.placements[alias]
        preflight_results.append(
            transports[manager].call(
                "preflight",
                {
                    "bundle": bundle.request_value(),
                    "alias": alias,
                    "expectedManager": manager,
                },
            )
        )
    if args.command == "preflight" or args.preflight_only:
        return {
            "status": "ready",
            "releaseSha": bundle.release_sha,
            "mappingSha256": bundle.mapping_sha,
            "aliases": aliases,
            "preflight": preflight_results,
        }

    for manager in MANAGERS:
        transports[manager].call("publish", {"bundle": bundle.request_value()})

    kant_migration: dict[str, Any] | None = None
    if args.migrate_kant and inventories["kratos"].get("kant", UnitPresence()).present:
        kant_migration = transports["kratos"].call("deactivate-kant", {})
        refreshed = {
            manager: parse_inventory(transports[manager].call("inventory", {}).get("inventory", {}))
            for manager in MANAGERS
        }
        validate_inventories(fleet, refreshed, migrate_kant=False)

    results: list[dict[str, Any]] = []
    try:
        for alias in aliases:
            manager = fleet.placements[alias]
            results.append(
                transports[manager].call(
                    "apply",
                    {
                        "releaseSha": bundle.release_sha,
                        "alias": alias,
                        "expectedManager": manager,
                        "entryDigest": fleet.entry_digest(alias),
                        "requiredModes": sorted(modes[alias]),
                        "healthAttempts": args.health_attempts,
                        "healthDelay": args.health_delay,
                        "allowZeus": args.include_zeus,
                    },
                )
            )
    except BaseException as original:
        rollback_failures = rollback_applied_results(transports, fleet, results)
        if kant_migration is not None:
            # La compensación inversa ya retiró el selector nuevo de kant. Sólo ahora se permite
            # revivir el PTY anterior; así jamás hay doble presencia entre managers.
            try:
                transports["kratos"].call(
                    "rollback", {"alias": "kant", "transaction": kant_migration["transaction"]}
                )
            except RolloutError:
                rollback_failures.append("kant@kratos")
        if rollback_failures:
            fail(
                "el rollout fallo y la compensacion no pudo restaurar: "
                + ",".join(rollback_failures)
            )
        raise original
    return {
        "status": "ok",
        "releaseSha": bundle.release_sha,
        "mappingSha256": bundle.mapping_sha,
        "aliases": aliases,
        "results": results,
        "kantMigration": kant_migration,
        "retired": retirement_results,
    }


def worker(args: argparse.Namespace) -> dict[str, Any]:
    request = duplicate_safe_json(sys.stdin.buffer.read(), "request del worker")
    implementation = ManagerWorker(args.manager)
    operation = args.worker
    if operation == "inventory":
        return {"inventory": inventory_value(implementation.inventory())}
    if operation == "publish":
        return implementation.publish(decode_release_request(request.get("bundle", {})))
    if operation == "preflight":
        bundle = decode_release_request(request.get("bundle", {}))
        return implementation.preflight_alias(
            bundle,
            str(request.get("alias", "")),
            str(request.get("expectedManager", "")),
        )
    if operation == "apply":
        required = request.get("requiredModes")
        if not isinstance(required, list) or not required or any(not isinstance(mode, str) or MODE_RE.fullmatch(mode) is None for mode in required):
            fail("requiredModes es invalido")
        alias = str(request.get("alias", ""))
        if alias == "zeus" and request.get("allowZeus") is not True:
            fail("Zeus PTY solo se admite con --include-zeus y siempre al final")
        return implementation.apply(
            str(request.get("releaseSha", "")),
            alias,
            str(request.get("expectedManager", "")),
            str(request.get("entryDigest", "")),
            frozenset(required),
            attempts=int(request.get("healthAttempts", 20)),
            delay=float(request.get("healthDelay", 1.0)),
        )
    if operation == "rollback":
        transaction = request.get("transaction")
        if transaction is not None and (not isinstance(transaction, str) or "/" in transaction or transaction in {".", ".."}):
            fail("transaction de rollback invalida")
        return implementation.rollback(str(request.get("alias", "")), transaction)
    if operation == "deactivate-kant":
        return implementation.deactivate_for_migration("kant")
    if operation == "deactivate-retired":
        bundle = decode_release_request(request.get("bundle", {}))
        return implementation.deactivate_retired(str(request.get("alias", "")), bundle)
    fail(f"operacion de worker invalida: {operation}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--worker",
        choices=(
            "inventory", "publish", "preflight", "apply", "rollback", "deactivate-kant",
            "deactivate-retired",
        ),
        help=argparse.SUPPRESS,
    )
    result.add_argument("--manager", action="append", default=[], metavar="MANAGER=TARGET")
    subparsers = result.add_subparsers(dest="command")
    for name in ("status", "preflight", "rollout"):
        command = subparsers.add_parser(name)
        command.add_argument("--manager", action="append", default=[])
        command.add_argument("--aliases")
        command.add_argument("--include-zeus", action="store_true")
        command.add_argument("--migrate-kant", action="store_true")
        command.add_argument("--require-mode", action="append", default=[])
        command.add_argument("--health-attempts", type=int, default=20)
        command.add_argument("--health-delay", type=float, default=1.0)
        if name == "rollout":
            command.add_argument("--preflight-only", action="store_true")
            command.add_argument("--retire-historical", action="store_true")
        else:
            command.set_defaults(preflight_only=False, retire_historical=False)
    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("alias")
    rollback.add_argument("--transaction")
    rollback.add_argument("--manager", action="append", default=[])
    rollback.set_defaults(
        aliases=None,
        include_zeus=False,
        migrate_kant=False,
        require_mode=[],
        health_attempts=20,
        health_delay=1.0,
        preflight_only=False,
    )
    retirement = subparsers.add_parser("retire-historical")
    retirement.add_argument("--manager", action="append", default=[])
    retirement.set_defaults(
        aliases=None,
        include_zeus=False,
        migrate_kant=False,
        require_mode=[],
        health_attempts=20,
        health_delay=1.0,
        preflight_only=False,
        retire_historical=True,
    )
    return result


def main() -> int:
    arguments = parser().parse_args()
    try:
        if arguments.worker is not None:
            if len(arguments.manager) != 1 or "=" in arguments.manager[0]:
                fail("worker requiere --manager server o --manager kratos")
            arguments.manager = arguments.manager[0]
            output = worker(arguments)
        else:
            if arguments.command is None:
                parser().error("falta un comando")
            output = controller(arguments)
        sys.stdout.buffer.write(canonical_json({"ok": True, "result": output}))
        return 0
    except RolloutError as error:
        print(f"rollout-pty: {error}", file=sys.stderr)
        return 78
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"rollout-pty: fallo operacional cerrado ({type(error).__name__})", file=sys.stderr)
        return 75


if __name__ == "__main__":
    raise SystemExit(main())
