#!/usr/bin/env bash
set -Eeuo pipefail

script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec python3 - "${CAUCE_PTY_RELEASE_ROOT:-$script_root}" "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile


def refuse(message, code=78):
    print(f"cauce-pty-host: {message}", file=sys.stderr)
    raise SystemExit(code)


uid = os.geteuid()
root = Path(sys.argv[1])
arguments = sys.argv[2:]
preflight = arguments[:1] == ["--preflight-only"]
if preflight:
    arguments = arguments[1:]
if len(arguments) != 1 or not re.fullmatch(r"[a-z][a-z0-9.-]*", arguments[0]):
    refuse("usage: cauce-pty-host-launcher.sh [--preflight-only] ALIAS")
alias = arguments[0]
account = pwd.getpwuid(uid)
config_root = Path(os.environ.get("CAUCE_PTY_HOST_CONFIG_ROOT", str(Path(account.pw_dir) / ".config/cauce-v3/pty-host")))


def secure(path, directory=False, mode=None):
    info = path.lstat()
    valid_kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_kind or info.st_uid != uid or info.st_mode & 0o077:
        refuse(f"private runtime-owned {'directory' if directory else 'file'} required: {path}")
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        refuse(f"unexpected permissions: {path}")
    return path


try:
    secure(config_root, directory=True)
    config_path = secure(config_root / f"{alias}.env", mode=0o600)
    allowed = {"TENANT_ID", "ADAPTER_UNIT", "RELAY_HOST", "RELAY_PORT", "RELAY_SERVER_NAME", "PKI_DIR", "ALIAS_KEY_FILE"}
    config = {}
    for line in config_path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in allowed or key in config or not value:
            refuse("invalid or duplicate host configuration field")
        config[key] = value
    if not (allowed - {"RELAY_SERVER_NAME"}).issubset(config):
        refuse("incomplete host configuration")
    unit = config["ADAPTER_UNIT"]
    if not re.fullmatch(r"cauce-v3-[a-z0-9@_.-]+\.service", unit):
        refuse("invalid adapter unit")
    result = subprocess.run(["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"], capture_output=True, text=True)
    if result.returncode != 0 or not result.stdout.strip().isdigit() or int(result.stdout.strip()) < 1:
        refuse("adapter unit has no live MainPID", 75)
    pid = result.stdout.strip()
    proc = Path("/proc") / pid
    before = proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19]
    if proc.stat().st_uid != uid:
        refuse("adapter MainPID belongs to another user")
    environment = dict(part.decode().split("=", 1) for part in proc.joinpath("environ").read_bytes().split(b"\0") if b"=" in part)
    command = proc.joinpath("cmdline").read_bytes().split(b"\0")
    entries = [Path(arg.decode()) for arg in command[:4] if b"/dist/src/bin/" in arg]
    if environment.get("CAUCE_ALIAS") != alias or len(entries) != 1 or entries[0].stem not in {"claude", "codex"}:
        refuse("adapter process does not accredit this alias and harness")
    if environment.get("CAUCE_TENANT") != config["TENANT_ID"] or environment.get("CAUCE_SHARED_SESSION") != "1":
        refuse("adapter tenant or shared session does not match")
    harness = entries[0].stem
    home = environment.get("HOME", "")
    workspace = environment.get("CAUCE_SHARED_SESSION_WORKSPACE", "")
    profile_variable = "CLAUDE_CONFIG_DIR" if harness == "claude" else "CODEX_HOME"
    profile = environment.get(profile_variable, str(Path(home) / (".claude" if harness == "claude" else ".codex")))
    for path in (home, workspace, profile):
        candidate = Path(path)
        if not candidate.is_absolute() or str(candidate.resolve()) != path or not candidate.is_dir():
            refuse("adapter home, workspace or profile is not canonical")
    if Path(profile).stat().st_uid != uid or not Path(profile).is_relative_to(home):
        refuse("adapter profile is not owned beneath its home")
    tmux = subprocess.run(["tmux", "-L", "cauce", "display-message", "-p", "-t", f"cauce-{alias}:agente",
                           "#{@cauce_alias}|#{@cauce_harness}|#{pane_dead}|#{window_panes}|#{pane_current_path}"],
                          capture_output=True, text=True)
    if tmux.returncode != 0 or tmux.stdout.strip() != f"{alias}|{harness}|0|1|{workspace}":
        refuse("the exact shared TUI is not ready", 75)
    pki = secure(Path(config["PKI_DIR"]), directory=True)
    if pki.name != alias:
        refuse("PKI directory is not scoped to the alias")
    key_path = Path(config["ALIAS_KEY_FILE"])
    if key_path != pki / "alias-key.hex":
        refuse("alias key is outside its PKI directory")
    key = secure(key_path, mode=0o400).read_text().strip()
    material = {name: secure(pki / name, mode=0o600).read_text() for name in ("client.crt", "client.key", "ca.crt")}
    sys.path.insert(0, str(root / "pty-agent"))
    from rollout_pty_lib import ReleaseBundle
    from cauce_pty_agent.runtime_facts import validate_bundle
    from cauce_pty_agent.agent import main
    release = ReleaseBundle.from_ops_root(root)
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    hostname = os.uname().nodename
    generation = hashlib.sha256(f"{boot}:{uid}:{home}".encode()).hexdigest()[:32]
    facts = {"claude_config_dir" if harness == "claude" else "codex_home": profile,
             "cwd": workspace, "workspace_root": workspace, "project_root": workspace}
    bundle = {
        "tenant_id": config["TENANT_ID"], "alias": alias, "container_id": f"host:{hostname}",
        "generation": generation, "image_id": f"native:{os.uname().release}",
        "runtime_user": account.pw_name, "runtime_uid": uid, "runtime_gid": os.getegid(), "home": home,
        "shell_candidates": [["/bin/bash", "-l"], ["/bin/sh", "-l"]], "harness": harness,
        "tmux_tui": {"path": "/usr/bin/tmux", "socket": "cauce"}, "runtime_facts": facts,
        "relay_host": config["RELAY_HOST"], "relay_port": int(config["RELAY_PORT"]),
        "alias_key_hex": key, "client_cert_pem": material["client.crt"],
        "client_key_pem": material["client.key"], "ca_pem": material["ca.crt"], "agent_version": release.release_sha,
    }
    if config.get("RELAY_SERVER_NAME"):
        bundle["relay_server_name"] = config["RELAY_SERVER_NAME"]
    validate_bundle(bundle)
    if not bundle["runtime_facts"]:
        refuse("runtime facts could not be accredited")
    if proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19] != before:
        refuse("adapter process changed during preflight", 75)
    if preflight:
        print(json.dumps({"alias": alias, "unit": unit, "harness": harness, "container_id": bundle["container_id"],
                          "runtime_uid": uid, "profile": profile, "workspace": workspace,
                          "version": release.release_sha, "status": "ready"}))
        raise SystemExit(0)
    runtime = secure(Path(f"/run/user/{uid}"), directory=True)
    descriptor, drop = tempfile.mkstemp(prefix=f"cauce-pty-{alias}-", suffix=".json", dir=runtime)
    with os.fdopen(descriptor, "w") as stream:
        os.fchmod(stream.fileno(), 0o400)
        json.dump(bundle, stream)
    os.environ.update({"HOME": home, "USER": account.pw_name, "LOGNAME": account.pw_name, profile_variable: profile})
    try:
        raise SystemExit(main(["--bundle", drop]))
    finally:
        Path(drop).unlink(missing_ok=True)
except (OSError, ValueError) as error:
    refuse(f"preflight failed: {type(error).__name__}", 75)
PY
