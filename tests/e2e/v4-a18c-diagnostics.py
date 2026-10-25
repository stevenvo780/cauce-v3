from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import re
import subprocess
import sys

OBSERVATION = r'''import hashlib,json,os,pathlib,re,stat,sys
from cauce_container_base import open_control_directory,PermanentError
from cauce_container_proc import matched_fs_credentials,read_metadata,verify_adapter,verify_controller
from cauce_container_restart import assert_restart_safe,process_environment
expected=json.loads(sys.argv[1]); result={"diagnostic_only":True}; phase="metadata"; control=None
try:
 control=open_control_directory(expected["controlDirectory"])
 document,raw=read_metadata(control)
 assert document is not None and all(document.get(key)==value for key,value in expected.items())
 result["metadata"]={key:document.get(key) for key in ("phase","pid","starttime","controllerPid","controllerStarttime","stopAuthority")}
 result["metadata_sha256"]=hashlib.sha256(raw).hexdigest()
 phase="process_identity"; verify_adapter(document,document["alias"],document["stateDirectory"]); verify_controller(document)
 phase="flags"
 with matched_fs_credentials(document["runtimeUid"],document["runtimeGid"]):
  environment=(pathlib.Path("/proc")/str(document["pid"])/"environ").read_bytes()
 flags={}
 for item in environment.split(b"\0"):
  name,separator,value=item.partition(b"=")
  if separator and name in (b"CAUCE_BOOTSTRAP",b"CAUCE_SHARED_SESSION"):
   assert name.decode() not in flags and value in (b"0",b"1")
   flags[name.decode()]=value.decode()
 result["flags"]=flags
 phase="socket"; narrow=process_environment(document["pid"],document["runtimeUid"],document["runtimeGid"])
 socket=pathlib.Path(narrow.get("TMUX_TMPDIR","/tmp"))/('tmux-'+str(document["runtimeUid"]))/"cauce"
 try:
  details=socket.lstat(); result["socket"]={"exists":True,"is_socket":stat.S_ISSOCK(details.st_mode),"uid":details.st_uid}
 except FileNotFoundError:
  result["socket"]={"exists":False}
 phase="canonical_read_predicate"
 try:
  assert_restart_safe(document); result["read_predicate"]={"result":"PASS"}
 except PermanentError as error:
  code=str(error)
  result["read_predicate"]={"result":"HOLD","code":code} if re.fullmatch(r"RESTART_(?:HOLD|PARTIAL)_[A-Z0-9_]+",code) else {"result":"ERROR","error_class":type(error).__name__}
 phase="stability"; verify_adapter(document,document["alias"],document["stateDirectory"]); verify_controller(document)
 result["snapshot_stable"]=read_metadata(control)==(document,raw)
except Exception as error:
 result["observation_error"]={"phase":phase,"error_class":type(error).__name__}
finally:
 if control is not None: os.close(control)
print(json.dumps(result))
'''


def observe() -> dict:
    root, release_id, key, alias, tenant, container_id = sys.argv[1:]
    assert re.fullmatch(r"[a-f0-9]{64}", release_id)
    release = pathlib.Path(root) / "release" / release_id
    assert (release / ".verified").read_text().strip() == release_id
    sys.path.insert(0, str(release / "ops/cli"))
    import fleet_executor_lifecycle as lifecycle

    assert pathlib.Path(lifecycle.__file__).resolve() == release / "ops/cli/fleet_executor_lifecycle.py"
    _, raw = lifecycle.current_program(observe=True)
    packet = json.loads(raw)
    hashes = {name + ".py": hashlib.sha256(base64.b64decode(value, validate=True)).hexdigest()
              for name, value in packet["modules"].items()}
    for name in ("ops/cli/fleet_executor_lifecycle.py", "ops/container-runtime/cauce-container-runtime.py"):
        hashes[name] = hashlib.sha256((release / name).read_bytes()).hexdigest()
    policy = json.loads((pathlib.Path(root) / "executor-policy.json").read_text())
    inspected = subprocess.run(["/usr/bin/docker", "inspect", container_id], capture_output=True, timeout=10, check=True)
    container, = json.loads(inspected.stdout)
    labels = container["Config"]["Labels"]
    assert container["Id"] == container_id and container["State"]["Running"]
    assert labels["cauce.fleet.runtime_key"] == key and labels["cauce.fleet.alias"] == alias \
        and labels["cauce.fleet.tenant"] == tenant and labels["cauce.fleet.host"] == policy["host_id"]
    placement, = [row for row in policy["container_templates"] if row["harness_id"] == "codex"
                   and container["Name"] == "/" + row["prefix"] + key]
    expected = {"alias": key, "wireAlias": alias, "tenantId": tenant, "containerId": container_id,
                "stateDirectory": str(pathlib.Path(placement["state_root"]) / key),
                "controlDirectory": str(pathlib.Path(placement.get("control_root", "/run/cauce-fleet")) / key),
                "containerGeneration": hashlib.sha256((container_id + "\0" + container["State"]["StartedAt"]).encode()).hexdigest()}
    packet["entry"] = base64.b64encode(OBSERVATION.encode()).decode()
    raw = json.dumps(packet, separators=(",", ":")).encode()
    command = ["/usr/bin/docker", "exec", "-i", "-w", "/", "--user", "0", container_id, placement["python"],
               "-I", "-B", "-c", lifecycle.BOOTSTRAP, hashlib.sha256(raw).hexdigest(), json.dumps(expected)]
    result = subprocess.run(command, input=raw, capture_output=True, timeout=30, check=False)
    assert result.returncode == 0 and len(result.stdout) < 32768
    return {"diagnostic_only": True, "functional_stop_repeated": False, "release": release_id,
            "installed_source_sha256": hashes, "observation_entry_sha256": hashlib.sha256(OBSERVATION.encode()).hexdigest(),
            "observation": json.loads(result.stdout)}


try:
    print(json.dumps(observe()))
except Exception as failure:
    print(json.dumps({"diagnostic_only": True, "observation_error_class": type(failure).__name__}))
