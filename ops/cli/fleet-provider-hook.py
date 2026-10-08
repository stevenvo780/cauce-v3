#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

from fleet_provider_identity import authenticated_provider
from fleet_provider_probe import probe


def validate(packet: dict):
    if (
        not isinstance(packet, dict)
        or packet.get("step") not in {"authenticate", "profile", "verify", "revoke"}
        or not isinstance(packet.get("nonce"), str)
        or re.fullmatch(r"[a-f0-9]{64}", packet["nonce"]) is None
    ):
        raise ValueError("invalid hook packet")
    agent = packet["agent"]
    for field in ("tenant_id", "alias", "runtime_key", "runtime_user", "home_directory", "state_directory"):
        if not isinstance(agent.get(field), str) or not agent[field] or any(ord(char) < 32 for char in agent[field]):
            raise ValueError("invalid runtime identity")
    if packet["step"] != "revoke":
        binding = packet["profile_binding"]
        if binding.get("identity") != packet["identity"] or binding.get("runtime_user") != agent["runtime_user"]:
            raise ValueError("provider profile identity changed")


def container(packet: dict) -> dict:
    binding = packet["runtime_binding"]
    observed = json.loads(subprocess.check_output(["/usr/bin/docker", "inspect", binding["container_id"]], timeout=10))[
        0
    ]
    generation = hashlib.sha256((observed["Id"] + "\0" + observed["State"]["StartedAt"]).encode()).hexdigest()
    agent = packet["agent"]
    if (
        observed["Id"] != binding["container_id"]
        or observed["Image"] != binding["image_digest"]
        or generation != binding["generation"]
        or observed["State"]["Running"] is not True
        or binding.get("ownership") != "shared" and (
            observed["Config"]["Labels"].get("cauce.fleet.runtime_key") != agent["runtime_key"]
            or observed["Config"]["Labels"].get("cauce.fleet.tenant") != agent["tenant_id"]
            or observed["Config"]["Labels"].get("cauce.fleet.alias") != agent["alias"])
    ):
        raise ValueError("container identity changed")
    interpreter = binding.get("python")
    if not isinstance(interpreter, str) or not interpreter.startswith("/") or str(pathlib.PurePosixPath(interpreter)) != interpreter or ".." in pathlib.PurePosixPath(interpreter).parts:
        raise ValueError("container interpreter is not approved")
    if binding.get("ownership") == "shared":
        shared_container_identity(packet, observed)
    script = "/cauce/executor/fleet-provider-hook.py"
    result = subprocess.run(
        [
            "/usr/bin/docker",
            "exec",
            "-i",
            "--user",
            agent["runtime_user"],
            "--env",
            "HOME=" + agent["home_directory"],
            binding["container_id"],
            "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=" + agent["home_directory"], "PYTHONDONTWRITEBYTECODE=1",
            interpreter,
            script,
            "--inside",
        ],
        input=json.dumps(packet).encode(),
        capture_output=True,
        timeout=43,
    )
    if result.returncode != 0 or len(result.stdout) > 8192:
        raise ValueError("container did not return a bounded proof")
    return json.loads(result.stdout)


def shared_container_identity(packet: dict, observed: dict):
    binding, agent = packet["runtime_binding"], packet["agent"]
    mounts = [{field: mount[field] for field in ("Destination", "Source", "Type", "RW")} for mount in observed["Mounts"]]
    if (not isinstance(binding.get("mounts"), list)
        or sorted(mounts, key=lambda row: row["Destination"]) != sorted(binding["mounts"], key=lambda row: row["Destination"])):
        raise ValueError("shared container mount pins changed")
    for field in ("control_directory", "bundle_directory"):
        value = binding.get(field)
        if not isinstance(value, str) or not value.startswith("/") or str(pathlib.PurePosixPath(value)) != value or ".." in pathlib.PurePosixPath(value).parts:
            raise ValueError("shared runtime proof path differs")
    subprocess.run(["/usr/bin/docker", "exec", "--user", "0", binding["container_id"], binding["python"],
        "/cauce/lifecycle/cauce-container-runtime.py", "check", "--alias", agent["runtime_key"], "--state", agent["state_directory"],
        "--control-dir", binding["control_directory"], "--container-id", binding["container_id"], "--generation", binding["generation"],
        "--bundle", binding["bundle_directory"], "--bundle-digest", binding["bundle_digest"]], capture_output=True, timeout=10, check=True)
    raw = subprocess.check_output(["/usr/bin/docker", "exec", "--user", "0", binding["container_id"], "/bin/cat",
        binding["control_directory"] + "/cauce-v3-adapter.json"], timeout=10)
    if len(raw) > 8192:
        raise ValueError("shared runtime metadata exceeds its bound")
    metadata = json.loads(raw)
    expected = {"alias": agent["runtime_key"], "wireAlias": agent["alias"], "tenantId": agent["tenant_id"],
        "runtimeUid": binding.get("runtime_uid"), "runtimeGid": binding.get("runtime_gid"), "containerId": binding["container_id"],
        "containerGeneration": binding["generation"], "stateDirectory": agent["state_directory"], "controlDirectory": binding["control_directory"]}
    if any(metadata.get(field) != value for field, value in expected.items()):
        raise ValueError("shared runtime process identity changed")


def execute(packet: dict) -> dict:
    validate(packet)
    if packet["step"] == "revoke":
        from fleet_provider_revoke import revoke

        result = revoke(packet)
    elif packet["agent"].get("runtime_mode") == "container" and "--inside" not in sys.argv:
        return container(packet)
    else:
        import pwd

        if os.geteuid() != pwd.getpwnam(packet["agent"]["runtime_user"]).pw_uid or os.geteuid() == 0:
            raise ValueError("functional check is not running under the approved user")
        result = (
            {"authenticated": authenticated_provider(packet)} if packet["step"] == "authenticate" else probe(packet)
        )
    identity = {key: packet["agent"][key] for key in ("tenant_id", "alias", "runtime_key")}
    identity.update(account_id=packet["account_id"], identity=packet["identity"], nonce=packet["nonce"])
    if "phase" in packet:
        identity["phase"] = packet["phase"]
    return {**identity, **result}


def main():
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("hook packet exceeds limit")
        receipt = execute(json.loads(raw))
        print(json.dumps(receipt, separators=(",", ":")))
    except Exception:
        print("Functional provider effect is unverified", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
