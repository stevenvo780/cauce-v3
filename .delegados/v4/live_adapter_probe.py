#!/usr/bin/python3 -I
"""Verify a live adapter through its canonical process checks and console roundtrip."""
from __future__ import annotations

import argparse
import datetime
import importlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import uuid
from urllib.parse import quote

sys.dont_write_bytecode = True

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ALIAS = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
TENANT = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
RELEASE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
NONCE = re.compile(r"[a-f0-9]{32}\Z")
UUID4 = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
HANDLED_ERRORS = (OSError, ValueError, RuntimeError, KeyError, TypeError,
                  ImportError, AttributeError, subprocess.SubprocessError)


class ProbeFailure(RuntimeError):
    pass


class ProbeArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        self.exit(2, "PROBE_ARGUMENT_INVALID\n")


def fail(code):
    raise ProbeFailure(code)


def timestamp(value):
    if not isinstance(value, str):
        fail("PROBE_TIMESTAMP_INVALID")
    try:
        parsed = datetime.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            fail("PROBE_TIMESTAMP_INVALID")
        return parsed.timestamp()
    except ValueError:
        fail("PROBE_TIMESTAMP_INVALID")


def request(client, method, path, body=None):
    try:
        result = client.request(method, path, body)
    except HANDLED_ERRORS:
        fail("PROBE_CONSOLE_REQUEST_REJECTED_OR_UNAVAILABLE")
    if not isinstance(result, dict):
        fail("PROBE_CONSOLE_RESPONSE_INVALID")
    return result


def target(agent, alias):
    tenant = agent.get("tenant_id")
    room = agent.get("room_id") or agent.get("primary_room_id")
    if agent.get("alias") != alias or not isinstance(tenant, str) or not TENANT.fullmatch(tenant) \
            or not isinstance(room, str) or not 1 <= len(room) <= 128 \
            or any(ord(char) < 32 or ord(char) == 127 for char in room):
        fail("PROBE_TARGET_FIELDS_REQUIRED")
    return tenant, room


def presence(client, tenant, alias, started_at, expected_instance=None):
    value = request(client, "GET", "/v3/console/activity")
    agents = value.get("agents")
    if not isinstance(agents, list):
        fail("PROBE_ACTIVITY_RESPONSE_INVALID")
    rows = [row for row in agents if isinstance(row, dict)
            and row.get("tenant_id") == tenant and row.get("alias") == alias]
    if len(rows) > 1:
        fail("PROBE_ACTIVITY_IDENTITY_AMBIGUOUS")
    if not rows:
        return False
    current = rows[0].get("presence")
    if not isinstance(current, dict) or current.get("online") is not True:
        return False
    if expected_instance is not None and current.get("instance_id") != expected_instance:
        return False
    observed_at = timestamp(value.get("observed_at"))
    heartbeat = timestamp(current.get("last_heartbeat_at"))
    lease_until = timestamp(current.get("lease_until"))
    epoch = current.get("epoch")
    return (isinstance(epoch, int) and not isinstance(epoch, bool) and epoch > 0
            and isinstance(current.get("instance_id"), str) and bool(current["instance_id"])
            and started_at <= observed_at <= time.time() + 30
            and started_at < heartbeat <= observed_at + 30
            and lease_until > max(observed_at, time.time()))


NATIVE_PROOF = r'''
import json,os,pathlib,subprocess,sys
unit,bundle,release,harness,expected_uid=sys.argv[1:]
def main_pid():
 result=subprocess.run(['systemctl','--user','show',unit,'-p','MainPID','--value'],capture_output=True,text=True,timeout=20)
 if result.returncode or not result.stdout.strip().isdigit(): raise ValueError()
 return int(result.stdout.strip())
pid=main_pid()
if pid<=0: raise ValueError()
process=pathlib.Path('/proc')/str(pid)
before=(process/'stat').read_bytes()
args=(process/'cmdline').read_bytes().decode().split(chr(0))
args=[item for item in args if item]
entry=str(pathlib.Path(bundle)/'releases'/release/'packages/adapter-sdk/dist/src/bin'/(harness+'.js'))
if len(args)!=2 or args[1]!=entry or process.stat().st_uid!=int(expected_uid): raise ValueError()
if pathlib.Path(entry).resolve()!=pathlib.Path(entry) or not pathlib.Path(entry).is_file(): raise ValueError()
os.kill(pid,0)
if main_pid()!=pid or (process/'stat').read_bytes().split(b') ',1)[1].split()[19]!=before.split(b') ',1)[1].split()[19]: raise ValueError()
print(json.dumps({'process_alive':True,'effective_release':release}))
'''


def physical(agent, release, client):
    sys.path.insert(0, str(HERE))
    adapter = importlib.import_module("live_adapter")
    kind = agent.get("kind") or agent.get("runtime_mode")
    try:
        if kind == "container":
            before = adapter.before(agent)
            if before.get("release") != release:
                fail("PROBE_EFFECTIVE_RELEASE_MISMATCH")
            adapter.supervisor(agent, "check")
            if adapter.before(agent) != before:
                fail("PROBE_EFFECTIVE_RELEASE_CHANGED")
            return {"process_alive": True, "effective_release": release}
        if kind == "native":
            unit = agent.get("unit")
            if not isinstance(unit, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]+[.]service", unit):
                fail("PROBE_NATIVE_UNIT_REQUIRED")
            bundle = adapter.absolute(agent.get("bundle_root"))
            harness = agent.get("harness")
            if harness not in {"claude", "codex", "grok", "muse", "openclaw"}:
                fail("PROBE_HARNESS_REQUIRED")
            uid = agent.get("adapter_uid", agent.get("uid"))
            if not isinstance(uid, int) or isinstance(uid, bool) or uid < 0:
                fail("PROBE_NATIVE_UID_REQUIRED")
            value = json.loads(adapter.python(agent, NATIVE_PROOF, unit, bundle, release, harness, str(uid)))
            if value != {"process_alive": True, "effective_release": release}:
                fail("PROBE_NATIVE_PROCESS_UNVERIFIED")
            return value
        if kind == "fleet":
            operation_id = agent.get("fleet_operation_id") or os.environ.get("CAUCE_LIVE_ADAPTER_OPERATION_ID")
            if agent.get("fleet_source_prevalidated") is not True or not isinstance(operation_id, str) \
                    or not UUID4.fullmatch(operation_id):
                fail("PROBE_FLEET_PREVALIDATED_SOURCE_REQUIRED")
            fleet = importlib.import_module("live_adapter_fleet")
            proof = fleet.probe_fleet(agent, release, adapter.remote, client, operation_id)
            if proof.get("runtime_verified") is not True or proof.get("source", {}).get("ref") != release:
                fail("PROBE_FLEET_PROCESS_UNVERIFIED")
            instance = proof.get("expected_instance_id")
            if not isinstance(instance, str) or not instance:
                fail("PROBE_FLEET_INSTANCE_UNVERIFIED")
            return {"process_alive": True, "effective_release": release, "expected_instance_id": instance}
        fail("PROBE_RUNTIME_KIND_REQUIRED")
    except ProbeFailure:
        raise
    except HANDLED_ERRORS:
        fail("PROBE_CANONICAL_PROCESS_CHECK_FAILED")


def publish(client, tenant, room, alias, nonce):
    marker = "CAUCE_LIVE_" + nonce
    command = {"room_id": room, "recipients": [{"tenant_id": tenant, "alias": alias}],
               "body": {"text": "Responde únicamente " + marker},
               "lane": "interactive", "priority": 0}
    prepared = request(client, "POST", "/v3/console/publish-intents",
                       {**command, "intent_nonce": str(uuid.uuid4())})
    key = prepared.get("idempotency_key")
    if prepared.get("version") != 1 or not isinstance(key, str) or not 1 <= len(key) <= 200:
        fail("PROBE_PREPARED_INTENT_INVALID")
    if prepared.get("state") == "prepared" and prepared.get("receipt") is None:
        receipt = request(client, "POST", "/v3/console/messages", {**command, "idempotency_key": key})
    elif prepared.get("state") == "committed" and isinstance(prepared.get("receipt"), dict):
        receipt = prepared["receipt"]
    else:
        fail("PROBE_PREPARED_INTENT_INVALID")
    ids = receipt.get("delivery_ids")
    if receipt.get("idempotency_key") != key or not isinstance(receipt.get("message_id"), str) \
            or not UUID4.fullmatch(receipt["message_id"]) or not isinstance(ids, list) or len(ids) != 1 \
            or not isinstance(ids[0], str) or not UUID4.fullmatch(ids[0]) \
            or not isinstance(receipt.get("causal_hash"), str) or not HASH.fullmatch(receipt["causal_hash"]) \
            or not isinstance(receipt.get("request_hash"), str) or not HASH.fullmatch(receipt["request_hash"]):
        fail("PROBE_PUBLISH_RECEIPT_INVALID")
    confirmation = {"idempotency_key": key, "message_id": receipt["message_id"],
                    "causal_hash": receipt["causal_hash"]}
    confirmed = request(client, "POST", "/v3/console/publish-intents/confirm", confirmation)
    if confirmed != {"version": 1, "confirmed": True, **confirmation}:
        fail("PROBE_PUBLISH_CONFIRMATION_INVALID")
    return receipt["message_id"], ids[0], marker


def delivery(client, message_id, delivery_id, tenant, alias, marker):
    value = request(client, "GET", "/v3/console/messages/" + quote(message_id, safe=""))
    rows = value.get("deliveries")
    if value.get("id") != message_id or not isinstance(rows, list):
        fail("PROBE_MESSAGE_DETAIL_INVALID")
    matches = [row for row in rows if isinstance(row, dict) and row.get("delivery_id") == delivery_id
               and row.get("tenant_id") == tenant and row.get("alias") == alias]
    if len(matches) != 1:
        fail("PROBE_DELIVERY_IDENTITY_MISMATCH")
    row = matches[0]
    if row.get("status") in {"failed", "dead"}:
        fail("PROBE_REAL_DELIVERY_FAILED")
    if row.get("status") != "done":
        return False
    if row.get("reply") != marker:
        fail("PROBE_REPLY_NONCE_MISMATCH")
    return True


def run_probe(agent, alias, release, nonce, started_at, client, timeout_seconds=180,
              physical_check=physical):
    tenant, room = target(agent, alias)
    if not ALIAS.fullmatch(alias) or not RELEASE.fullmatch(release) or not NONCE.fullmatch(nonce):
        fail("PROBE_ARGUMENT_INVALID")
    start = timestamp(started_at)
    if start > time.time() + 30:
        fail("PROBE_START_TIME_IN_FUTURE")
    state = request(client, "GET", "/v3/auth/session")
    if state.get("authenticated") is not True:
        fail("PROBE_CONSOLE_SESSION_NOT_AUTHENTICATED")
    proof = physical_check(agent, release, client)
    if proof.get("process_alive") is not True or proof.get("effective_release") != release:
        fail("PROBE_EFFECTIVE_RELEASE_MISMATCH")
    deadline = time.monotonic() + timeout_seconds
    while not presence(client, tenant, alias, start, proof.get("expected_instance_id")):
        if time.monotonic() >= deadline:
            fail("PROBE_FRESH_LEASE_TIMEOUT")
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    message_id, delivery_id, marker = publish(client, tenant, room, alias, nonce)
    while not delivery(client, message_id, delivery_id, tenant, alias, marker):
        if time.monotonic() >= deadline:
            fail("PROBE_REAL_DELIVERY_TIMEOUT")
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    if not presence(client, tenant, alias, start, proof.get("expected_instance_id")):
        fail("PROBE_LEASE_NOT_VALID_AFTER_DELIVERY")
    final = physical_check(agent, release, client)
    if final != proof:
        fail("PROBE_PROCESS_CHANGED_DURING_ROUNDTRIP")
    # The SDK accepts delivery traffic only after hello_ack; the fresh heartbeat and exact done reply attest that path.
    return {"alias": alias, "release": release, "nonce": nonce, "process_alive": True,
            "effective_release": release, "hello_ack": True, "lease_valid": True,
            "delivery_done": True, "delivery_id": delivery_id}


def main():
    parser = ProbeArgumentParser(allow_abbrev=False)
    parser.add_argument("alias")
    parser.add_argument("release")
    parser.add_argument("nonce")
    args = parser.parse_args()
    try:
        raw = os.environ.get("CAUCE_LIVE_ADAPTER_AGENT", "")
        if not raw or len(raw) > 2_097_152:
            fail("PROBE_AGENT_MANIFEST_REQUIRED")
        agent = json.loads(raw)
        if not isinstance(agent, dict):
            fail("PROBE_AGENT_MANIFEST_REQUIRED")
        target(agent, args.alias)
        session_file = os.environ.get("CAUCE_LIVE_ADAPTER_SESSION_FILE")
        started_at = os.environ.get("CAUCE_LIVE_ADAPTER_STARTED_AT")
        if not session_file or not started_at:
            fail("PROBE_LOCAL_SESSION_AND_START_REQUIRED")
        timeout = int(os.environ.get("CAUCE_LIVE_ADAPTER_TIMEOUT_SECONDS", "180"))
        if not 1 <= timeout <= 900:
            fail("PROBE_TIMEOUT_INVALID")
        sys.path.insert(0, str(ROOT / "ops/cli"))
        from context_client import ConsoleSessionClient
        try:
            client = ConsoleSessionClient(session_file, os.environ.get("CAUCE_LIVE_ADAPTER_GATEWAY"),
                os.environ.get("CAUCE_LIVE_ADAPTER_ORIGIN"), os.environ.get("CAUCE_LIVE_ADAPTER_CA_FILE"))
        except HANDLED_ERRORS:
            fail("PROBE_LOCAL_CONSOLE_SESSION_UNAVAILABLE")
        print(json.dumps(run_probe(agent, args.alias, args.release, args.nonce, started_at, client, timeout),
                         sort_keys=True, separators=(",", ":")))
        return 0
    except ProbeFailure as error:
        print(str(error), file=sys.stderr)
    except HANDLED_ERRORS:
        print("PROBE_LOCAL_VALIDATION_OR_REQUEST_FAILED", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
