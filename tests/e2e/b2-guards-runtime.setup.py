import grp
import json
import os
import pathlib
import shutil
import subprocess
import sys

packet = json.loads(sys.argv[1])
repo = pathlib.Path(packet["repo"])
home = pathlib.Path("/home/node")
ops = home / ".local/share/cauce-v3/ops"
units = home / ".config/systemd/user"
aliases = home / ".config/cauce-v3/container-aliases"
state = home / ".local/state/cauce-attach"
local_bin = home / ".local/bin"
for directory in (ops, units, aliases, state, local_bin):
    directory.mkdir(parents=True, exist_ok=True)
shutil.copytree(repo / "ops/scripts", ops / "scripts", dirs_exist_ok=True)
alias = packet["alias"]
inventory = {"schemaVersion": 2, "systemPrincipals": {}, "historicalAliases": {}, "aliases": {
    alias: {"tenant": "Isa", "room": "e2e.isa", "container": packet["agent"], "user": "node",
            "home": "/home/node", "stateDirectory": "/home/node/adapter-state", "harness": "codex",
            "membershipRole": "agent", "systemdUser": "node"}}}
(ops / "container-aliases.json").write_text(json.dumps(inventory), encoding="utf-8")
(aliases / f"{alias}.env").write_text("SHARED_SESSION=1\nBUNDLE_RELEASE=b2-owned\nSHARED_SESSION_WORKSPACE=/workspace\n", encoding="ascii")
for name in ("cauce-panel-guard", "cauce-tmux-panel", "cauce-attach-guard"):
    shutil.copy2(repo / "ops/guardias" / name, local_bin / name)
for name in ("cauce-v3-panel-guard", "cauce-attach-guard"):
    for suffix in ("service", "timer"):
        shutil.copy2(repo / "ops/guardias/systemd" / f"{name}.{suffix}", units / f"{name}.{suffix}")
    dropin = units / f"{name}.timer.d"
    dropin.mkdir(exist_ok=True)
    (dropin / "lab.conf").write_text("[Timer]\nOnBootSec=\nOnUnitActiveSec=\nOnActiveSec=100ms\nAccuracySec=10ms\n", encoding="ascii")
service = units / f"cauce-v3-container-{alias}.service"
service.write_text(f"[Unit]\nDescription=Owned lab adapter\n[Service]\nExecStart=/usr/local/bin/docker start --attach {packet['agent']}\nExecStop=/usr/local/bin/docker stop --time 3 {packet['agent']}\nSuccessExitStatus=143 SIGTERM\n", encoding="ascii")
socket_group = os.stat("/var/run/docker.sock").st_gid
try:
    group = grp.getgrgid(socket_group).gr_name
except KeyError:
    group = "labdocker"
    subprocess.run(["groupadd", "--gid", str(socket_group), group], check=True)
subprocess.run(["usermod", "--append", "--groups", group, "node"], check=True)
for parent, dirs, files in os.walk(home):
    os.chown(parent, 1000, 1000)
    for name in (*dirs, *files):
        os.chown(pathlib.Path(parent) / name, 1000, 1000)
subprocess.run(["systemctl", "start", "user@1000.service"], check=True)
print(json.dumps({"alias": alias, "agent": packet["agent"], "systemd_user": 1000, "docker_socket_group": socket_group}))
