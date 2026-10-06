#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import pathlib

from atomic_file import atomic_write
from fleet_derive import HOST_STATE_DIRECTORY, load_fleet_assignments
from instance_namespace import unit_prefix, validate_installation_id, validate_unit_path
from manifest_lib import load_manifests

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="Generate hardened systemd units from exact alias manifests")
parser.add_argument("--output", type=pathlib.Path, default=root / "generated" / "systemd")
parser.add_argument("--alias")
parser.add_argument("--ops-root", type=pathlib.Path, default=root)
parser.add_argument("--instance-id")
parser.add_argument("--install-prefix", default="/opt/cauce-v3")
parser.add_argument("--config-root", default="/etc/cauce-v3/aliases")
parser.add_argument("--state-root", default="/var/lib/cauce-v3/aliases")
parser.add_argument("--runtime-user", default="cauce-v3")
args = parser.parse_args()
try:
    installation = validate_installation_id(args.instance_id)
    UNIT_PREFIX = unit_prefix(installation)
    for option in (args.install_prefix, args.config_root, args.state_root):
        validate_unit_path(option)
except ValueError as error:
    parser.error(str(error))
if not args.runtime_user.isascii() or not args.runtime_user.replace("-", "").replace("_", "").isalnum():
    parser.error("--runtime-user must be a safe system identity")
root = args.ops_root.resolve()
aliases = load_fleet_assignments(root)
if args.alias and args.alias not in aliases:
    parser.error("alias not in selected inventory")
manifests = load_manifests(root)
if args.alias:
    manifests = [item for item in manifests if item["spec"]["alias"] == args.alias]
args.output.mkdir(parents=True, exist_ok=True)


def unit_for(manifest: dict) -> str:
    spec = manifest["spec"]
    alias = spec["alias"]
    host_state_directory = HOST_STATE_DIRECTORY.format(alias=alias) if installation is None else f"{args.state_root}/{alias}"
    systemd_state_directory = host_state_directory.removeprefix("/var/lib/")
    state_directory_lines = (
        f"StateDirectory={systemd_state_directory}\nStateDirectoryMode=0700\n"
        if host_state_directory.startswith("/var/lib/") else ""
    )
    secrets = spec["secretPathEnv"]
    operational_model = spec["process"].get("operationalModelEnv")
    operational_model_line = (
        f"Environment=CAUCE_OPERATIONAL_MODEL_ENV={operational_model}\n" if operational_model else ""
    )
    openclaw_workspace_line = (
        f"Environment=CAUCE_OPENCLAW_WORKSPACE={spec['profile']['workspace']}\n"
        if spec["harness"] == "openclaw" else ""
    )
    installation_environment = "" if installation is None else (
        f"Environment=CAUCE_INSTALLATION_ID={installation}\n"
        f"Environment=CAUCE_INSTALLATION_STATE_ROOT={args.state_root}\n"
    )
    return f"""[Unit]
Description=Cauce V3 alias consumer {alias} ({spec['tenant']}/{spec['harness']})
After=network-online.target {UNIT_PREFIX}-compose@prod.service
Wants=network-online.target
ConditionPathExists={args.config_root}/{alias}.env
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
User={args.runtime_user}
Group={args.runtime_user}
UMask=0077
Environment=CAUCE_ALIAS={alias}
Environment=CAUCE_TENANT={spec['tenant']}
Environment=CAUCE_ROOM={spec['room']}
Environment=CAUCE_HARNESS={spec['harness']}
Environment=CAUCE_SEMBRAR_PERFIL=1
{openclaw_workspace_line}Environment=CAUCE_ORIGIN_TRANSPORT=telegram
Environment=CAUCE_ENVIRONMENT=production
{installation_environment}Environment=CAUCE_INSTANCE_ID=systemd-{(installation + "-") if installation else ""}{alias}
Environment=CAUCE_STATE_DIR={host_state_directory}
Environment=CAUCE_RELAY_URL_ENV={spec['relay']['urlPathEnv']}
Environment=CAUCE_TOKEN_PATH_ENV={secrets['token']}
Environment=CAUCE_CERT_PATH_ENV={secrets['clientCertificate']}
Environment=CAUCE_KEY_PATH_ENV={secrets['clientKey']}
Environment=CAUCE_CA_PATH_ENV={secrets['certificateAuthority']}
Environment=CAUCE_EXEC_PATH_ENV={spec['process']['executablePathEnv']}
{operational_model_line}EnvironmentFile={args.config_root}/{alias}.env
ExecStart={args.install_prefix}/ops/scripts/alias-runner.sh {alias}
Restart=always
RestartSec=5s
TimeoutStopSec=90s
KillMode=mixed
{state_directory_lines}NoNewPrivileges=true
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
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
ReadOnlyPaths={args.install_prefix}
ReadWritePaths={host_state_directory}

[Install]
WantedBy=multi-user.target
"""

for manifest in manifests:
    alias = manifest["spec"]["alias"]
    destination = args.output / f"{UNIT_PREFIX}-alias-{alias}.service"
    body = unit_for(manifest)
    atomic_write(destination, body)
    print(destination)

if not args.alias:
    for stale in sorted(args.output.glob(f"{UNIT_PREFIX}-alias-*.service")):
        stale_alias = stale.name[len(f"{UNIT_PREFIX}-alias-"):-len(".service")]
        if stale_alias not in aliases:
            stale.unlink()
            print(f"retired {stale}")
    checksum = args.output / "SHA256SUMS"
    lines = []
    for alias in sorted(aliases):
        unit = args.output / f"{UNIT_PREFIX}-alias-{alias}.service"
        lines.append(f"{hashlib.sha256(unit.read_bytes()).hexdigest()}  {unit.name}")
    atomic_write(checksum, "\n".join(lines) + "\n")
    print(checksum)
