from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import tempfile
import time
from typing import Any

from .native_admin_paths import NativeError, digest, piece_path, read_path, roots
from .native_admin_projection import public_server, servers


def vendor_environment(bundle: dict[str, Any]) -> dict[str, str]:
    home, root = roots(bundle)
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TERM") if name in os.environ}
    env.update({"HOME": home, "CODEX_HOME": root, "CLAUDE_CONFIG_DIR": root,
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1"})
    return env


def codex_skill(binary: str, bundle: dict[str, Any], identifier: str) -> bool:
    _, root = roots(bundle)
    process = subprocess.Popen([binary, "app-server", "--stdio"], cwd=root, env=vendor_environment(bundle),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        def send(value: dict[str, Any]) -> None:
            process.stdin.write(json.dumps(value).encode() + b"\n")
            process.stdin.flush()
        buffered = bytearray()
        def receive(response_id: int) -> dict[str, Any]:
            end = time.monotonic() + 4
            while time.monotonic() < end:
                while b"\n" in buffered:
                    raw, _, remainder = buffered.partition(b"\n")
                    buffered[:] = remainder
                    value = json.loads(raw)
                    if value.get("id") == response_id:
                        return value
                if not select.select([process.stdout], [], [], 0.2)[0]:
                    continue
                raw = os.read(process.stdout.fileno(), 65536)
                if not raw or len(buffered) + len(raw) > 262144:
                    break
                buffered.extend(raw)
            return {}
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "cauce-native-admin", "version": "1"},
              "capabilities": {"experimentalApi": True}}})
        if "result" not in receive(1):
            return False
        send({"method": "initialized"})
        send({"id": 2, "method": "skills/list", "params": {"cwds": [root], "forceReload": True}})
        result = receive(2).get("result", {})
        expected = piece_path(bundle, "skill", identifier)
        return any(skill.get("name") == identifier and skill.get("path") == expected
                   for group in result.get("data", []) for skill in group.get("skills", []))
    finally:
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1)
        if process.stdin:
            process.stdin.close()
        if process.stdout:
            process.stdout.close()


def recognize(bundle: dict[str, Any], kind: str, identifier: str, expected_sha: str | None) -> dict[str, Any]:
    path = piece_path(bundle, kind, identifier)
    before = read_path(path)
    if digest(before) != expected_sha:
        raise NativeError("conflict")
    recognized = False
    format_verified = False
    binary = shutil.which(bundle["harness"])
    if binary is not None and before is not None:
        try:
            if bundle["harness"] == "codex" and kind == "skill":
                recognized = codex_skill(binary, bundle, identifier)
            elif kind == "mcp":
                current = public_server(bundle["harness"], servers(bundle["harness"], before).get(identifier))
                if current is not None:
                    args = [binary, "mcp", "get", identifier] + (["--json"] if bundle["harness"] == "codex" else [])
                    env = vendor_environment(bundle)
                    with tempfile.TemporaryDirectory(prefix="cauce-native-vendor-") as candidate:
                        if bundle["harness"] == "claude":
                            view = {"type": "http", "url": current["url"]}
                            if "bearer_token_env_var" in current:
                                view["headers"] = {"Authorization": "Bearer ${" + current["bearer_token_env_var"] + "}"}
                            with open(candidate + "/.claude.json", "w", encoding="utf-8") as stream:
                                json.dump({"mcpServers": {identifier: view}}, stream)
                            env["HOME"] = candidate
                            env["CLAUDE_CONFIG_DIR"] = candidate
                        result = subprocess.run(args, cwd=candidate if bundle["harness"] == "claude" else roots(bundle)[1],
                                                env=env, capture_output=True, text=True, timeout=4)
                    if result.returncode == 0 and len(result.stdout.encode()) <= 16384:
                        if bundle["harness"] == "codex":
                            native = json.loads(result.stdout)
                            transport = native.get("transport", {})
                            recognized = transport.get("url") == current["url"] and transport.get("bearer_token_env_var") == current.get("bearer_token_env_var")
                        else:
                            format_verified = "Type: http" in result.stdout and ("URL: " + current["url"]) in result.stdout
        except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
            recognized = False
    if digest(read_path(path)) != expected_sha:
        raise NativeError("conflict")
    return {"type": "recognition", "kind": kind, "id": identifier, "sha": expected_sha,
            "state": "available_for_new_session" if recognized else "written_pending_reload",
            "reason": "provider_read_verified" if recognized else "provider_format_verified" if format_verified else "provider_read_unavailable"}
