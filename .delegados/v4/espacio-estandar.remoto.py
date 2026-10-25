"""Perform bounded space-rollout operations as the existing service manager."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import io
import json
import os
import pathlib
import pwd
import re
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import types

sys.dont_write_bytecode = True
PARTS = ("context", "directives", "projects", "config", "data", "logs", "tmp")


class Failure(RuntimeError):
    pass


def fail(code):
    raise Failure(code)


def hashed(value):
    return hashlib.sha256(value).hexdigest()


def run(argv, *, data=None, timeout=45):
    try:
        result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        fail("SPACE_COMMAND_COMPLETION_UNKNOWN")
    if result.returncode:
        fail("SPACE_REMOTE_COMMAND_FAILED")
    return result.stdout.decode("utf8")


def canonical(value):
    if not isinstance(value, str) or not re.fullmatch(r"/[A-Za-z0-9._/-]+", value) \
            or os.path.normpath(value) != value or "//" in value or value == "/":
        fail("SPACE_PATH_INVALID")
    return pathlib.Path(value)


def real_directory(value, *, optional=False):
    path = canonical(str(value))
    current = pathlib.Path("/")
    for part in path.parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if optional and current == path:
                return path
            fail("SPACE_REQUIRED_DIRECTORY_MISSING")
        if not stat.S_ISDIR(info.st_mode) or current.is_symlink():
            fail("SPACE_DIRECTORY_LINK_OR_TYPE_INVALID")
    return path


PROCESS_SOURCE = r'''
import hashlib,json,os,pathlib,stat,sys
a=json.loads(sys.argv[1]); rows=[]
def ident(p):
 try: s=p.lstat()
 except FileNotFoundError: return {'present':False}
 r={'present':True,'device':s.st_dev,'inode':s.st_ino,'uid':s.st_uid,'mode':format(stat.S_IMODE(s.st_mode),'04o'),'directory':stat.S_ISDIR(s.st_mode),'symlink':stat.S_ISLNK(s.st_mode)}
 if r['symlink']: r.update(target=os.readlink(p),resolved=str(p.resolve()))
 return r
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try:
  e=dict(item.split(b'=',1) for item in (p/'environ').read_bytes().split(b'\0') if b'=' in item)
  if e.get(b'CAUCE_ALIAS')!=a['alias'].encode() or e.get(b'CAUCE_STATE_DIR')!=a['state_directory'].encode(): continue
  raw=(p/'cmdline').read_bytes(); args=[v.decode() for v in raw.split(b'\0') if v]
  entries=[v for v in args if v.endswith('/packages/adapter-sdk/dist/src/bin/'+a['harness']+'.js')]
  if len(entries)!=1 or (p/'exe').resolve().name!='node' or p.stat().st_uid!=a['runtime_uid']: continue
  entry=pathlib.Path(entries[0])
  if not entry.is_absolute() or entry.resolve()!=entry or not entry.is_file(): raise ValueError()
  cwd=(p/'cwd').resolve(); state=pathlib.Path(a['state_directory']); root=state/'space'
  if state.resolve()!=state or not state.is_dir() or state.stat().st_uid!=a['runtime_uid'] or stat.S_IMODE(state.stat().st_mode)!=0o700: raise ValueError()
  layout={name:ident(root/name) for name in ('','context','directives','projects','config','data','logs','tmp')}
  keep={str(cwd):ident(cwd),str(state):ident(state)}
  for f in cwd.iterdir():
   if f.is_symlink(): keep[str(f)]=ident(f)
  if len(keep)>256: raise ValueError()
  for name in a.get('preserve_paths',[]): keep[name]=ident(pathlib.Path(name))
  fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
  if fields[0]=='Z': continue
  expected=a.get('expected_instance_id')
  rows.append({'pid':int(p.name),'ticks':fields[19],'uid':p.stat().st_uid,'cwd':str(cwd),'entry':str(entry),'release':entry.parents[5].name,
   'argv_sha256':hashlib.sha256(raw).hexdigest(),'environment_names':sorted(k.decode() for k in e),
   'state_matches':True,'root_matches':e.get(b'CAUCE_SPACE_ROOT')==str(root).encode(),'tmp_matches':e.get(b'TMPDIR')==str(root/'tmp').encode(),
   'instance_matches':expected is None or e.get(b'CAUCE_INSTANCE_ID')==expected.encode(),'layout':layout,'preserved':keep})
  if a.get('_mapping_home') is not None: rows[-1]['mapping_home_matches']=e.get(b'HOME')==a['_mapping_home'].encode()
  if a.get('_include_instance'): rows[-1]['_instance_id']=e.get(b'CAUCE_INSTANCE_ID',b'').decode()
 except (OSError,ValueError,UnicodeError,IndexError): continue
if len(rows)!=1: raise SystemExit(78)
print(json.dumps(rows[0],sort_keys=True,separators=(',',':')))
'''


def properties(agent):
    names = ("Id", "LoadState", "ActiveState", "SubState", "MainPID", "FragmentPath", "DropInPaths",
             "WorkingDirectory", "KillMode", "NeedDaemonReload", "ExecStart", "ExecStop", "ExecStopPost", "Environment")
    output = run(["systemctl", "--user", "show", agent["unit"], "--no-pager", "--property=" + ",".join(names)])
    values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if values.get("LoadState") != "loaded" or values.get("Id") != agent["unit"]:
        fail("SPACE_UNIT_NOT_LOADED")
    return values


def dropin_path(agent, operation):
    home = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir)
    return home / ".config/systemd/user" / (agent["unit"] + ".d") / ("zzzzzzzz-space-standard-" + operation + ".conf")


def managed_permissions(info):
    if info.st_mode & 0o002:
        return False
    return not info.st_mode & 0o020 or (
        info.st_uid == os.geteuid() and info.st_gid == pwd.getpwuid(os.geteuid()).pw_gid)


def unit_revision(agent, values, own):
    paths = {canonical(values["FragmentPath"])}
    paths.update(canonical(item) for item in values.get("DropInPaths", "").split())
    directory = own.parent
    if directory.exists():
        real_directory(directory)
        paths.update(directory.glob("*.conf"))
    payload = []
    for path in sorted(paths):
        if path == own:
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2_097_152 or not managed_permissions(info) \
                or info.st_uid not in {0, os.geteuid()}:
            fail("SPACE_UNIT_SOURCE_UNSAFE")
        payload.extend((str(path).encode(), path.read_bytes()))
    return hashed(b"\0".join(payload))


def original_start(agent):
    text = run(["systemctl", "--user", "cat", agent["unit"], "--no-pager"])
    section = ""
    entries = []
    pending = ""
    for line in text.splitlines(keepends=True):
        if pending:
            pending += line
        else:
            pending = line
        tail = pending.rstrip("\r\n")
        slashes = len(tail) - len(tail.rstrip("\\"))
        if slashes % 2:
            continue
        logical, pending = pending.rstrip("\r\n"), ""
        if logical.lstrip().startswith(("#", ";")) or not logical.strip():
            continue
        if logical.startswith("["):
            section = logical.strip()
        elif section == "[Service]" and logical.startswith("ExecStart="):
            value = logical[len("ExecStart="):].strip()
            if value:
                entries.append(value)
            else:
                entries = []
    if pending or len(entries) != 1 or not entries[0].startswith("/") or "\x00" in entries[0]:
        fail("SPACE_ORIGINAL_EXECSTART_UNREPRESENTABLE")
    return entries[0]


def process_snapshot(agent, values, include_instance=False, mapping=None):
    arguments = ["python3", "-I", "-B", "-c", PROCESS_SOURCE,
                 json.dumps({**agent, "_include_instance": include_instance, "_mapping_home": mapping.get("home") if mapping else None})]
    if agent["kind"] == "container":
        arguments = ["docker", "exec", "--user", agent["runtime_user"], agent["container"], *arguments]
    snapshot = json.loads(run(arguments))
    if agent["kind"] == "native" and int(values.get("MainPID", "0")) != snapshot["pid"]:
        fail("SPACE_NATIVE_MAINPID_IS_NOT_ADAPTER")
    if agent.get("adapter_entry") and snapshot["entry"] != agent["adapter_entry"]:
        fail("SPACE_ADAPTER_ENTRY_DIFFERS")
    return snapshot


def inspect(agent, packet):
    own = dropin_path(agent, packet["operation"])
    values = properties(agent)
    present = os.path.lexists(own)
    if present:
        info = own.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            fail("SPACE_OWN_DROPIN_UNSAFE")
    mapping = packet.get("expected_mapping")
    if agent["kind"] == "container" and mapping is None and packet.get("ops_target"):
        path = pathlib.Path(packet["ops_target"]) / "container-aliases.json"
        if path.is_file() and not path.is_symlink():
            mapping = json.loads(path.read_text())["aliases"][agent["alias"]]
    result = {"unit": {key: values.get(key) for key in ("Id", "ActiveState", "SubState", "WorkingDirectory", "KillMode", "NeedDaemonReload")},
              "unit_revision": unit_revision(agent, values, own), "dropin_path": str(own),
              "dropin_present": present, "dropin_sha256": hashed(own.read_bytes()) if present else None,
              "process": process_snapshot(agent, values, packet.get("include_instance", False), mapping)}
    if result["process"].get("instance_matches") is not True:
        fail("SPACE_INSTANCE_DIFFERS")
    if mapping is not None and result["process"].get("mapping_home_matches") is not True:
        fail("SPACE_APPROVED_CONTAINER_HOME_DIFFERS")
    return result


def quote(value):
    if any(char in value for char in ("\n", "\r", "\x00", "%", "$", "\\", '"')):
        fail("SPACE_GENERATED_ARGUMENT_UNSAFE")
    return '"' + value + '"'


def intended_dropin(agent, packet):
    ops = canonical(packet["ops_target"])
    lines = ["[Service]", "ExecStart="]
    if agent["kind"] == "container":
        executable = quote(str(ops / "scripts/container-adapter-supervisor.sh"))
        lines.extend((f"ExecStart={executable} start {agent['alias']}", "ExecStop=",
                      f"ExecStop={executable} stop {agent['alias']}",
                      "Environment=" + quote("CAUCE_CONTAINER_OPS_ROOT=" + str(ops))))
    else:
        module = canonical(packet["sdk_target"]) / "packages/adapter-sdk/dist/src/context/space-layout.js"
        command = " ".join(quote(value) for value in (str(ops / "scripts/adapter-space-launcher.sh"), agent["node_executable"], str(module)))
        lines.append("ExecStart=" + command + " -- " + original_start(agent))
    return ("\n".join(lines) + "\n").encode()


def assert_base(agent, packet):
    values = properties(agent)
    own = dropin_path(agent, packet["operation"])
    if unit_revision(agent, values, own) != packet["before_revision"]:
        fail("SPACE_ORIGINAL_UNIT_CHANGED")
    return values, own


def plan(agent, packet):
    observed = inspect(agent, packet)
    if observed["unit"]["ActiveState"] != "active" or observed["unit"]["NeedDaemonReload"] != "no":
        fail("SPACE_UNIT_NOT_READY")
    if observed["dropin_present"]:
        fail("SPACE_OWN_DROPIN_ALREADY_EXISTS")
    own = pathlib.Path(observed["dropin_path"])
    others = properties(agent).get("DropInPaths", "").split()
    if any(pathlib.Path(path).name.startswith("zzzzzzzz-space-standard-") for path in others):
        fail("SPACE_PREVIOUS_OPERATION_REQUIRES_ITS_RECEIPT")
    if any(pathlib.Path(path).name >= own.name for path in others):
        fail("SPACE_LATER_DROPIN_REQUIRES_REVIEW")
    for entry in observed["process"]["layout"].values():
        if entry["present"] and (not entry["directory"] or entry["symlink"] or entry["mode"] != "0700" or entry["uid"] != agent["runtime_uid"]):
            fail("SPACE_EXISTING_LAYOUT_UNSAFE")
    if agent["kind"] == "native":
        if properties(agent).get("ExecStop") or properties(agent).get("ExecStopPost"):
            fail("SPACE_NATIVE_STOP_HOOKS_REQUIRE_REVIEW")
    body = intended_dropin(agent, packet)
    observed["planned_dropin_sha256"] = hashed(body)
    root = real_directory(agent["release_root"], optional=True)
    parent = root if root.exists() else root.parent
    details = parent.stat()
    if details.st_uid != os.geteuid() or details.st_mode & 0o022:
        fail("SPACE_RELEASE_PARENT_UNSAFE")
    return observed


def digest_function(packet):
    module = types.ModuleType("space_canonical_digest")
    exec(compile(packet["canonical_digest_source"], "cauce_container_base.py", "exec"), module.__dict__)
    return module.bundle_digest


def verify_artifact(root, expected, digest):
    real_directory(root)
    for path in [root, *root.rglob("*")]:
        info = path.lstat()
        if info.st_uid != os.geteuid() or not path.is_symlink() and info.st_mode & 0o222:
            fail("SPACE_ARTIFACT_NOT_IMMUTABLE")
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            fail("SPACE_ARTIFACT_LINK_ESCAPES")
    if digest(str(root)) != expected:
        fail("SPACE_ARTIFACT_DIGEST_DIFFERS")


def install(agent, packet):
    assert_base(agent, packet)
    root = real_directory(agent["release_root"], optional=True)
    if not root.exists():
        root.mkdir(mode=0o700)
    if root.stat().st_uid != os.geteuid() or stat.S_IMODE(root.stat().st_mode) != 0o700:
        fail("SPACE_RELEASE_ROOT_NOT_PRIVATE")
    digest = digest_function(packet)
    installed = []
    for item in packet["artifacts"]:
        target = canonical(item["target"])
        if target.parent != root or target.name not in {"ops-" + item["digest"][7:], "sdk-" + item["digest"][7:]}:
            fail("SPACE_ARTIFACT_TARGET_INVALID")
        if target.exists():
            verify_artifact(target, item["digest"], digest)
            installed.append({"target": str(target), "created": False, "digest": item["digest"]})
            continue
        temporary = root / (".space-staging-" + packet["operation"] + "-" + target.name[:3])
        temporary.mkdir(mode=0o700)
        archive = base64.b64decode(item["archive"], validate=True)
        if len(archive) > 134_217_728:
            fail("SPACE_ARTIFACT_TOO_LARGE")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
            members = bundle.getmembers()
            if sum(member.size for member in members) > 268_435_456:
                fail("SPACE_ARTIFACT_TOO_LARGE")
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir() or member.issym()):
                    fail("SPACE_ARTIFACT_MEMBER_UNSAFE")
            bundle.extractall(temporary, filter="data")
            for member in sorted(members, key=lambda entry: entry.name.count("/"), reverse=True):
                path = temporary / member.name
                if not path.is_symlink():
                    path.chmod(member.mode)
        temporary.chmod(0o555)
        verify_artifact(temporary, item["digest"], digest)
        os.rename(temporary, target)
        installed.append({"target": str(target), "created": True, "digest": item["digest"]})
    return {"installed": installed}


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_dropin(agent, packet):
    values, own = assert_base(agent, packet)
    if values.get("NeedDaemonReload") != "no":
        fail("SPACE_RELOAD_ALREADY_PENDING")
    body = intended_dropin(agent, packet)
    if hashed(body) != packet["dropin_sha256"]:
        fail("SPACE_DROPIN_INTENT_CHANGED")
    real_directory(own.parent.parent)
    if not own.parent.exists():
        own.parent.mkdir(mode=0o700)
    real_directory(own.parent)
    if own.parent.stat().st_uid != os.geteuid() or not managed_permissions(own.parent.stat()):
        fail("SPACE_DROPIN_PARENT_UNSAFE")
    descriptor, staging = tempfile.mkstemp(prefix=".space-dropin-" + packet["operation"] + "-", dir=own.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            if stream.write(body) != len(body):
                fail("SPACE_DROPIN_WRITE_INCOMPLETE")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staging, own, follow_symlinks=False)
    finally:
        os.unlink(staging)
    sync_directory(own.parent)
    return {"path": str(own), "sha256": hashed(body)}


def assert_dropin(agent, packet):
    values, own = assert_base(agent, packet)
    info = own.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 \
            or info.st_nlink != 1 or hashed(own.read_bytes()) != packet["dropin_sha256"]:
        fail("SPACE_DROPIN_CAS_FAILED")
    return values, own


def activate(agent, packet):
    _, own = assert_dropin(agent, packet)
    run(["systemctl", "--user", "daemon-reload"])
    values = properties(agent)
    executable = packet["ops_target"] + "/scripts/" + ("container-adapter-supervisor.sh" if agent["kind"] == "container" else "adapter-space-launcher.sh")
    if executable not in values.get("ExecStart", "") or str(own) not in values.get("DropInPaths", "").split():
        fail("SPACE_DROPIN_NOT_EFFECTIVE")
    if agent["kind"] == "container":
        environment = dict(item.split("=", 1) for item in shlex.split(values.get("Environment", "")) if "=" in item)
        if executable not in values.get("ExecStop", "") or environment.get("CAUCE_CONTAINER_OPS_ROOT") != packet["ops_target"]:
            fail("SPACE_CONTAINER_ENTRY_NOT_EFFECTIVE")
    run(["systemctl", "--user", "restart", agent["unit"]], timeout=180)
    return {"restart_returned": True}


def revert(agent, packet):
    _, own = assert_base(agent, packet)
    if os.path.lexists(own):
        assert_dropin(agent, packet)
        own.unlink()
        sync_directory(own.parent)
    run(["systemctl", "--user", "daemon-reload"])
    values = properties(agent)
    if str(own) in values.get("DropInPaths", "").split():
        fail("SPACE_DROPIN_STILL_EFFECTIVE")
    run(["systemctl", "--user", "restart", agent["unit"]], timeout=180)
    return {"restarted_original": True, "space_preserved": True, "releases_preserved": True}


def main():
    packet = json.load(sys.stdin)
    agent = packet["agent"]
    if os.geteuid() != agent["uid"] or pwd.getpwuid(os.geteuid()).pw_name != agent["manager"]:
        fail("SPACE_REMOTE_MANAGER_DIFFERS")
    os.environ["HOME"] = pwd.getpwuid(os.geteuid()).pw_dir
    if not re.fullmatch(r"[a-f0-9]{32}", packet["operation"]):
        fail("SPACE_OPERATION_INVALID")
    actions = {"inspect": inspect, "plan": plan, "install": install, "dropin": write_dropin,
               "activate": activate, "revert": revert}
    if packet["action"] not in actions:
        fail("SPACE_ACTION_INVALID")
    descriptor = None
    try:
        if packet["action"] not in {"inspect", "plan"}:
            assert_base(agent, packet)
            root = real_directory(agent["release_root"], optional=True)
            if not root.exists():
                parent = root.parent.stat()
                if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
                    fail("SPACE_RELEASE_PARENT_UNSAFE")
                root.mkdir(mode=0o700)
            info = root.stat()
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                fail("SPACE_RELEASE_ROOT_NOT_PRIVATE")
            descriptor = os.open(root / (".space-" + agent["alias"] + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock_info = os.fstat(descriptor)
            if lock_info.st_uid != os.geteuid() or stat.S_IMODE(lock_info.st_mode) != 0o600 or lock_info.st_nlink != 1:
                fail("SPACE_LOCK_UNSAFE")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail("SPACE_OPERATION_ALREADY_RUNNING")
        return actions[packet["action"]](agent, packet)
    finally:
        if descriptor is not None:
            os.close(descriptor)


try:
    print(json.dumps({"ok": True, "value": main()}, sort_keys=True, separators=(",", ":")))
except Exception as error:
    code = str(error) if isinstance(error, Failure) else "SPACE_REMOTE_VALIDATION_FAILED"
    print(json.dumps({"ok": False, "code": code}, sort_keys=True))
