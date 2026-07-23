#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import tempfile

from container_alias_lib import load_container_aliases
from container_ops_digest import operational_digest


root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="Generate host systemd units for adapters inside existing containers")
parser.add_argument("--output", type=pathlib.Path)
parser.add_argument("--rootless", action="store_true", help="generate systemd user units")
parser.add_argument("--home", type=pathlib.Path, default=pathlib.Path.home(), help="rootless example HOME")
parser.add_argument("--install-prefix", help="installed source prefix used by ExecStart/ExecStop")
parser.add_argument("--config-root", help="host alias config root")
parser.add_argument("--pki-root", help="host PKI root")
parser.add_argument("--bundle-root", help="host immutable bundle root")
parser.add_argument("--lock-root", help="host supervisor lock root")
args = parser.parse_args()
aliases = load_container_aliases(root)

mode = "rootless" if args.rootless else "system"
args.output = args.output or root / "generated" / "container-systemd" / ("rootless" if args.rootless else "")
home = args.home.resolve().as_posix()
if not home.startswith("/"):
    parser.error("--home must resolve to an absolute path")
for option in (args.config_root, args.pki_root, args.bundle_root, args.lock_root):
    if option is not None and not option.startswith("/"):
        parser.error("path overrides must be absolute")
if args.install_prefix is not None and not (args.install_prefix.startswith("/") or args.install_prefix.startswith("%h/")):
    parser.error("--install-prefix must be absolute or start with %h/")

if args.rootless:
    install_prefix = args.install_prefix or "%h/.local/share/cauce-v3"
    unit_config_root = args.config_root or "%h/.config/cauce-v3/container-aliases"
    unit_pki_root = args.pki_root or "%h/.config/cauce-v3/container-pki"
    unit_bundle_root = args.bundle_root or "%h/.local/share/cauce-v3-adapter"
    unit_lock_root = args.lock_root or "%t/cauce-v3"
    example_config_root = args.config_root or f"{home}/.config/cauce-v3/container-aliases"
    example_pki_root = args.pki_root or f"{home}/.config/cauce-v3/container-pki"
    example_bundle_root = args.bundle_root or f"{home}/.local/share/cauce-v3-adapter"
else:
    install_prefix = args.install_prefix or "/opt/cauce-v3"
    unit_config_root = example_config_root = args.config_root or "/etc/cauce-v3/container-aliases"
    unit_pki_root = example_pki_root = args.pki_root or "/etc/cauce-v3/container-pki"
    unit_bundle_root = example_bundle_root = args.bundle_root or "/opt/cauce-v3-adapter"
    unit_lock_root = args.lock_root or "/run/lock"


def atomic_write(destination: pathlib.Path, body: str, mode: int = 0o644) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def system_unit(alias: str, entry: dict[str, str]) -> str:
    return f"""[Unit]
Description=Cauce V3 container adapter {alias} ({entry['container']}/{entry['harness']})
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
ConditionPathExists=/etc/cauce-v3/container-aliases/{alias}.env
StartLimitIntervalSec=300s
StartLimitBurst=10

[Service]
Type=simple
User=root
Group=root
UMask=0077
ExecStart=/opt/cauce-v3/ops/scripts/container-adapter-supervisor.sh start {alias}
ExecStop=/opt/cauce-v3/ops/scripts/container-adapter-supervisor.sh stop {alias}
Restart=always
RestartSec=5s
RestartPreventExitStatus=2 73 78
TimeoutStopSec=45s
KillMode=control-group
StandardInput=null
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
ReadOnlyPaths=/etc/cauce-v3/container-aliases /etc/cauce-v3/container-pki /opt/cauce-v3 /opt/cauce-v3-adapter

[Install]
WantedBy=multi-user.target
"""


def rootless_unit(alias: str, entry: dict[str, str]) -> str:
    return f"""[Unit]
Description=Cauce V3 rootless container adapter {alias} ({entry['container']}/{entry['harness']})
After=network-online.target
Wants=network-online.target
ConditionPathExists={unit_config_root}/{alias}.env
StartLimitIntervalSec=300s
StartLimitBurst=10

[Service]
Type=simple
UMask=0077
Environment=CAUCE_CONTAINER_OPS_ROOT={install_prefix}/ops
Environment=CAUCE_CONTAINER_CONFIG_ROOT={unit_config_root}
Environment=CAUCE_CONTAINER_PKI_ROOT={unit_pki_root}
Environment=CAUCE_CONTAINER_BUNDLE_ROOT={unit_bundle_root}
Environment=CAUCE_CONTAINER_LOCK_ROOT={unit_lock_root}
ExecStart={install_prefix}/ops/scripts/container-adapter-supervisor.sh start {alias}
ExecStop={install_prefix}/ops/scripts/container-adapter-supervisor.sh stop {alias}
Restart=always
RestartSec=5s
RestartPreventExitStatus=2 73 78
TimeoutStopSec=45s
KillMode=control-group
StandardInput=null
NoNewPrivileges=true
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=default.target
"""


def unit(alias: str, entry: dict[str, str]) -> str:
    return rootless_unit(alias, entry) if args.rootless else system_unit(alias, entry)


def example(alias: str, entry: dict[str, str]) -> str:
    owner = "the installing user" if args.rootless else "root:root"
    pki_owner = "user-owned" if args.rootless else "root-owned"
    lines = [
        f"# Install as {example_config_root}/{alias}.env, {owner}, mode 0600.",
        f"# Values are non-secret; PKI files live below the {pki_owner} PKI_DIR.",
        "# Required keys: BUNDLE_CURRENT, BUNDLE_SHA256, PKI_DIR, RELAY_URL, EXPECTED_IMAGE_ID.",
        f"BUNDLE_CURRENT={example_bundle_root}/current",
        "BUNDLE_SHA256=sha256:REPLACE_WITH_64_LOWERCASE_HEX",
        f"PKI_DIR={example_pki_root}/{alias}",
        "RELAY_URL=wss://gateway.example.invalid/v3/ws",
        "EXPECTED_IMAGE_ID=sha256:REPLACE_WITH_64_LOWERCASE_HEX",
        "# Optional container-label reinforcement (set both keys or neither); omit to skip the label check:",
        "# EXPECTED_LABEL_KEY=com.example.runtime",
        "# EXPECTED_LABEL_VALUE=replace-with-expected-label-value",
        "# Optional persistent-mount reinforcement. The supervisor discovers, from docker inspect,",
        f"# the bind/volume that CONTAINS the alias state directory ({entry['stateDirectory']}) and",
        "# requires it to be a read-write bind or volume (never tmpfs). Declare any of these only to",
        "# re-verify the discovered mount; MOUNT_DESTINATION must be that containing mount, not the state dir:",
        "# MOUNT_TYPE=bind",
        "# MOUNT_SOURCE=/replace/with/persistent/source",
        "# MOUNT_DESTINATION=/replace/with/persistent/mount/that/contains/the/state/dir",
        "# MOUNT_RW=true",
        "# For a named volume set MOUNT_TYPE=volume and MOUNT_NAME=<exact-name>.",
        "# client.crt/client.key/ca.crt are required; bearer token is optional for mTLS-only aliases.",
    ]
    if entry["harness"] == "hermes":
        lines.extend(("HERMES_HOME=/home/dev/.hermes", "HERMES_INFERENCE_MODEL=replace-with-approved-model"))
    if entry["harness"] == "openclaw":
        lines.extend((
            "# Optional verified API mode (CLI is the default):",
            "# OPENCLAW_TRANSPORT=api",
            "# OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
            f"# OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/{alias}/openclaw-token",
            "# OPENCLAW_AGENT_TARGET=openclaw/default",
            "# OPENCLAW_DIST_DIR=/home/claw/.openclaw/node_modules/openclaw/dist",
        ))
    return "\n".join(lines) + "\n"


args.output.mkdir(parents=True, exist_ok=True)
config_output = args.output / "configs"
config_output.mkdir(parents=True, exist_ok=True)
generated: list[pathlib.Path] = []
for alias, entry in aliases.items():
    unit_path = args.output / f"cauce-v3-container-{alias}.service"
    config_path = config_output / f"{alias}.env.example"
    atomic_write(unit_path, unit(alias, entry))
    atomic_write(config_path, example(alias, entry))
    generated.extend((unit_path, config_path))

operations_path = args.output / "OPERATIONS.sha256"
atomic_write(operations_path, f"{operational_digest(root, args.output.resolve(), rootless=args.rootless)}\n")
generated.append(operations_path)

checksum_lines = []
for path in sorted(generated, key=lambda item: item.relative_to(args.output).as_posix()):
    relative = path.relative_to(args.output).as_posix()
    checksum_lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}")
atomic_write(args.output / "SHA256SUMS", "\n".join(checksum_lines) + "\n")
print(f"generated {len(aliases)} {mode} container units and configs in {args.output}")
