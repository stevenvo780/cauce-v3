"""Plan and apply adapter releases through existing lifecycle and fleet tools."""
from __future__ import annotations

import argparse
import datetime
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
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
SHA = re.compile(r"[a-f0-9]{40}\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
NAME = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
RELEASE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
PYTHON = "import runpy,sys;sys.argv=sys.argv[1:];sys.path.insert(0,sys.argv.pop(0));runpy.run_path(sys.argv[0],run_name='__main__')"


class Failure(RuntimeError):
    pass


class CompletionUnknown(Failure):
    pass


def now():
    return datetime.datetime.now(datetime.UTC).isoformat()


def checked(argv, *, data=None, timeout=180, env=None, cwd=None, pass_fds=()):
    try:
        result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout,
                                env=env, cwd=cwd, check=False, pass_fds=pass_fds)
    except subprocess.TimeoutExpired as error:
        raise CompletionUnknown("command completion is unknown after timeout; canonical settlement is required") from error
    except OSError as error:
        raise Failure(f"command unavailable: {pathlib.Path(argv[0]).name}") from error
    if pathlib.Path(argv[0]).name == "ssh" and (result.returncode == 255 or result.returncode < 0):
        raise CompletionUnknown("SSH completion is unknown; canonical settlement is required")
    if result.returncode:
        raise Failure(f"command failed: {pathlib.Path(argv[0]).name}; exit={result.returncode}")
    return result.stdout.decode("utf8")


def absolute(value):
    if not isinstance(value, str) or not re.fullmatch(r"/[A-Za-z0-9._/-]+", value) \
            or any(part in (".", "..") for part in value.split("/")[1:]) or "//" in value:
        raise Failure("expected canonical absolute path")
    return value


def private_json(path):
    path = pathlib.Path(absolute(str(path)))
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r", encoding="utf8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2_097_152:
            raise Failure("inventory or receipt is not a bounded regular file")
        return json.load(stream)


def save(path, value, *, create=False):
    path = pathlib.Path(absolute(str(path)))
    if create and path.exists():
        raise Failure("receipt already exists; use a new path")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, staging = tempfile.mkstemp(prefix=".adapter-receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if create:
            os.link(staging, path)
        else:
            os.replace(staging, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(staging):
            os.unlink(staging)


def normalize(inventory):
    if inventory.get("version") == 1:
        agents = inventory["agents"]
    else:
        agents = []
        for row in inventory.get("v3_agents", []):
            agents.append({**row, "kind": row["runtime_mode"], "transport": "ssh",
                           "host": row["ssh_target"], "manager": row["manager_user"],
                           "uid": row["manager_uid"], "lifecycle": "systemd",
                           "supervisor_path": row["ops_root"] + "/scripts/container-adapter-supervisor.sh"})
        host = inventory.get("v4_host", {})
        for row in inventory.get("v4_agents", []):
            agents.append({**host, **row, "kind": "fleet", "transport": "ssh",
                           "host": host["ssh_target"], "manager": host["manager_user"],
                           "uid": host["manager_uid"], "harness": row["expected_harness"],
                           "runtime_root": host["current_tools_root"],
                           "ops_root": host["current_tools_root"] + "/ops"})
    if not agents or len(agents) > 32:
        raise Failure("inventory has no bounded agent list")
    seen = set()
    for agent in agents:
        alias = agent.get("alias", "")
        if not NAME.fullmatch(alias) or alias in seen:
            raise Failure("invalid or duplicate alias")
        seen.add(alias)
        if agent.get("kind") not in ("container", "native", "fleet"):
            raise Failure("unknown canonical update strategy")
        agent["strategy"] = agent["kind"]
        if agent.get("transport") not in ("ssh", "local"):
            raise Failure("unknown transport")
        if agent.get("transport") == "ssh" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", agent.get("host", "")):
            raise Failure("invalid SSH target")
        if agent.get("harness") not in ("claude", "codex", "grok", "muse", "openclaw"):
            raise Failure("harness must be explicitly measured")
        for key in ("ops_root", "bundle_root", "config_root", "supervisor_path", "state_directory"):
            if agent.get(key) is not None:
                absolute(agent[key])
    return agents


def remote(agent, argv, data=None, timeout=180):
    payload = data.encode() if isinstance(data, str) else data
    if agent["transport"] == "local":
        return checked(argv, data=payload, timeout=timeout)
    manager = agent["manager"]
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", manager) or not isinstance(agent["uid"], int):
        raise Failure("invalid manager identity")
    # Start in / so a manager reached through runuser does not inherit root's
    # unreadable home as its cwd (find aborts there and the check fails).
    command = ["env", "-C", "/", f"XDG_RUNTIME_DIR=/run/user/{agent['uid']}", "PYTHONDONTWRITEBYTECODE=1", *argv]
    if agent.get("ssh_user", manager) != manager:
        command = ["runuser", "-u", manager, "--", *command]
    return checked(["ssh", "-oBatchMode=yes", "-oConnectTimeout=8", "-oStrictHostKeyChecking=yes", "-oUpdateHostKeys=no",
                    "-oControlMaster=no", "-oControlPath=none", agent["host"], shlex.join(command)],
                   data=payload, timeout=timeout)


def python(agent, source, *args, timeout=180):
    return remote(agent, ["python3", "-I", "-B", "-c", source, *args], timeout=timeout)


def canonical(agent, name, *args):
    directory = agent["ops_root"] + "/scripts"
    return ["python3", "-I", "-B", "-c", PYTHON, directory, directory + "/" + name, *args]


def digest(agent, path):
    directory = agent["ops_root"] + "/container-runtime"
    value = remote(agent, ["python3", "-I", "-B", "-c", PYTHON, directory,
                           directory + "/cauce-container-runtime.py", "bundle-digest", path]).strip()
    if not DIGEST.fullmatch(value):
        raise Failure("canonical helper did not attest bundle digest")
    return value


def systemctl(agent, *args):
    return remote(agent, ["systemctl", "--user", *args])


def before(agent, *, allow_reload=False):
    if agent["kind"] == "container":
        help_text = remote(agent, canonical(agent, "pin-container-release.py", "--help"))
        if any(flag not in help_text for flag in ("--release", "--sha256", "--expected-release", "--expected-sha256", "--config-root", "--bundle-root")) \
                or not all(re.search(r"\b" + action + r"\b", help_text) for action in ("pin", "rollback")):
            raise Failure("installed canonical pin helper lacks the required CAS contract; no runtime was stopped")
        source = "import json,pathlib,sys;v=dict(line.split('=',1) for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.startswith(('BUNDLE_RELEASE=','BUNDLE_SHA256=')));print(json.dumps({'release':v['BUNDLE_RELEASE'],'digest':v['BUNDLE_SHA256']}))"
        state = json.loads(python(agent, source, agent["config_root"] + "/" + agent["alias"] + ".env"))
    else:
        actual = systemctl(agent, "show", agent["unit"], "-p", "ExecStart", "--value").strip()
        match = re.search(r"(/[^ ;]+/releases/([^ /;]+)/packages/adapter-sdk/dist/src/bin/([a-z]+)\.js)", actual)
        if not match or match[3] != agent["harness"]:
            raise Failure("native ExecStart does not attest the expected harness entry")
        entry = match[1]
        argv_match = re.search(r"argv\[\]=(.*?)(?: ;|\s*;)", actual)
        if not argv_match:
            raise Failure("native ExecStart argv cannot be preserved exactly")
        argv = shlex.split(argv_match[1])
        if argv[-1] != entry or any("%" in item or "\n" in item for item in argv):
            raise Failure("native argv requires a separately reviewed wrapper")
        if not (len(argv) == 2 or len(argv) == 4 and argv[0] == "/usr/bin/env"
                and argv[1] == "CAUCE_INSTANCE_ID=systemd-" + agent["alias"]):
            raise Failure("native argv is outside the measured direct launcher")
        kill_mode = systemctl(agent, "show", agent["unit"], "-p", "KillMode", "--value").strip()
        if kill_mode != "process":
            raise Failure("native KillMode is not process; preserve human TUI through canonical adoption first")
        guards = systemctl(agent, "show", agent["unit"], "-p", "ExecStop", "-p", "ExecStopPost",
                           "-p", "NeedDaemonReload", "-p", "FragmentPath", "-p", "DropInPaths")
        properties = dict(line.split("=", 1) for line in guards.splitlines() if "=" in line)
        if properties.get("ExecStop") or properties.get("ExecStopPost"):
            raise Failure("native stop hooks require separate review to protect the human TUI")
        if properties.get("NeedDaemonReload") != "no" and not allow_reload:
            raise Failure("native unit requires daemon-reload; no runtime was stopped")
        path = agent["bundle_root"] + "/releases/" + match[2]
        state = {"release": match[2], "digest": digest(agent, path), "argv": argv,
                 "entry": entry, "kill_mode": kill_mode,
                 "unit_revision": hashlib.sha256(guards.encode()).hexdigest()}
    if not RELEASE.fullmatch(state["release"]) or not DIGEST.fullmatch(state["digest"]):
        raise Failure("current release pin is invalid")
    return state


def supervisor(agent, action, *, background=False):
    env = ["env", "PYTHONDONTWRITEBYTECODE=1", "CAUCE_CONTAINER_OPS_ROOT=" + agent["ops_root"]]
    if agent.get("lifecycle") == "supervisor":
        env += ["CAUCE_CONTAINER_TEST_MODE=1", "CAUCE_ALLOW_ROOT_TEST_MODE=1"]
        for key in ("config", "bundle", "pki", "lock", "control"):
            env.append("CAUCE_CONTAINER_" + key.upper() + "_ROOT=" + agent[key + "_root"])
        env += ["CAUCE_CONTAINER_WAIT_SECONDS=0"]
    command = [*env, "bash", agent["supervisor_path"], action, agent["alias"]]
    if background:
        source = "import os,subprocess,sys;p=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True);print(p.pid)"
        return int(python(agent, source, *command))
    return remote(agent, command)


def stop(agent):
    if agent.get("lifecycle") == "supervisor":
        supervisor(agent, "stop")
    else:
        # PartOf= companions (the native PTY unit) stop with the adapter but never start with it again.
        members = systemctl(agent, "show", agent["unit"], "-p", "ConsistsOf", "--value").split()
        if any(not re.fullmatch(r"[A-Za-z0-9@._-]+\.service", unit) for unit in members):
            raise Failure("adapter companion units cannot be preserved")
        agent["_companions"] = [unit for unit in members
                                if systemctl(agent, "show", unit, "-p", "ActiveState", "--value").strip() == "active"]
        systemctl(agent, "stop", agent["unit"])
    if agent["kind"] == "container":
        supervisor(agent, "stopped")
    elif systemctl(agent, "show", agent["unit"], "-p", "MainPID", "--value").strip() != "0":
        raise Failure("native adapter did not stop")


def start(agent):
    if agent.get("lifecycle") == "supervisor":
        supervisor(agent, "start", background=True)
    else:
        systemctl(agent, "start", agent["unit"])
        for unit in agent.get("_companions", []):
            systemctl(agent, "start", unit)


def install_bundle(agent, source, release, expected_digest):
    target = agent["bundle_root"] + "/releases/" + release
    exists = python(agent, "import os,sys;print(int(os.path.lexists(sys.argv[1])))", target).strip() == "1"
    if exists:
        if digest(agent, target) != expected_digest:
            raise Failure("immutable target release already exists with a different digest")
        return
    archive = subprocess.run(["tar", "-C", str(source), "-cf", "-", "."], capture_output=True, check=True).stdout
    code = """import os,pathlib,stat,sys,tarfile,uuid
target=pathlib.Path(sys.argv[1]); parent=target.parent
parent.mkdir(parents=True,exist_ok=True,mode=0o755)
if parent.resolve()!=parent or target.exists(): raise RuntimeError('destination changed')
staging=parent/('.adapter-staging-'+uuid.uuid4().hex); staging.mkdir(mode=0o700)
modes={}
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
 for member in archive:
  relative=pathlib.PurePosixPath(member.name)
  if relative.is_absolute() or '..' in relative.parts or not (member.isdir() or member.isfile() or member.issym() or member.islnk()): raise RuntimeError('unsupported bundle entry')
  modes[staging.joinpath(*relative.parts)]=member.mode&0o777&~0o222
  archive.extract(member,staging,filter='data')
for path in [*staging.rglob('*'),staging]:
 info=path.lstat()
 if info.st_uid!=os.geteuid(): raise RuntimeError('bundle owner differs')
 if not stat.S_ISLNK(info.st_mode): path.chmod(modes[path])
os.rename(staging,target)
"""
    remote(agent, ["python3", "-I", "-B", "-c", code, target], archive, timeout=300)
    if digest(agent, target) != expected_digest:
        raise Failure("installed bundle digest differs")


def native_intent(agent, old, release):
    entry = agent["bundle_root"] + "/releases/" + release + "/packages/adapter-sdk/dist/src/bin/" + agent["harness"] + ".js"
    argv = [entry if item == old["entry"] else item for item in old["argv"]]
    content = "[Service]\nExecStart=\nExecStart=" + " ".join('"' + item.replace('\\', '\\\\').replace('"', '\\"') + '"' for item in argv) + "\n"
    path = agent["unit_file"] + ".d/zzzzzzzz-adaptador-vivo.conf"
    return {"dropin": path, "dropin_content": content,
            "dropin_digest": hashlib.sha256(content.encode()).hexdigest()}


def native_pin(agent, old, intent, expected):
    if before(agent) != old:
        raise Failure("native ExecStart changed since inventory; no pin written")
    source = """import hashlib,json,os,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]); expected=sys.argv[2]; content=sys.argv[3]
if path.is_symlink(): raise RuntimeError('drop-in symlink refused')
actual=hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else 'absent'
if actual!=expected: raise RuntimeError('drop-in CAS failed')
path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
fd,tmp=tempfile.mkstemp(dir=path.parent)
with os.fdopen(fd,'w') as stream:
 os.fchmod(stream.fileno(),0o600);stream.write(content);stream.flush();os.fsync(stream.fileno())
os.replace(tmp,path)
"""
    python(agent, source, intent["dropin"], expected, intent["dropin_content"])
    systemctl(agent, "daemon-reload")
    if before(agent)["entry"] not in intent["dropin_content"]:
        raise Failure("a later native drop-in overrides the requested release")


def pin(agent, old, release, bundle_digest, *, revert=False):
    if agent["kind"] == "container":
        return remote(agent, canonical(agent, "pin-container-release.py", "rollback" if revert else "pin", agent["alias"],
                       "--release", release, "--sha256", bundle_digest, "--expected-release", old["release"],
                       "--expected-sha256", old["digest"], "--config-root", agent["config_root"],
                       "--bundle-root", agent["bundle_root"]))
    raise Failure("native pin requires its recorded drop-in CAS")


def validate_probe(args):
    path = pathlib.Path(absolute(args.sonda))
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_uid != os.geteuid() \
            or info.st_nlink != 1 or not os.access(path, os.X_OK):
        raise Failure("probe must be a caller-owned single-link reviewed executable without group/world write")
    expected = args.sonda_sha256.removeprefix("sha256:")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise Failure("reviewed probe digest differs")
    return path


def probe(args, agent, release):
    path = validate_probe(args)
    nonce = uuid.uuid4().hex
    env = {**os.environ, "CAUCE_LIVE_ADAPTER_AGENT": json.dumps(agent),
           "CAUCE_LIVE_ADAPTER_STARTED_AT": agent.get("_started_at", now()),
           "CAUCE_LIVE_ADAPTER_TIMEOUT_SECONDS": str(args.timeout)}
    if args.sesion:
        env["CAUCE_LIVE_ADAPTER_SESSION_FILE"] = args.sesion
    for key in ("gateway", "origin", "ca_file"):
        if getattr(args, key):
            env["CAUCE_LIVE_ADAPTER_" + key.upper()] = getattr(args, key)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 \
                or details.st_mode & 0o022 or not details.st_mode & 0o100:
            raise Failure("opened probe inode does not match its reviewed ownership and mode")
        with os.fdopen(os.dup(fd), "rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != args.sonda_sha256.removeprefix("sha256:"):
                raise Failure("probe changed after review")
        os.lseek(fd, 0, os.SEEK_SET)
        executable = "/proc/self/fd/" + str(fd)
        command = ([sys.executable, "-I", "-B", executable] if path == HERE / "live_adapter_probe.py" else [executable])
        value = json.loads(checked([*command, agent["alias"], release, nonce], timeout=args.timeout,
                                   env=env, pass_fds=(fd,)))
    finally:
        os.close(fd)
    if value.get("alias") != agent["alias"] or value.get("release") != release or value.get("nonce") != nonce:
        raise Failure("probe did not correlate this release check")
    keys = ("process_alive", "hello_ack", "lease_valid", "delivery_done")
    if any(value.get(key) is not True for key in keys) or value.get("effective_release") != release:
        raise Failure("process, effective release, hello/lease or real delivery remain unverified")
    if not isinstance(value.get("delivery_id"), str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,128}", value["delivery_id"]):
        raise Failure("probe lacks a durable delivery identity")
    return {key: value[key] for key in ("alias", "release", "nonce", "effective_release", "delivery_id", *keys)}


def build(args, ref):
    if args.bundle_preconstruido:
        source = pathlib.Path(absolute(args.bundle_preconstruido))
        if (source / ".release-sha").read_text().strip() != ref:
            raise Failure("laboratory bundle commit differs")
        return source
    # pnpm writes timestamps and absolute paths into the bundle, so a rebuild of
    # the same ref gets another digest. Reuse the oldest finished build whose
    # modes already match the container copy (builds before that fix do not).
    if not args.trabajo:
        builds = (HERE / "recibos" / "t3-adaptador-vivo-1025").glob("build-*/bundle/.release-sha")
        for marker in sorted(builds, key=lambda path: path.stat().st_mtime):
            if not marker.parent.is_symlink() and stat.S_IMODE(marker.stat().st_mode) == 0o444 \
                    and marker.read_text().strip() == ref:
                return marker.parent
    work = pathlib.Path(absolute(args.trabajo or str(HERE / "recibos" / "t3-adaptador-vivo-1025" / ("build-" + uuid.uuid4().hex))))
    work.mkdir(parents=True, mode=0o700, exist_ok=False)
    checkout = work / "source"
    previous_umask = os.umask(0o022)
    try:
        checked(["git", "worktree", "add", "--detach", str(checkout), ref], cwd=ROOT)
        checked(["pnpm", "install", "--offline", "--frozen-lockfile"], cwd=checkout, timeout=600)
        source = work / "bundle"
        checked(["bash", str(checkout / "ops/scripts/build-adapter-release.sh"), str(source)], cwd=checkout, timeout=1200)
        source.chmod(0o755)
        (source / ".release-sha").write_text(ref + "\n")
    finally:
        os.umask(previous_umask)
    # The container supervisor copies the bundle and applies `chmod -R u=rX,go=rX`
    # before it attests the digest, so the bundle must already have those modes.
    for path in [*source.rglob("*"), source]:
        if not path.is_symlink():
            mode = stat.S_IMODE(path.stat().st_mode)
            path.chmod(0o555 if path.is_dir() or mode & 0o111 else 0o444)
    return source


def arguments():
    parser = argparse.ArgumentParser(description="Actualiza adaptadores sin modificar terminales ni credenciales; por defecto solo simula.")
    parser.add_argument("--ref")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--agente", action="append")
    target.add_argument("--todos", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--simular", action="store_true")
    mode.add_argument("--ejecutar", action="store_true")
    parser.add_argument("--revertir", action="store_true")
    parser.add_argument("--recibo")
    parser.add_argument("--salida-recibo")
    parser.add_argument("--inventario", default=str(HERE / "adaptador-vivo.inventario.json"))
    parser.add_argument("--laboratorio", action="store_true")
    parser.add_argument("--bundle-preconstruido")
    parser.add_argument("--trabajo")
    parser.add_argument("--sonda")
    parser.add_argument("--sonda-sha256")
    parser.add_argument("--sesion", help="Sesión local existente del dueño; usa la sonda canónica incluida sin copiarla al host remoto")
    parser.add_argument("--gateway")
    parser.add_argument("--origin")
    parser.add_argument("--ca-file")
    parser.add_argument("--timeout", type=int, default=180)
    return parser.parse_args()


def main():
    args = arguments()
    if not 1 <= args.timeout <= 600:
        raise Failure("--timeout must be between 1 and 600 seconds")
    if args.sesion:
        absolute(args.sesion)
        if not args.sonda:
            args.sonda = str(HERE / "live_adapter_probe.py")
            args.sonda_sha256 = hashlib.sha256(pathlib.Path(args.sonda).read_bytes()).hexdigest()
    agents = normalize(private_json(args.inventario))
    selected = agents if args.todos else [agent for agent in agents if agent["alias"] in args.agente]
    if not selected or args.agente and len(selected) != len(set(args.agente)):
        raise Failure("selected alias is not in the measured inventory")
    if any(agent["transport"] == "local" for agent in selected) and not args.laboratorio:
        raise Failure("local lifecycle is only available in the laboratory")
    if args.laboratorio and (any(not agent["alias"].startswith("zz-canary-") or agent["transport"] != "local" for agent in selected)
                            or not (os.environ.get("CI") == "1" or os.environ.get("DOCKER_CONTEXT") in ("lab", "lab2", "lab3"))):
        raise Failure("laboratory mode requires owned aliases and an explicit lab environment")
    if args.bundle_preconstruido and not args.laboratorio:
        raise Failure("prebuilt artifacts are only accepted in the laboratory")
    previous = private_json(args.recibo) if args.revertir and args.recibo else None
    if args.revertir and previous is None:
        raise Failure("rollback requires its original receipt")
    if args.revertir:
        ref = previous["ref"]
        if previous.get("version") != 1 or not isinstance(ref, str) or not SHA.fullmatch(ref):
            raise Failure("rollback receipt has no exact source identity")
        details = pathlib.Path(args.recibo).lstat()
        if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600 or details.st_nlink != 1:
            raise Failure("rollback receipt must be private, single-link and owned by the caller")
    else:
        if not args.ref or not re.fullmatch(r"[a-f0-9]{7,40}", args.ref):
            raise Failure("--ref requires an exact deployed Git commit")
        ref = checked(["git", "rev-parse", "--verify", args.ref + "^{commit}"], cwd=ROOT).strip()
        if not SHA.fullmatch(ref):
            raise Failure("source commit is invalid")
        checked(["git", "merge-base", "--is-ancestor", "5464c84e", ref], cwd=ROOT)
    release = "live-" + ref[:12]
    plan = {"version": 1, "ref": ref, "release": release, "created_at": now(),
            "simulated": not args.ejecutar, "direction": "rollback" if args.revertir else "forward", "agents": {}}
    for agent in selected:
        agent["_simulation"] = not args.ejecutar
        if args.sesion:
            agent["fleet_session_file"] = args.sesion
            for key in ("gateway", "origin", "ca_file"):
                if getattr(args, key):
                    agent["fleet_" + key] = getattr(args, key)
        try:
            if args.revertir:
                original_record = previous["agents"][agent["alias"]]
                if original_record.get("completion_unknown") or original_record.get("submission_state_unknown") \
                        or (original_record.get("state") == "pending" or original_record.get("status") in ("pending", "submitting")) and not original_record.get("operation_id") \
                        or original_record.get("state") in ("stopping", "pinning", "starting", "started", "restoring_previous_start"):
                    raise Failure("previous mutation has unknown completion; retain receipt and prove canonical settlement before rollback")
                recorded = original_record["agent"]
                if any(agent.get(key) != recorded.get(key) for key in
                       ("alias", "kind", "transport", "host", "manager", "uid", "ops_root", "bundle_root", "config_root", "unit", "container", "harness")):
                    raise Failure("rollback inventory differs from the original agent identity")
            if agent["kind"] == "fleet":
                from live_adapter_fleet import plan_fleet, rollback_fleet
                if args.revertir:
                    def reject_preflight_write(_detail):
                        raise Failure("rollback preflight attempted a mutation")
                    detail = rollback_fleet({**agent, "_simulation": True}, original_record, remote, reject_preflight_write)
                else:
                    detail = plan_fleet(agent, ref, remote)
                plan["agents"][agent["alias"]] = {"agent": agent, "state": "planned" if detail.get("ready") else "blocked", "fleet": detail}
            else:
                current = before(agent, allow_reload=args.revertir)
                if args.sonda == str(HERE / "live_adapter_probe.py"):
                    from live_adapter_probe import target
                    target(agent, agent["alias"])
                native = {}
                if agent["kind"] == "native":
                    path = agent["unit_file"] + ".d/zzzzzzzz-adaptador-vivo.conf"
                    content = python(agent, "import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);print(json.dumps(p.read_text() if p.exists() else None))", path)
                    native = {"previous_dropin": json.loads(content), "dropin": path}
                plan["agents"][agent["alias"]] = {"agent": agent, "before": current, "state": "planned", **native}
        except (Failure, OSError, ValueError, KeyError, RuntimeError, TypeError) as error:
            plan["agents"][agent["alias"]] = {"agent": agent, "state": "blocked", "reason": str(error) if isinstance(error, Failure) else "measured inventory is unavailable"}
    if not args.ejecutar:
        shown = {"ref": ref, "release": release, "simulated": True, "writes": False,
                 "agents": {alias: {"strategy": row["agent"]["kind"], "state": row["state"],
                                     "reason": row.get("reason"), "current_release": row.get("before", {}).get("release"),
                                     "fleet": {key: row["fleet"][key] for key in
                                               ("ready", "blockers", "prerequisites", "missing_fields", "preview_required")
                                               if key in row.get("fleet", {})} if "fleet" in row else None}
                            for alias, row in plan["agents"].items()}}
        print(json.dumps(shown, indent=2))
        return 0
    if not args.recibo or not args.sonda or not args.sonda_sha256:
        raise Failure("execution requires --recibo and a reviewed --sonda with --sonda-sha256")
    validate_probe(args)
    if args.sonda == str(HERE / "live_adapter_probe.py"):
        sys.path.insert(0, str(ROOT / "ops/cli"))
        try:
            from context_client import ConsoleSessionClient
            connection = ConsoleSessionClient(args.sesion, args.gateway, args.origin, args.ca_file)
            if connection.request("GET", "/v3/auth/session").get("authenticated") is not True:
                raise Failure("local operator session is not authenticated")
        except (OSError, ValueError, TypeError, RuntimeError, KeyError):
            raise Failure("canonical local operator session preflight failed; no runtime was stopped") from None
    output = args.salida_recibo or (args.recibo + ".rollback.json" if args.revertir else args.recibo)
    save(output, plan, create=True)
    if any(record["state"] == "blocked" for record in plan["agents"].values()):
        print(json.dumps({"status": "blocked", "receipt": output, "runtime_changes": False,
                          "blocked_agents": [alias for alias, record in plan["agents"].items()
                                             if record["state"] == "blocked"]}))
        return 1
    source = None if args.revertir or all(row["agent"]["kind"] == "fleet" or row["state"] == "blocked" for row in plan["agents"].values()) else build(args, ref)
    if source:
        local = {"transport": "local", "ops_root": str(ROOT / "ops")}
        bundle_digest = digest(local, str(source))
        # Content-addressed name: a different bundle of the same ref can never
        # collide with an immutable release already installed on a shared host.
        release = "live-" + ref[:12] + "-" + bundle_digest.removeprefix("sha256:")[:12]
        plan["release"] = release
        plan["bundle_digest"] = bundle_digest
        save(output, plan)
    for alias, record in plan["agents"].items():
        if record["state"] == "blocked":
            continue
        agent = record["agent"]
        def checkpoint(detail, record=record):
            record.update(detail)
            save(output, plan)
        try:
            if agent["kind"] == "fleet":
                from live_adapter_fleet import apply_fleet, rollback_fleet
                outcome = (rollback_fleet(agent, previous["agents"][alias], remote, checkpoint) if args.revertir
                           else apply_fleet(agent, ref, remote, checkpoint))
                record.update(outcome)
                record["state"] = outcome["status"]
                if outcome["status"] == "succeeded":
                    agent["fleet_source_prevalidated"] = True
                    agent["fleet_operation_id"] = outcome["operation_id"]
                    agent["_started_at"] = plan["created_at"]
                    record["verification"] = probe(args, agent, outcome.get("ref", ref))
                    record["state"] = "verified"
            else:
                old = record["before"]
                original = previous["agents"][alias] if args.revertir else record
                target = original["before"]["release"] if args.revertir else release
                target_digest = original["before"]["digest"] if args.revertir else bundle_digest
                old_intact = False
                if args.revertir:
                    observed = (old["release"], old["digest"])
                    prior = (original["before"]["release"], original["before"]["digest"])
                    applied = (previous["release"], previous.get("bundle_digest"))
                    if observed not in (prior, applied):
                        raise Failure("rollback pin belongs to neither the previous nor the applied release")
                    old_intact = observed == prior
                if not args.revertir:
                    install_bundle(agent, source, target, target_digest)
                elif digest(agent, agent["bundle_root"] + "/releases/" + target) != target_digest:
                    raise Failure("rollback bundle differs from the retained release")
                checkpoint({"state": "installed", "target_release": target, "target_digest": target_digest})
                if args.revertir and old_intact:
                    if agent["kind"] == "native":
                        rollback_native(agent, original)
                    checkpoint({"state": "restoring_previous_start", "previous_pin_intact": True})
                    agent["_started_at"] = now()
                    start(agent)
                    record["verification"] = probe(args, agent, target)
                    checkpoint({"state": "verified"})
                    continue
                if before(agent) != old:
                    raise Failure("release or unit changed before stop; no runtime was stopped")
                if agent["kind"] == "native" and not args.revertir:
                    checkpoint(native_intent(agent, old, target))
                checkpoint({"state": "stopping"})
                stop(agent)
                checkpoint({"state": "stopped"})
                if agent["kind"] == "container":
                    checkpoint({"state": "pinning"})
                    pin(agent, old, target, target_digest, revert=args.revertir)
                elif args.revertir:
                    checkpoint({"state": "pinning"})
                    rollback_native(agent, original)
                else:
                    prior = record.get("previous_dropin")
                    expected = hashlib.sha256(prior.encode()).hexdigest() if prior is not None else "absent"
                    checkpoint({"state": "pinning"})
                    native_pin(agent, old, record, expected)
                checkpoint({"state": "pinned"})
                agent["_started_at"] = now()
                checkpoint({"state": "starting"})
                start(agent)
                checkpoint({"state": "started"})
                record["verification"] = probe(args, agent, target)
                record["state"] = "verified"
        except (Failure, OSError, ValueError, KeyError) as error:
            if isinstance(error, CompletionUnknown) or record["state"] == "started" and agent.get("lifecycle") == "supervisor":
                record["completion_unknown"] = True
            record["failure_stage"] = record["state"]
            record["state"] = "failed"
            record["reason"] = str(error) if isinstance(error, Failure) else "update could not be attested; inspect its recorded stage"
        save(output, plan)
    result = {"ref": ref, "receipt": output,
              "agents": {alias: {"state": row["state"], "reason": row.get("reason")} for alias, row in plan["agents"].items()}}
    print(json.dumps(result, indent=2))
    return 0 if all(row["state"] in ("verified", "succeeded") for row in plan["agents"].values()) else 1


def rollback_native(agent, original):
    source = """import hashlib,os,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]); expected=sys.argv[2]; previous=sys.argv[3]
actual=hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else 'absent'
prior=hashlib.sha256(previous.encode()).hexdigest() if previous!='__ABSENT__' else 'absent'
if path.is_symlink() or actual not in (expected,prior): raise RuntimeError('native rollback CAS failed')
if actual==prior: pass
elif previous=='__ABSENT__': path.unlink()
else:
 fd,tmp=tempfile.mkstemp(dir=path.parent)
 with os.fdopen(fd,'w') as stream:
  os.fchmod(stream.fileno(),0o600);stream.write(previous);stream.flush();os.fsync(stream.fileno())
 os.replace(tmp,path)
"""
    python(agent, source, original["dropin"], original.get("dropin_digest", "unwritten"),
           original["previous_dropin"] if original["previous_dropin"] is not None else "__ABSENT__")
    systemctl(agent, "daemon-reload")
    if before(agent)["release"] != original["before"]["release"]:
        raise Failure("native rollback did not restore the previous effective entry")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Failure, OSError, ValueError, KeyError, TypeError, AttributeError, ImportError) as error:
        print(json.dumps({"status": "failed", "reason": str(error) if isinstance(error, Failure) else "operation unavailable; no private command output was copied"}), file=sys.stderr)
        raise SystemExit(1) from None
