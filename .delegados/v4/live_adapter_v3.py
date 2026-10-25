"""V3-only planning and explicit, reversible native stop preparation."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib
import io
import json
import os
import pathlib
import re
import shlex
import sys
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
core = importlib.import_module("live_adapter")

PROOF = HERE / "recibos/t3b-adaptadores-v3-astra-1025/systemd/lab-proof.json"
CONTENT = "[Service]\nKillMode=process\n"
BASE_BEFORE = core.before
BASE_NORMALIZE = core.normalize
BASE_PROBE = core.probe
BASE_STOP = core.stop


def latest_ref():
    entries = re.findall(r"^\| \d{8}T\d{6}Z \| ([a-f0-9]{8,40}) \|", (core.ROOT / "deploy/HISTORIAL.md").read_text(), re.MULTILINE)
    if not entries:
        raise core.Failure("no deployed release is recorded; pass --ref explicitly")
    return entries[-1]


def laboratory_proof(path):
    value = core.private_json(path)
    expected = {"result": "PASS", "kill_mode": "process", "harness": "codex", "same_pane": True,
                "same_conversation": True, "adapter_restarted": True, "adopted": True}
    if any(value.get(key) != item for key, item in expected.items()):
        raise core.Failure("native safe-stop laboratory proof is incomplete")
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def normalize(inventory):
    return [agent for agent in BASE_NORMALIZE(inventory) if agent["kind"] != "fleet"]


def astra(agent):
    return agent["alias"] == "astra" and agent["kind"] == "native" and agent["harness"] == "codex"


def measure_control_group(agent):
    actual = core.systemctl(agent, "show", agent["unit"], "-p", "ExecStart", "--value").strip()
    match = re.search(r"(/[^ ;]+/releases/([^ /;]+)/packages/adapter-sdk/dist/src/bin/codex\.js)", actual)
    argv_match = re.search(r"argv\[\]=(.*?)(?: ;|\s*;)", actual)
    if not match or not argv_match:
        raise core.Failure("native entry and argv cannot be preserved")
    argv = shlex.split(argv_match[1])
    if argv[-1] != match[1] or any("%" in item or "\n" in item for item in argv) or not (
            len(argv) == 2 or len(argv) == 4 and argv[:2] == ["/usr/bin/env", "CAUCE_INSTANCE_ID=systemd-" + agent["alias"]]):
        raise core.Failure("native argv is outside the measured direct launcher")
    guards = core.systemctl(agent, "show", agent["unit"], "-p", "ExecStop", "-p", "ExecStopPost",
                            "-p", "NeedDaemonReload", "-p", "FragmentPath", "-p", "DropInPaths")
    fields = dict(line.split("=", 1) for line in guards.splitlines() if "=" in line)
    if fields.get("ExecStop") or fields.get("ExecStopPost") or fields.get("NeedDaemonReload") != "no":
        raise core.Failure("native stop hooks or pending unit reload need separate review")
    mode = core.systemctl(agent, "show", agent["unit"], "-p", "KillMode", "--value").strip()
    if mode != "control-group":
        raise core.Failure("native stop mode changed during inventory")
    return {"release": match[2], "digest": core.digest(agent, agent["bundle_root"] + "/releases/" + match[2]),
            "argv": argv, "entry": match[1], "kill_mode": mode,
            "unit_revision": hashlib.sha256(guards.encode()).hexdigest()}


SNAPSHOT = r'''
import hashlib,json,os,pathlib,re,subprocess,sys
unit,alias=sys.argv[1:]
def command(*args):
 return subprocess.run(args,check=True,capture_output=True,text=True,timeout=20).stdout.strip()
pid=int(command('systemctl','--user','show',unit,'-p','MainPID','--value'))
if pid<=0: raise ValueError('adapter is not active')
env=dict(item.split(b'=',1) for item in pathlib.Path('/proc',str(pid),'environ').read_bytes().split(b'\0') if b'=' in item)
if b'TMUX_TMPDIR' in env: os.environ['TMUX_TMPDIR']=os.fsdecode(env[b'TMUX_TMPDIR'])
state=pathlib.Path(os.fsdecode(env[b'CAUCE_STATE_DIR']))
rows=command('tmux','-L','cauce','list-panes','-s','-t','=cauce-'+alias,'-F','#{session_id}|#{window_id}|#{window_name}|#{pane_id}|#{pane_pid}').splitlines()
rows=[row for row in rows if row.split('|')[2]=='agente']
if len(rows)!=1: raise ValueError('sole canonical TUI pane required')
parts=rows[0].split('|'); pane_pid=int(parts[-1])
start=pathlib.Path('/proc',str(pane_pid),'stat').read_text().split(') ',1)[1].split()[19]
sessions=state/'sessions.json'
value=json.loads(sessions.read_text())
if value.get('version')!=1: raise ValueError('invalid session store')
pointer=value.get('sessions',{}).get('codex:'+alias+':shared:'+alias,{})
native=pointer.get('native_id')
if pointer.get('initialized') is not True or not isinstance(native,str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',native): raise ValueError('canonical Codex conversation witness required')
identity={'pane':parts[:2]+parts[3:],'pane_start':start,
 'conversation_sha256':hashlib.sha256(native.encode()).hexdigest()}
print(json.dumps({'adapter_pid':pid,'identity':identity}))
'''


def snapshot(agent):
    try:
        return {**json.loads(core.python(agent, SNAPSHOT, agent["unit"], agent["alias"])), "tui": "present"}
    except core.CompletionUnknown:
        raise
    except core.Failure:
        source = (HERE / "live_adapter_v3_snapshot.py").read_text(encoding="utf8")
        flags = ["--privileged-proc-read"] if agent.get("privileged_proc_read") is True else []
        observed = json.loads(core.python(agent, source, agent["unit"], agent["alias"],
                                         str(agent.get("adapter_uid", agent["uid"])), agent.get("state_directory", ""), *flags))
        if observed.get("tui") != "absent" or observed.get("identity") is not None:
            raise core.Failure("native TUI changed during absence measurement; repeat the observation") from None
        return observed


def same_tui(first, second):
    if first.get("tui") == "absent" and second.get("tui") == "absent":
        return first.get("absence") == second.get("absence")
    return first.get("tui", "present") == second.get("tui", "present") and first["identity"] == second["identity"]


def safety_path(agent):
    return agent["unit_file"] + ".d/zzzzzzzzz-adaptador-parada.conf"


WRITE = r'''
import fcntl,hashlib,json,os,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]);expected,content,backup=sys.argv[2:]
if path.is_symlink() or path.parent.is_symlink(): raise ValueError('symlink refused')
path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
lock=os.open(str(path)+'.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(lock,fcntl.LOCK_EX)
current=path.read_text() if path.exists() else None
digest=hashlib.sha256(current.encode()).hexdigest() if current is not None else 'absent'
if digest!=expected: raise ValueError('safety drop-in CAS failed')
if content=='__RESTORE_ABSENT__':
 if path.exists(): path.unlink()
else:
 if backup:
  with open(backup,'x',opener=lambda p,f:os.open(p,f,0o600)) as stream:
   stream.write(current or '');stream.flush();os.fsync(stream.fileno())
 fd,tmp=tempfile.mkstemp(dir=path.parent)
 with os.fdopen(fd,'w') as stream:
  os.fchmod(stream.fileno(),0o600);stream.write(content);stream.flush();os.fsync(stream.fileno())
 os.replace(tmp,path)
directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
print(json.dumps({'written':True}))
'''


def read_safety(agent):
    source = "import json,pathlib,sys\np=pathlib.Path(sys.argv[1])\n" \
             "if p.is_symlink(): raise ValueError('safety symlink refused')\n" \
             "print(json.dumps(p.read_text() if p.exists() else None))"
    return json.loads(core.python(agent, source, safety_path(agent)))


def prepare(agent, options):
    proof = laboratory_proof(options.prueba_laboratorio)
    current = measure_control_group(agent)
    previous = read_safety(agent)
    if previous is not None:
        raise core.Failure("safety drop-in already exists; use its original receipt instead of preparing twice")
    path = safety_path(agent)
    plan = {"version": 1, "action": "prepare-native-stop", "agent": agent, "before": current,
            "laboratory_proof_sha256": proof, "dropin": path, "previous": previous,
            "backup": path + "." + uuid.uuid4().hex + ".before", "content": CONTENT,
            "created_at": core.now(), "state": "planned"}
    if not options.execute:
        print(json.dumps({**plan, "writes": False}, indent=2))
        return 0
    if not options.parada_recibo:
        raise core.Failure("native preparation requires --parada-recibo")
    plan["tui_before"] = snapshot(agent)
    plan["tui"] = "ausente" if plan["tui_before"]["tui"] == "absent" else "presente"
    core.save(options.parada_recibo, plan, create=True)
    if measure_control_group(agent) != current or snapshot(agent) != plan["tui_before"]:
        raise core.Failure("native identity changed before preparing stop")
    plan["state"] = "writing"
    core.save(options.parada_recibo, plan)
    expected = hashlib.sha256(previous.encode()).hexdigest() if previous is not None else "absent"
    try:
        core.python(agent, WRITE, path, expected, CONTENT, plan["backup"])
        core.systemctl(agent, "daemon-reload")
    except core.CompletionUnknown:
        plan["completion_unknown"] = True
        core.save(options.parada_recibo, plan)
        raise
    after = BASE_BEFORE(agent)
    if any(after[key] != current[key] for key in ("release", "digest", "argv", "entry")) or snapshot(agent) != plan["tui_before"]:
        raise core.Failure("native identity changed while preparing stop; retain receipt")
    plan["state"] = "prepared"
    core.save(options.parada_recibo, plan)
    print(json.dumps({"state": "prepared", "adapter_restarted": False, "receipt": options.parada_recibo}))
    return 0


def validate_receipt(agent, path):
    if not path:
        raise core.Failure("Astra execution requires --parada-recibo from the explicit preparation step")
    value = core.private_json(path)
    info = pathlib.Path(path).lstat()
    if info.st_mode & 0o077 or info.st_uid != os.geteuid() or info.st_nlink != 1:
        raise core.Failure("native safety receipt must be private and caller-owned")
    keys = ("alias", "host", "manager", "uid", "unit", "unit_file", "bundle_root", "harness")
    if value.get("version") != 1 or value.get("action") != "prepare-native-stop" or any(
            value.get("agent", {}).get(key) != agent.get(key) for key in keys) or value.get("dropin") != safety_path(agent):
        raise core.Failure("native safety receipt identity differs")
    if value.get("content") != CONTENT or value.get("previous") not in (None, CONTENT):
        raise core.Failure("native safety receipt content differs")
    return value


def revert_safety(agent, options):
    value = validate_receipt(agent, options.parada_recibo)
    if value.get("completion_unknown") or value.get("state") in ("writing", "restoring"):
        raise core.Failure("native safety mutation has unknown completion; prove canonical settlement before restoration")
    if value.get("state") not in ("prepared", "restored"):
        raise core.Failure("native safety step has no restorable state")
    if value["state"] == "restored":
        if read_safety(agent) != value["previous"]:
            raise core.Failure("restored native policy has changed")
        mode = core.systemctl(agent, "show", agent["unit"], "-p", "KillMode", "--value").strip()
        if mode != value["before"]["kill_mode"]:
            raise core.Failure("restored native stop mode differs")
        print(json.dumps({"state": "restored", "writes": False}))
        return 0
    current = BASE_BEFORE(agent)
    if current["release"] != value["before"]["release"] or current["digest"] != value["before"]["digest"]:
        raise core.Failure("restore adapter release with its update receipt before restoring stop policy")
    if not options.execute:
        print(json.dumps({"action": "restore-native-stop", "writes": False, "dropin": value["dropin"]}))
        return 0
    baseline = snapshot(agent)
    previous = value["previous"]
    value["state"] = "restoring"
    core.save(options.parada_recibo, value)
    try:
        core.python(agent, WRITE, value["dropin"], hashlib.sha256(CONTENT.encode()).hexdigest(),
                    previous if previous is not None else "__RESTORE_ABSENT__", "")
        core.systemctl(agent, "daemon-reload")
    except core.CompletionUnknown:
        value["completion_unknown"] = True
        core.save(options.parada_recibo, value)
        raise
    mode = core.systemctl(agent, "show", agent["unit"], "-p", "KillMode", "--value").strip()
    if mode != value["before"]["kill_mode"] or snapshot(agent) != baseline:
        raise core.Failure("stop-policy restoration remains unverified; retain receipt")
    value["state"] = "restored"
    core.save(options.parada_recibo, value)
    print(json.dumps({"state": "restored", "adapter_restarted": False}))
    return 0


def main():
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preparar-parada-astra", action="store_true")
    mode.add_argument("--revertir-parada-astra", action="store_true")
    parser.add_argument("--parada-recibo")
    parser.add_argument("--prueba-laboratorio", default=str(PROOF))
    parser.add_argument("--lectura-proc-privilegiada", action="store_true")
    options, remaining = parser.parse_known_args()
    options.execute = "--ejecutar" in remaining
    sys.argv = [sys.argv[0], *remaining]
    if "--help" in remaining:
        print("V3: omite agentes V4. Sin --ref usa deploy/HISTORIAL.md. Astra: --preparar-parada-astra / "
              "--revertir-parada-astra, --parada-recibo y --prueba-laboratorio; las escrituras requieren --ejecutar. "
              "--lectura-proc-privilegiada permite sudo -n solo para readlink /proc/PID/exe.")
    if not any(arg == "--ref" or arg.startswith("--ref=") for arg in remaining) and "--revertir" not in remaining:
        sys.argv += ["--ref", latest_ref()]
    def normalize_options(inventory):
        agents = normalize(inventory)
        if options.lectura_proc_privilegiada:
            for agent in agents:
                if astra(agent):
                    agent["privileged_proc_read"] = True
        return agents

    core.normalize = normalize_options
    if options.preparar_parada_astra or options.revertir_parada_astra:
        args = core.arguments()
        if args.todos or args.agente != ["astra"] or args.revertir:
            raise core.Failure("native stop preparation/restoration requires only --agente astra")
        agents = normalize_options(core.private_json(args.inventario))
        agent = next((item for item in agents if astra(item)), None)
        if agent is None:
            raise core.Failure("Astra native identity is absent")
        return revert_safety(agent, options) if options.revertir_parada_astra else prepare(agent, options)
    required_steps = {}

    def before(agent, **kwargs):
        if astra(agent) and not options.execute:
            mode = core.systemctl(agent, "show", agent["unit"], "-p", "KillMode", "--value").strip()
            if mode == "control-group":
                laboratory_proof(options.prueba_laboratorio)
                current = measure_control_group(agent)
                required_steps["astra"] = ["prepare KillMode=process with backup and --parada-recibo",
                                           "update adapter through canonical lifecycle",
                                           "verify same pane/conversation and canonical nonce delivery"]
                return current
        if astra(agent) and options.execute:
            value = validate_receipt(agent, options.parada_recibo)
            if value.get("state") != "prepared" or read_safety(agent) != CONTENT:
                raise core.Failure("native safe-stop preparation is not attested")
        return BASE_BEFORE(agent, **kwargs)

    def probe(args, agent, release):
        if not astra(agent):
            return BASE_PROBE(args, agent, release)
        receipt = validate_receipt(agent, options.parada_recibo)
        previous = receipt.get("tui_current", receipt["tui_before"])
        observed = snapshot(agent)
        restarted = observed["adapter_pid"] != previous["adapter_pid"]
        absent = previous.get("tui") == "absent"
        if not absent and not same_tui(observed, previous) or not args.revertir and not restarted:
            raise core.Failure("native adapter replacement or TUI continuity is unverified")
        result = BASE_PROBE(args, agent, release)
        final = snapshot(agent)
        if final.get("tui") != "present" or not absent and not same_tui(final, previous) \
                or observed.get("tui") == "present" and not same_tui(final, observed):
            raise core.Failure("native TUI conversation changed during the delivery probe")
        receipt["tui_current"] = final
        receipt["verified_release"] = release
        core.save(options.parada_recibo, receipt)
        return {**result, "same_pane": None if absent else True, "same_conversation": None if absent else True,
                "tui_before": "absent" if absent else "present", "tui": "present",
                "tui_created": absent, "adapter_restarted": restarted}

    def stop(agent):
        if astra(agent):
            receipt = validate_receipt(agent, options.parada_recibo)
            previous = receipt.get("tui_current", receipt["tui_before"])
            observed = snapshot(agent)
            if not same_tui(previous, observed) or observed["adapter_pid"] != previous["adapter_pid"]:
                raise core.Failure("native TUI changed before stop; no runtime was stopped")
        BASE_STOP(agent)

    core.before = before
    core.probe = probe
    core.stop = stop
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        code = core.main()
    shown = json.loads(stream.getvalue())
    if not options.execute:
        shown["scope"] = "V3"
        shown["excluded"] = {"gaia": "V4 kit", "hades": "V4 kit", "argos": "V4 kit", "hegel": "V4 kit"}
        shown["required_steps"] = required_steps
    print(json.dumps(shown, indent=2))
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (core.Failure, OSError, ValueError, KeyError, TypeError, AttributeError, ImportError) as error:
        print(json.dumps({"status": "failed", "reason": str(error) if isinstance(error, core.Failure)
                          else "V3 operation unavailable; retain its receipt"}), file=sys.stderr)
        raise SystemExit(1) from None
