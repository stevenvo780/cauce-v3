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
import importlib.util
import json
import os
import pathlib
import stat
import sys
from dataclasses import replace

_scripts_dir = str(pathlib.Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from update_alias_lib import (  # noqa: E402  (sys.path.insert deliberado arriba)
    ALIAS_RE,
    DIGEST_RE,
    KEY_RE,
    AliasPolicy,
    ConfigUpdateError,
    ConsumptionJournal,
    SafeArgumentParser,
    assert_secure_directory,
    content_digest,
    ensure_backups_directory,
    load_inventory,
    open_absolute_directory,
    open_regular_at,
    parse_sets,
    read_all,
    render_update,
    validate_absolute,
    validate_restore_policy,
    write_all,
)

_LIB_RUTA = pathlib.Path(__file__).resolve().parent / "update-alias-config-lib.py"
_LIB_SPEC = importlib.util.spec_from_file_location("update_alias_config_lib", _LIB_RUTA)
if _LIB_SPEC is None or _LIB_SPEC.loader is None:
    raise ImportError(f"no se pudo cargar la libreria hermana: {_LIB_RUTA}")
_LIB = importlib.util.module_from_spec(_LIB_SPEC)
_LIB_SPEC.loader.exec_module(_LIB)

load_backup_auth_key = _LIB.load_backup_auth_key
backup_receipt = _LIB.backup_receipt
create_backup = _LIB.create_backup
atomic_replace = _LIB.atomic_replace
read_current = _LIB.read_current
with_lock = _LIB.with_lock
parse_backup_receipt = _LIB.parse_backup_receipt
consumption_journal_body = _LIB.consumption_journal_body
parse_consumption_journal = _LIB.parse_consumption_journal
read_consumption_journal = _LIB.read_consumption_journal
write_consumption_journal = _LIB.write_consumption_journal
read_backup = _LIB.read_backup
validate_pending_consumption = _LIB.validate_pending_consumption


def require_enabled_fleet_alias(flota_json: pathlib.Path, alias: str) -> None:
    """Same allowlist provision-agent-identity.sh / issue-alias-token.py enforce: fleet[alias].enabled."""
    try:
        fd = os.open(flota_json, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise ConfigUpdateError("no se pudo leer el snapshot de flota (ops/flota.json)") from None
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o022:
            raise ConfigUpdateError(
                "el snapshot de flota debe ser regular y no escribible por grupo u otros"
            )
        body = read_all(fd, "snapshot de flota")
    finally:
        os.close(fd)
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ConfigUpdateError("el snapshot de flota no es JSON valido") from None
    fleet = document.get("fleet") if isinstance(document, dict) else None
    entry = fleet.get(alias) if isinstance(fleet, dict) else None
    if not isinstance(entry, dict) or entry.get("enabled") is not True:
        raise ConfigUpdateError("el alias no esta habilitado en el snapshot de flota (ops/flota.json)")


def read_source_file(root: pathlib.Path, name: str, missing_message: str) -> bytes:
    """Read a small non-secret source file (cert/example) with the same no-follow discipline
    as the rest of this tool, collapsing every way it can be absent into one clear message."""
    try:
        root_fd = open_absolute_directory(root, "raiz de origen")
    except OSError:
        raise ConfigUpdateError(missing_message) from None
    try:
        try:
            fd = open_regular_at(root_fd, name, os.O_RDONLY)
        except OSError:
            raise ConfigUpdateError(missing_message) from None
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ConfigUpdateError(missing_message)
            return read_all(fd, name)
        finally:
            os.close(fd)
    finally:
        os.close(root_fd)


def ensure_root_directory(path: pathlib.Path, label: str) -> None:
    validate_absolute(path, label)
    if path.is_symlink():
        raise ConfigUpdateError(f"{label} no puede ser un symlink")
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def publish_created_file(directory_fd: int, name: str, body: bytes, mode: int) -> None:
    """Create-only publish: never overwrites, rolls itself back on any failed write."""
    try:
        fd = open_regular_at(directory_fd, name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode=mode)
    except FileExistsError:
        raise ConfigUpdateError(f"{name} ya existe; nada fue sobrescrito") from None
    published = False
    try:
        os.fchmod(fd, mode)
        write_all(fd, body)
        os.fsync(fd)
        published = True
    finally:
        os.close(fd)
        if not published:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass


def init_alias(
    config_root: pathlib.Path,
    pki_root: pathlib.Path,
    agent_pki_root: pathlib.Path,
    flota_json: pathlib.Path,
    examples_root: pathlib.Path,
    alias: str,
    *,
    dry_run: bool,
) -> dict[str, object]:
    """Create a brand-new alias's container-pki/<alias>/{ca.crt,client.crt,client.key} and
    <alias>.env. Every file is create-only (never overwrites). The pki trio is all-or-nothing
    within itself (a failed file rolls back the whole trio), and so is the env file, but the two
    pieces are independent: a finished piece is never undone by the other piece failing, so a
    retry after a genuine mid-way fault only has to finish the piece that did not land."""
    require_enabled_fleet_alias(flota_json, alias)

    example_body = read_source_file(
        examples_root,
        f"{alias}.env.example",
        f"falta el ejemplo generado para {alias}; corre generate-container-units.py primero",
    )
    identity_missing = f"falta la identidad mTLS de {alias}: corre provision-agent-identity primero"
    ca_body = read_source_file(
        agent_pki_root, "ca.crt", "falta la CA de la flota; aprovisiona la CA antes de continuar",
    )
    leaf_cert_body = read_source_file(agent_pki_root, f"agent-{alias}.crt", identity_missing)
    leaf_key_body = read_source_file(agent_pki_root, f"agent-{alias}.key", identity_missing)

    pki_target = pki_root / alias
    env_target = config_root / f"{alias}.env"

    if dry_run:
        return {
            "status": "dry-run",
            "alias": alias,
            "pkiDir": str(pki_target),
            "configFile": str(env_target),
            "pkiDirConflict": pki_target.is_symlink() or pki_target.exists(),
            "configFileConflict": env_target.is_symlink() or env_target.exists(),
        }

    ensure_root_directory(pki_root, "raiz de container-pki")
    ensure_root_directory(config_root, "raiz de configuracion")

    pki_root_fd = open_absolute_directory(pki_root, "raiz de container-pki")
    created_pki_dir = False
    try:
        assert_secure_directory(pki_root_fd, "raiz de container-pki")
        try:
            os.mkdir(alias, 0o700, dir_fd=pki_root_fd)
        except FileExistsError:
            raise ConfigUpdateError(f"container-pki/{alias} ya existe; nada fue sobrescrito") from None
        created_pki_dir = True

        alias_pki_fd = os.open(
            alias, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=pki_root_fd,
        )
        try:
            assert_secure_directory(alias_pki_fd, f"container-pki/{alias}", 0o700)
            for name, body in (
                ("ca.crt", ca_body), ("client.crt", leaf_cert_body), ("client.key", leaf_key_body),
            ):
                publish_created_file(alias_pki_fd, name, body, 0o600)
            os.fsync(alias_pki_fd)
        finally:
            os.close(alias_pki_fd)
        os.fsync(pki_root_fd)
    except BaseException:
        if created_pki_dir:
            for name in ("ca.crt", "client.crt", "client.key"):
                try:
                    os.unlink(f"{alias}/{name}", dir_fd=pki_root_fd)
                except FileNotFoundError:
                    pass
            try:
                os.rmdir(alias, dir_fd=pki_root_fd)
            except OSError:
                pass
        os.close(pki_root_fd)
        raise
    os.close(pki_root_fd)

    config_root_fd = open_absolute_directory(config_root, "raiz de configuracion")
    try:
        assert_secure_directory(config_root_fd, "raiz de configuracion")
        publish_created_file(config_root_fd, f"{alias}.env", example_body, 0o600)
        os.fsync(config_root_fd)
    finally:
        os.close(config_root_fd)

    return {
        "status": "created",
        "alias": alias,
        "pkiDir": str(pki_target),
        "configFile": str(env_target),
    }


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


def defaults() -> tuple[
    pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path,
]:
    ops_root = pathlib.Path(__file__).resolve().parents[1]
    inventory = ops_root / "container-aliases.json"
    hermes_runtime = ops_root / "hermes-runtime.json"
    flota = ops_root / "flota.json"
    generated_root = ops_root / "generated" / "container-systemd"
    if os.geteuid() == 0:
        config_root = pathlib.Path("/etc/cauce-v3/container-aliases")
        pki_root = pathlib.Path("/etc/cauce-v3/container-pki")
        agent_pki_root = pathlib.Path("/etc/cauce-v3/pki")
        examples_root = generated_root / "configs"
    else:
        config_home = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config"))
        config_root = config_home / "cauce-v3/container-aliases"
        pki_root = config_home / "cauce-v3/container-pki"
        agent_pki_root = config_home / "cauce-v3/pki"
        examples_root = generated_root / "rootless" / "configs"
    return inventory, hermes_runtime, flota, config_root, pki_root, agent_pki_root, examples_root


def parser() -> SafeArgumentParser:
    inventory, hermes_runtime, flota, config_root, pki_root, agent_pki_root, examples_root = defaults()
    root = SafeArgumentParser(description="Actualizacion CAS de configs Cauce por alias")
    root.add_argument("--inventory", type=pathlib.Path, default=inventory)
    root.add_argument("--hermes-runtime", type=pathlib.Path, default=hermes_runtime)
    root.add_argument("--config-root", type=pathlib.Path, default=config_root)
    root.add_argument("--pki-root", type=pathlib.Path, default=pki_root)
    actions = root.add_subparsers(
        dest="action", required=True, parser_class=SafeArgumentParser
    )
    for action in ("inspect", "apply", "restore", "init"):
        command = actions.add_parser(action)
        command.add_argument("--alias", required=True)
        if action not in ("inspect", "init"):
            command.add_argument("--expected-old-digest", required=True)
        if action == "apply":
            command.add_argument("--set", action="append", default=[])
            command.add_argument("--unset", action="append", default=[])
        if action == "restore":
            command.add_argument("--backup", required=True)
        if action == "init":
            # --config-root also exists on the root parser; SUPPRESS here means an operator who
            # omits it keeps that inherited default instead of this subparser silently blanking it.
            command.add_argument("--config-root", type=pathlib.Path, default=argparse.SUPPRESS)
            command.add_argument("--flota-json", type=pathlib.Path, default=flota)
            command.add_argument("--agent-pki-root", type=pathlib.Path, default=agent_pki_root)
            command.add_argument("--examples-root", type=pathlib.Path, default=examples_root)
            command.add_argument("--dry-run", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    alias = arguments.alias
    if ALIAS_RE.fullmatch(alias) is None:
        raise ConfigUpdateError("el alias tiene formato invalido")
    if arguments.action == "init":
        result = init_alias(
            arguments.config_root,
            arguments.pki_root,
            arguments.agent_pki_root,
            arguments.flota_json,
            arguments.examples_root,
            alias,
            dry_run=arguments.dry_run,
        )
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
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
        print("config update failed: error operacional no divulgado", file=sys.stderr)
        raise SystemExit(2) from None
