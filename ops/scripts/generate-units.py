#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import tempfile

from container_alias_lib import load_container_aliases
from manifest_lib import load_manifests

root = pathlib.Path(__file__).resolve().parents[1]
aliases = load_container_aliases(root)
parser = argparse.ArgumentParser(description="Generate hardened systemd units from exact alias manifests")
parser.add_argument("--output", type=pathlib.Path, default=root / "generated" / "systemd")
parser.add_argument("--alias", choices=sorted(aliases))
args = parser.parse_args()

manifests = load_manifests(root)
if args.alias:
    manifests = [item for item in manifests if item["spec"]["alias"] == args.alias]
args.output.mkdir(parents=True, exist_ok=True)


def unit_for(manifest: dict) -> str:
    spec = manifest["spec"]
    alias = spec["alias"]
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
User=cauce-v3
Group=cauce-v3
UMask=0077
Environment=CAUCE_ALIAS={alias}
Environment=CAUCE_TENANT={spec['tenant']}
Environment=CAUCE_ROOM={spec['room']}
Environment=CAUCE_HARNESS={spec['harness']}
Environment=CAUCE_SEMBRAR_PERFIL=1
{openclaw_workspace_line}Environment=CAUCE_ORIGIN_TRANSPORT=telegram
Environment=CAUCE_ENVIRONMENT=production
Environment=CAUCE_INSTANCE_ID=systemd-{alias}
Environment=CAUCE_STATE_DIR={spec['stateDirectory']}
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
StateDirectory=cauce-v3/aliases/{alias}
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
ReadWritePaths={spec['stateDirectory']}

[Install]
WantedBy=multi-user.target
"""

for manifest in manifests:
    alias = manifest["spec"]["alias"]
    destination = args.output / f"cauce-v3-alias-{alias}.service"
    body = unit_for(manifest)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=args.output, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(destination)

if not args.alias:
    checksum = args.output / "SHA256SUMS"
    lines = []
    for alias in sorted(aliases):
        unit = args.output / f"cauce-v3-alias-{alias}.service"
        lines.append(f"{hashlib.sha256(unit.read_bytes()).hexdigest()}  {unit.name}")
    fd, temporary = tempfile.mkstemp(prefix=".SHA256SUMS.", dir=args.output, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, checksum)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(checksum)
