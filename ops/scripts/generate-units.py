#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re

from atomic_file import atomic_write
from fleet_derive import HOST_STATE_DIRECTORY, load_fleet_assignments
from manifest_lib import load_manifests

root = pathlib.Path(__file__).resolve().parents[1]
aliases = load_fleet_assignments(root)
parser = argparse.ArgumentParser(description="Generate hardened systemd units from exact alias manifests")
parser.add_argument("--output", type=pathlib.Path, default=root / "generated" / "systemd")
parser.add_argument("--alias", choices=sorted(aliases))
args = parser.parse_args()

manifests = load_manifests(root)
if args.alias:
    manifests = [item for item in manifests if item["metadata"]["name"] == args.alias]
args.output.mkdir(parents=True, exist_ok=True)


def systemd_environment(name: str, value: str) -> str:
    assignment = f"{name}={value.replace('%', '%%')}"
    return assignment if re.fullmatch(r"[A-Za-z0-9_=/.:@-]+", assignment) else json.dumps(assignment)


def unit_for(manifest: dict) -> str:
    spec = manifest["spec"]
    alias = manifest["metadata"]["name"]
    wire_alias = spec["alias"]
    dynamic_runtime = "CAUCE_FLEET_RUNTIME_STATE" in os.environ or wire_alias != alias
    physical_identity_line = f"Environment=CAUCE_RUNTIME_KEY={alias}\nEnvironment=CAUCE_TENANT_ID={spec['tenant']}\n" \
        if dynamic_runtime else ""
    execution_user = f"User={aliases[alias]['user']}\n" if dynamic_runtime else "User=cauce-v3\nGroup=cauce-v3\n"
    host_state_directory = HOST_STATE_DIRECTORY.format(alias=alias)
    systemd_state_directory = host_state_directory.removeprefix("/var/lib/")
    secrets = spec["secretPathEnv"]
    operational_model = spec["process"].get("operationalModelEnv")
    operational_model_line = (
        f"Environment=CAUCE_OPERATIONAL_MODEL_ENV={operational_model}\n" if operational_model else ""
    )
    openclaw_workspace_line = (
        f"Environment=CAUCE_OPENCLAW_WORKSPACE={spec['profile']['workspace']}\n"
        if spec["harness"] == "openclaw" else ""
    )
    return f"""[Unit]
Description=Cauce V3 alias consumer {alias} ({spec['tenant']}/{spec['harness']})
After=network-online.target cauce-v3-compose@prod.service
Wants=network-online.target
ConditionPathExists=/etc/cauce-v3/aliases/{alias}.env
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
{execution_user}UMask=0077
Environment=CAUCE_ALIAS={wire_alias}
{physical_identity_line}Environment=CAUCE_TENANT={spec['tenant']}
Environment={systemd_environment('CAUCE_ROOM', spec['room'])}
Environment=CAUCE_HARNESS={spec['harness']}
Environment=CAUCE_SEMBRAR_PERFIL=1
{openclaw_workspace_line}Environment=CAUCE_ORIGIN_TRANSPORT=telegram
Environment=CAUCE_ENVIRONMENT=production
Environment=CAUCE_INSTANCE_ID=systemd-{alias}
Environment=CAUCE_STATE_DIR={host_state_directory}
Environment=CAUCE_RELAY_URL_ENV={spec['relay']['urlPathEnv']}
Environment=CAUCE_TOKEN_PATH_ENV={secrets['token']}
Environment=CAUCE_CERT_PATH_ENV={secrets['clientCertificate']}
Environment=CAUCE_KEY_PATH_ENV={secrets['clientKey']}
Environment=CAUCE_CA_PATH_ENV={secrets['certificateAuthority']}
Environment=CAUCE_EXEC_PATH_ENV={spec['process']['executablePathEnv']}
{operational_model_line}EnvironmentFile=/etc/cauce-v3/aliases/{alias}.env
ExecStart=/opt/cauce-v3/ops/scripts/alias-runner.sh {alias}
Restart=always
RestartSec=5s
TimeoutStopSec=90s
KillMode=mixed
StateDirectory={systemd_state_directory}
StateDirectoryMode=0700
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
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
ReadOnlyPaths=/opt/cauce-v3
ReadWritePaths={host_state_directory}

[Install]
WantedBy=multi-user.target
"""

for manifest in manifests:
    alias = manifest["metadata"]["name"]
    destination = args.output / f"cauce-v3-alias-{alias}.service"
    body = unit_for(manifest)
    atomic_write(destination, body)
    print(destination)

if not args.alias:
    for stale in sorted(args.output.glob("cauce-v3-alias-*.service")):
        stale_alias = stale.name[len("cauce-v3-alias-"):-len(".service")]
        if stale_alias not in aliases:
            stale.unlink()
            print(f"retired {stale}")
    checksum = args.output / "SHA256SUMS"
    lines = []
    for alias in sorted(aliases):
        unit = args.output / f"cauce-v3-alias-{alias}.service"
        lines.append(f"{hashlib.sha256(unit.read_bytes()).hexdigest()}  {unit.name}")
    atomic_write(checksum, "\n".join(lines) + "\n")
    print(checksum)
