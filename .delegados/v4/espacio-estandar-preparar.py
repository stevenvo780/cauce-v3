"""Prepare sealed operational sources and the layout module from an exact Git archive."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ARCHIVE_PATHS = ("ops/scripts", "ops/container-runtime", "packages/adapter-sdk/src", "packages/adapter-sdk/package.json",
                 "packages/protocol/src", "packages/protocol/package.json", "package.json", "pnpm-lock.yaml",
                 ".delegados/v4/espacio-estandar.py", ".delegados/v4/espacio-estandar.remoto.py", ".delegados/v4/live_adapter.py")
ALIAS_FIELDS = ("tenant", "room", "container", "user", "home", "stateDirectory", "harness", "membershipRole", "systemdUser",
                "registryContainer", "workspace", "dockerHost", "alias", "bootstrap", "admission", "enabled")
PHASE = "arguments"
ERROR_TYPES = {"Failure", "FileNotFoundError", "PermissionError", "FileExistsError", "NotADirectoryError", "IsADirectoryError",
               "ModuleNotFoundError", "ImportError", "AttributeError", "KeyError", "ValueError", "TypeError", "JSONDecodeError",
               "TimeoutExpired", "OSError", "RuntimeError", "SyntaxError"}


class Failure(RuntimeError):
    pass


def fail(code):
    raise Failure(code)


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def command(argv, *, data=None, timeout=180, environment=None):
    try:
        result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout, env=environment, cwd=ROOT, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Failure("SPACE_PREPARE_COMMAND_UNAVAILABLE_OR_TIMEOUT") from error
    if result.returncode:
        fail("SPACE_PREPARE_COMMAND_REJECTED")
    return result.stdout


def absolute(value):
    if not isinstance(value, str) or not re.fullmatch(r"/[A-Za-z0-9._/-]+", value) or os.path.normpath(value) != value \
            or "//" in value or value == "/":
        fail("SPACE_PREPARE_PATH_INVALID")
    return pathlib.Path(value)


def receipt(path, value):
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    descriptor, staging = tempfile.mkstemp(prefix=".prepare-receipt-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            if stream.write(encoded) != len(encoded):
                fail("SPACE_PREPARE_RECEIPT_WRITE_INCOMPLETE")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staging, path, follow_symlinks=False)
    finally:
        os.unlink(staging)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def archived(commit, target):
    payload = command(["git", "-C", str(ROOT), "archive", "--format=tar", commit, "--", *ARCHIVE_PATHS])
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as bundle:
        members = bundle.getmembers()
        if sum(member.size for member in members) > 134_217_728:
            fail("SPACE_PREPARE_ARCHIVE_TOO_LARGE")
        for member in members:
            relative = pathlib.PurePosixPath(member.name)
            if relative.is_absolute() or ".." in relative.parts or not (member.isfile() or member.isdir()):
                fail("SPACE_PREPARE_ARCHIVE_ENTRY_UNSAFE")
            if any(part in {"private", "credentials", "auth.json", ".env"} for part in relative.parts) \
                    or relative.name.startswith(".env.") and not relative.name.endswith(".example"):
                fail("SPACE_PREPARE_ARCHIVE_CREDENTIAL_PATH_REJECTED")
        bundle.extractall(target, filter="data")
    return digest_bytes(payload)


def archived_controller(source):
    filename = source / ".delegados/v4/espacio-estandar.py"
    specification = importlib.util.spec_from_file_location("space_archived_controller", filename)
    if specification is None or specification.loader is None:
        fail("SPACE_PREPARE_ARCHIVED_CONTROLLER_UNAVAILABLE")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


MAPPING_QUERY = r'''
import hashlib,json,os,pathlib,re,shlex,stat,subprocess,sys
a=json.load(sys.stdin)
def fail(): raise ValueError()
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=30,check=False)
 if p.returncode: fail()
 return p.stdout
try:
 raw=run(['systemctl','--user','show',a['unit'],'--no-pager','--property=LoadState,Environment,ExecStart'])
 props=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
 if props.get('LoadState')!='loaded': fail()
 values=dict(item.split('=',1) for item in shlex.split(props.get('Environment','')) if '=' in item)
 root=values.get('CAUCE_CONTAINER_OPS_ROOT'); origin='unit_environment'
 if not root:
  matches=re.findall(r'path=([^ ;}]+/scripts/container-adapter-supervisor[.]sh)',props.get('ExecStart',''))
  if len(matches)!=1: fail()
  root=str(pathlib.Path(matches[0]).parent.parent); origin='execstart_supervisor'
 if not re.fullmatch(r'/[A-Za-z0-9._/-]+',root) or os.path.normpath(root)!=root or any(v in {'private','credentials'} for v in pathlib.Path(root).parts): fail()
 source=pathlib.Path(root).resolve()/'container-aliases.json'
 fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  info=os.fstat(stream.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_mode&0o002 or info.st_size>1048576: fail()
  payload=stream.read(1048577)
 if len(payload)>1048576: fail()
 document=json.loads(payload); aliases=document.get('aliases')
 if document.get('schemaVersion')!=2 or not isinstance(aliases,dict) or not isinstance(aliases.get(a['alias']),dict): fail()
 selected=aliases[a['alias']]
 if selected.get('container')!=a['container']: fail()
 fields=('tenant','room','container','user','home','stateDirectory','harness','membershipRole','systemdUser','registryContainer','workspace','dockerHost','alias','bootstrap','admission','enabled')
 peers={key:{field:entry[field] for field in fields if field in entry} for key,entry in aliases.items()
        if isinstance(entry,dict) and entry.get('container')==a['container']}
 print(json.dumps({'ok':True,'value':{'aliases':peers,'source_path':str(source),'source_sha256':hashlib.sha256(payload).hexdigest(),'discovered_via':origin}},sort_keys=True,separators=(',',':')))
except Exception:
 print(json.dumps({'ok':False,'code':'SPACE_PREPARE_LIVE_MAPPING_UNAVAILABLE'},sort_keys=True))
'''


def read_mapping(agent, controller):
    payload = json.dumps({key: agent[key] for key in ("alias", "unit", "container")}).encode()
    argv = ["python3", "-I", "-B", "-c", MAPPING_QUERY]
    if agent["transport"] == "ssh":
        result = controller.adapter.remote(agent, argv, data=payload, timeout=75)
    else:
        prefix = ["docker", "exec", "-i", "--user", str(agent["uid"]), agent["host"], "env", "-C", "/",
                  "XDG_RUNTIME_DIR=/run/user/" + str(agent["uid"]),
                  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + str(agent["uid"]) + "/bus"]
        result = command([*prefix, *argv], data=payload, timeout=75).decode()
    envelope = json.loads(result)
    if envelope.get("ok") is not True:
        fail("SPACE_PREPARE_LIVE_MAPPING_UNAVAILABLE")
    value = envelope["value"]
    if not isinstance(value.get("aliases"), dict) or not re.fullmatch(r"[a-f0-9]{64}", value.get("source_sha256", "")):
        fail("SPACE_PREPARE_LIVE_MAPPING_INVALID")
    for entry in value["aliases"].values():
        if not isinstance(entry, dict) or set(entry) - set(ALIAS_FIELDS):
            fail("SPACE_PREPARE_LIVE_MAPPING_INVALID")
    return value


def build_ops(source, destination, mappings, controller, agents):
    destination.mkdir(mode=0o700)
    for name in ("scripts", "container-runtime"):
        shutil.copytree(source / "ops" / name, destination / name)
    aliases = {}
    provenance = []
    for agent, measured in mappings:
        for alias, entry in measured["aliases"].items():
            if alias in aliases and aliases[alias] != entry:
                fail("SPACE_PREPARE_LIVE_MAPPING_CONFLICT")
            aliases[alias] = entry
        provenance.append({"alias": agent["alias"], "host": agent["host"], "unit": agent["unit"],
                           **{key: measured[key] for key in ("source_path", "source_sha256", "discovered_via")},
                           "peer_aliases": sorted(measured["aliases"])})
    mapping = {"schemaVersion": 2, "systemPrincipals": {}, "historicalAliases": {}, "aliases": aliases}
    path = destination / "container-aliases.json"
    path.write_text(json.dumps(mapping, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)
    if aliases:
        for agent in agents:
            controller.container_mapping(destination, agent)
    return provenance


def build_sdk(source, destination, scratch):
    global PHASE
    PHASE = "sdk_compilation"
    output = destination / "packages/adapter-sdk/dist/src/context/space-layout.js"
    output.parent.mkdir(parents=True, mode=0o700)
    (destination / "packages/adapter-sdk/package.json").write_text('{"name":"@cauce/adapter-sdk","type":"module"}\n')
    compiler = ROOT / "node_modules/.bin/esbuild"
    if not compiler.is_file() or not os.access(compiler, os.X_OK):
        fail("SPACE_PREPARE_COMPILER_UNAVAILABLE")
    metadata = scratch / "compiler-inputs.json"
    environment = {**os.environ, "NODE_PATH": os.pathsep.join(str(ROOT / name) for name in
                   ("node_modules", "packages/protocol/node_modules", "packages/adapter-sdk/node_modules"))}
    entry = source / "packages/adapter-sdk/src/context/space-layout.ts"
    arguments = [str(compiler), str(entry), "--bundle", "--platform=node", "--format=esm", "--target=node22", "--log-level=error", "--minify-whitespace",
                 "--outfile=" + str(output), "--metafile=" + str(metadata),
                 "--alias:@cauce/protocol=" + str(source / "packages/protocol/src/index.ts"),
                 '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);']
    command(arguments, environment=environment)
    PHASE = "sdk_input_validation"
    inputs = json.loads(metadata.read_text())["inputs"]
    dependency_hashes = {}
    for name in inputs:
        path = pathlib.Path(name)
        path = (ROOT / path).resolve() if not path.is_absolute() else path.resolve()
        if path.is_relative_to(source):
            continue
        if "node_modules" not in path.parts or path.is_relative_to(ROOT / "packages") and ".pnpm" not in path.parts:
            fail("SPACE_PREPARE_COMPILER_USED_NONARCHIVED_SOURCE")
        dependency_hashes[str(path)] = digest_bytes(path.read_bytes())
    PHASE = "sdk_module_validation"
    command(["node", "--check", str(output)])
    module_test = "const m=await import(process.argv[1]);if(typeof m.prepareSpaceLayout!=='function'||m.SPACE_DIRECTORIES.length!==7)process.exit(78)"
    command(["node", "--input-type=module", "-e", module_test, output.as_uri()])
    return {"name": "esbuild", "version": command([str(compiler), "--version"]).decode().strip(),
            "launcher_sha256": digest_bytes(compiler.read_bytes()), "entry_source_sha256": digest_bytes(entry.read_bytes()),
            "lockfile_sha256": digest_bytes((source / "pnpm-lock.yaml").read_bytes()),
            "bundled_dependencies": dependency_hashes,
            "module_sha256": digest_bytes(output.read_bytes())}


def seal(root):
    for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        info = path.lstat()
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            fail("SPACE_PREPARE_OUTPUT_TYPE_INVALID")
        path.chmod(0o555 if path.is_dir() or info.st_mode & 0o111 else 0o444)
    root.chmod(0o555)


def prepare(args):
    global PHASE
    if not re.fullmatch(r"[a-f0-9]{7,40}", args.commit):
        fail("SPACE_PREPARE_EXACT_COMMIT_REQUIRED")
    PHASE = "commit_resolution"
    commit = command(["git", "-C", str(ROOT), "rev-parse", "--verify", args.commit + "^{commit}"]).decode().strip()
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        fail("SPACE_PREPARE_EXACT_COMMIT_REQUIRED")
    PHASE = "output_path_validation"
    inventory_path = absolute(args.inventario)
    target = absolute(args.salida) if args.salida else HERE / "recibos/s2c-ventana-produccion-1025" / ("preparado-" + commit[:12] + "-" + uuid.uuid4().hex[:12])
    if os.path.lexists(target):
        fail("SPACE_PREPARE_OUTPUT_ALREADY_EXISTS")
    ancestor = target.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    if ancestor.resolve() != ancestor or ancestor.stat().st_uid != os.geteuid() or ancestor.stat().st_mode & 0o022:
        fail("SPACE_PREPARE_OUTPUT_PARENT_UNSAFE")
    PHASE = "output_creation"
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".prepare-archive-", dir=target) as temporary:
        scratch = pathlib.Path(temporary)
        source = scratch / "archive"
        source.mkdir(mode=0o700)
        PHASE = "archive_extraction"
        archive_sha256 = archived(commit, source)
        PHASE = "archive_controller_import"
        controller = archived_controller(source)
        PHASE = "inventory_validation"
        agents = controller.inventory(inventory_path)
        PHASE = "laboratory_scope_validation"
        for agent in agents:
            controller.lab_guard(agent, args.laboratorio)
        PHASE = "mapping_read"
        mappings = [(agent, read_mapping(agent, controller)) for agent in agents if agent["kind"] == "container"]
        ops = target / "ops"
        sdk = target / "sdk"
        PHASE = "ops_assembly"
        provenance = build_ops(source, ops, mappings, controller, agents)
        compiler = build_sdk(source, sdk, scratch)
        PHASE = "sealing"
        seal(ops)
        seal(sdk)
        PHASE = "digests"
        ops_digest = controller.bundle_digest(str(ops))
        sdk_digest = controller.bundle_digest(str(sdk))
        PHASE = "artifact_validation"
        controller.source_tree(str(ops), ops_digest, "ops")
        controller.source_tree(str(sdk), sdk_digest, "sdk")
        for agent in agents:
            controller.container_mapping(ops, agent)
        PHASE = "receipt_assembly"
        value = {"version": 1, "status": "prepared", "commit": commit, "inventory_path": str(inventory_path),
                 "inventory_sha256": digest_bytes(inventory_path.read_bytes()), "ops_release": str(ops), "ops_sha256": ops_digest,
                 "sdk_release": str(sdk), "sdk_sha256": sdk_digest, "prepared_at": datetime.datetime.now(datetime.UTC).isoformat(),
                 "production_writes": False, "remote_reads_only": True, "aliases": [agent["alias"] for agent in agents],
                 "provenance": {"git_archive_sha256": archive_sha256, "git_archive_paths": list(ARCHIVE_PATHS),
                                "mapping_sources": provenance, "compiler": compiler,
                                "controller_source_sha256": digest_bytes((source / ".delegados/v4/espacio-estandar.py").read_bytes()),
                                "canonical_digest_source_sha256": digest_bytes((source / "ops/container-runtime/cauce_container_base.py").read_bytes())}}
        PHASE = "archive_cleanup"
    PHASE = "receipt_write"
    receipt(target / "recibo.json", value)
    PHASE = "complete"
    return value


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("commit")
    parser.add_argument("--salida")
    window = HERE / "espacio-estandar-ventana.inventario.json"
    parser.add_argument("--inventario", default=str(window if window.exists() else HERE / "espacio-estandar.inventario.json"))
    parser.add_argument("--laboratorio", action="store_true")
    return prepare(parser.parse_args())


if __name__ == "__main__":
    try:
        print(json.dumps(main(), sort_keys=True, separators=(",", ":")))
    except Exception as error:
        code = str(error) if isinstance(error, Failure) else "SPACE_PREPARE_FAILED_WITHOUT_SECRET_OUTPUT"
        error_type = type(error.__cause__ if error.__cause__ is not None else error).__name__
        print(json.dumps({"ok": False, "code": code, "phase": PHASE,
                          "exception_type": error_type if error_type in ERROR_TYPES else "Other"}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1) from None
