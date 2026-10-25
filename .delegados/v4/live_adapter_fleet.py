"""Update approved adapter bundles through the durable fleet coordinator."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys
import time
import uuid
from urllib.parse import urlencode

_REF = re.compile(r"[a-f0-9]{40}\Z")
_TERMINAL = {"succeeded", "failed", "cancelled"}
_STATES = _TERMINAL | {"queued", "running", "awaiting_auth", "cancelling"}
_STEPS = {"prepare", "artifacts", "credentials", "runtime", "authenticate", "profile",
          "verify", "admission", "fence", "stop", "revoke", "purge"}
_STEP_STATES = {"pending", "running", "waiting", "succeeded", "failed", "compensated"}
_PREREQUISITE = (
    "Install and activate the reviewed fleet-controller-upgrade or signed host release for the requested ref; "
    "the update API cannot select a bundle or replace the executor policy."
)


class FleetReceiptError(ValueError):
    """The remote envelope does not satisfy the fleet receipt contract."""


_REMOTE = r'''
import hashlib,json,os,pathlib,pwd,re,shlex,stat,subprocess,sys
packet=json.load(sys.stdin);agent=packet['agent']
def fail(code): raise ValueError(code)
def regular(filename):
 path=pathlib.Path(filename)
 if not path.is_absolute() or path.is_symlink(): fail('FLEET_SOURCE_PATH_INVALID')
 info=path.stat()
 if not stat.S_ISREG(info.st_mode) or info.st_mode&0o022 or info.st_size>2097152: fail('FLEET_SOURCE_FILE_INVALID')
 return path
def source():
 from fleet_executor_policy import load_policy
 from cauce_container_base import bundle_digest
 root=pathlib.Path(agent['runtime_root']).resolve()
 manifest=json.loads(regular(agent['fleet_release_manifest']).read_text())
 if manifest.get('revision')!=packet['ref']: fail('FLEET_HOST_KIT_REF_MISMATCH')
 policy=load_policy(regular(agent['policy_file']))
 bundle=policy['bundles'].get(agent['harness'])
 if not isinstance(bundle,dict): fail('FLEET_HARNESS_BUNDLE_UNAPPROVED')
 directory=pathlib.Path(bundle['directory']).resolve()
 if not directory.is_relative_to(root) or not directory.is_dir(): fail('FLEET_INSTALLED_BUNDLE_OUTSIDE_KIT')
 actual=bundle_digest(str(directory))
 if actual!=bundle.get('digest') or actual!=manifest.get('pins',{}).get('adapter_digest'): fail('FLEET_APPROVED_BUNDLE_DIFFERS_FROM_REF')
 unit=agent['fleet_executor_unit']
 if not re.fullmatch(r'[A-Za-z0-9_.@-]+[.]service',unit): fail('FLEET_EXECUTOR_UNIT_INVALID')
 env={'PATH':'/usr/bin:/bin','HOME':pwd.getpwuid(os.geteuid()).pw_dir,'XDG_RUNTIME_DIR':'/run/user/'+str(os.geteuid())}
 env['DBUS_SESSION_BUS_ADDRESS']='unix:path='+env['XDG_RUNTIME_DIR']+'/bus'
 result=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property=ExecStart,Environment,NeedDaemonReload,ActiveState'],capture_output=True,text=True,timeout=30,env=env)
 values=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
 if result.returncode or values.get('ActiveState')!='active' or values.get('NeedDaemonReload')!='no': fail('FLEET_EXECUTOR_NOT_ACTIVE_ON_REVIEWED_UNIT')
 selectors=dict(item.split('=',1) for item in shlex.split(values.get('Environment','')) if '=' in item)
 if str(root) not in values.get('ExecStart','') or selectors.get('CAUCE_FLEET_POLICY_FILE')!=agent['policy_file'] or selectors.get('CAUCE_FLEET_PROJECT_ROOT')!=str(root) or selectors.get('CAUCE_FLEET_EXECUTABLE')!=str(root/'ops/cli/fleet-executor.py'): fail('FLEET_EXECUTOR_POLICY_NOT_EFFECTIVE')
 return {'ref':packet['ref'],'runtime_root':str(root),'policy_file':agent['policy_file'],'policy_sha256':hashlib.sha256(pathlib.Path(agent['policy_file']).read_bytes()).hexdigest(),'bundle_directory':str(directory),'bundle_digest':actual,'host_id':policy['host_id'],'unit':unit}
def run():
 sys.path[:0]=[str(pathlib.Path(agent['ops_root'])/'cli'),str(pathlib.Path(agent['ops_root'])/'container-runtime')]
 evidence=source()
 if packet['action']=='source': return evidence
 if packet['action']!='verify': fail('FLEET_ACTION_UNSUPPORTED')
 from fleet_executor_policy import approve_agent,load_policy
 from fleet_executor_runtime import approved_bundle,native_identity,native_proof,sdk_environment
 policy=load_policy(pathlib.Path(agent['policy_file']));params=packet['parameters'];placement=params['placement']
 raw={**params,**{key:value for key,value in placement.items() if key!='mode'},'tenant_id':agent['tenant_id'],'alias':agent['alias'],'runtime_mode':placement['mode']}
 checked=approve_agent(policy,raw);bundle=approved_bundle(policy,checked)
 if placement['mode']=='native':
  proof=native_proof(policy,checked,native_identity(policy,checked),bundle,bootstrap=False,operation_id=packet['operation_id'])
 else:
  from fleet_executor_container import inspect_container,identity_for,process_proof
  observed=inspect_container(checked['container_name'])
  if observed is None: fail('FLEET_RUNTIME_NOT_OBSERVED')
  proof=process_proof(policy,checked,identity_for(checked,observed),bundle,bootstrap=False,operation_id=packet['operation_id'])
 if proof is None: fail('FLEET_RUNTIME_UNVERIFIED')
 expected=sdk_environment(policy,checked,False,packet['operation_id'])['CAUCE_INSTANCE_ID']
 return {'source':evidence,'runtime_verified':True,'expected_instance_id':expected}
try:
 print(json.dumps({'ok':True,'value':run()},sort_keys=True,separators=(',',':')))
except Exception as error:
 code=str(error) if isinstance(error,ValueError) and re.fullmatch(r'FLEET_[A-Z_]+',str(error)) else 'FLEET_CANONICAL_PHYSICAL_PROBE_FAILED'
 print(json.dumps({'ok':False,'code':code},sort_keys=True))
'''


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def _target(agent):
    return {"resource": "agent", "tenant_id": agent["tenant_id"], "alias": agent["alias"]}


def _blocked(agent, ref, code):
    return {"strategy": "fleet", "alias": agent.get("alias"), "ref": ref,
            "ready": False, "status": "blocked", "blockers": [code],
            "prerequisites": [_PREREQUISITE]}


def _client(agent):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "ops/cli"))
    from context_client import ConsoleSessionClient
    try:
        return ConsoleSessionClient(agent["fleet_session_file"], agent.get("fleet_gateway"),
                                    agent.get("fleet_origin"), agent.get("fleet_ca_file"))
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, ImportError, AttributeError):
        raise ValueError("FLEET_LOCAL_CONSOLE_SESSION_UNAVAILABLE") from None


def _request(client, method, path, body=None):
    try:
        return client.request(method, path, body)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, ImportError, AttributeError):
        raise ValueError("FLEET_CONSOLE_REQUEST_REJECTED_OR_UNAVAILABLE") from None


def _physical(agent, ref, remote, action, **payload):
    fields = ("ops_root", "runtime_root", "tenant_id", "alias", "harness", "policy_file",
              "fleet_release_manifest", "fleet_executor_unit")
    packet = {"agent": {key: agent[key] for key in fields}, "ref": ref, "action": action, **payload}
    try:
        raw = remote(agent, [agent.get("python", "/usr/bin/python3"), "-I", "-B", "-c", _REMOTE],
                     json.dumps(packet, separators=(",", ":")))
        reply = json.loads(raw)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, ImportError, AttributeError):
        raise ValueError("FLEET_REMOTE_RESULT_UNVERIFIED") from None
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        code = reply.get("code") if isinstance(reply, dict) else None
        raise ValueError(code if isinstance(code, str) and re.fullmatch(r"FLEET_[A-Z_]+", code)
                         else "FLEET_REMOTE_RESULT_UNVERIFIED")
    if not isinstance(reply.get("value"), dict):
        raise FleetReceiptError("FLEET_REMOTE_RESULT_UNVERIFIED")
    return reply["value"]


def _snapshot(agent, client):
    value = _request(client, "GET", "/v3/console/config")
    rows = [row for row in value.get("agents", [])
            if row.get("tenant_id") == agent["tenant_id"] and row.get("alias") == agent["alias"]]
    if len(rows) != 1:
        raise ValueError("FLEET_AGENT_IDENTITY_AMBIGUOUS")
    row = rows[0]
    if row.get("harness_id") != agent["harness"]:
        raise ValueError("FLEET_HARNESS_CHANGED")
    placement = row.get("placement") if isinstance(row.get("placement"), dict) else row
    mode = placement.get("mode", placement.get("runtime_mode"))
    if mode not in {"native", "container"}:
        raise ValueError("FLEET_PLACEMENT_UNMEASURED")
    physical = {key: placement.get(key) for key in
                ("host_id", "runtime_user", "home_directory", "state_directory")}
    physical["mode"] = mode
    for key in ("container_name", "systemd_user"):
        if placement.get(key) is not None:
            physical[key] = placement[key]
    memberships = [{key: item[key] for key in ("room_id", "role", "enabled") if key in item}
                   for item in value.get("memberships", []) if item.get("tenant_id") == agent["tenant_id"]
                   and item.get("alias", item.get("agent_alias")) == agent["alias"]]
    params = {"runtime_key": row.get("runtime_key"), "harness_id": row["harness_id"],
              "primary_room_id": row.get("primary_room_id"), "memberships": memberships, "placement": physical}
    for key in ("display_name", "primary_account_id", "model_id", "reasoning_effort", "extensions"):
        if key in row:
            params[key] = row[key]
    if not params["runtime_key"] or not params["primary_room_id"] or not memberships:
        raise ValueError("FLEET_DECLARATIVE_SNAPSHOT_INCOMPLETE")
    activity = _request(client, "GET", "/v3/console/activity")
    present = [item.get("presence", {}) for item in activity.get("agents", [])
               if item.get("tenant_id") == agent["tenant_id"] and item.get("alias") == agent["alias"]]
    keys = ("online", "instance_id", "epoch", "last_heartbeat_at", "lease_until")
    presence = {key: present[0].get(key) for key in keys} if len(present) == 1 else {}
    return {"revision": value["revision"], "parameters": params, "presence": presence}


def _operation(agent, value, operation_id=None):
    if value.get("target") != _target(agent) or value.get("kind") != "update":
        raise ValueError("FLEET_OPERATION_IDENTITY_CHANGED")
    if value.get("status") not in _STATES or operation_id and value.get("id") != operation_id:
        raise ValueError("FLEET_OPERATION_RECEIPT_MISMATCH")
    result = {key: value.get(key) for key in
              ("id", "status", "version", "expected_revision", "applied_revision", "request_sha256")}
    result["steps"] = []
    for step in value.get("steps", []):
        if step.get("name") not in _STEPS or step.get("status") not in _STEP_STATES:
            raise ValueError("FLEET_OPERATION_STEP_INVALID")
        result["steps"].append({"name": step["name"], "status": step["status"]})
    return result


def probe_fleet(agent, ref, remote, client, operation_id) -> dict:
    observed = _snapshot(agent, client)
    proof = _physical(agent, ref, remote, "verify", parameters=observed["parameters"], operation_id=operation_id)
    if not observed["presence"].get("online") or observed["presence"].get("instance_id") != proof.get("expected_instance_id"):
        raise ValueError("FLEET_RUNTIME_OR_LEASE_UNVERIFIED")
    return proof


def plan_fleet(agent, ref, remote) -> dict:
    if not isinstance(ref, str) or not _REF.fullmatch(ref):
        return _blocked(agent, ref, "FLEET_EXACT_REF_REQUIRED")
    required = ("ops_root", "runtime_root", "tenant_id", "alias", "harness", "policy_file",
                "fleet_session_file", "fleet_release_manifest", "fleet_executor_unit")
    missing = [field for field in required if not agent.get(field)]
    if missing:
        result = _blocked(agent, ref, "FLEET_CANONICAL_PREREQUISITES_MISSING")
        result["missing_fields"] = missing
        return result
    try:
        source = _physical(agent, ref, remote, "source")
        connection = _client(agent)
        before = _snapshot(agent, connection)
        if before["parameters"]["placement"]["host_id"] != source["host_id"]:
            raise ValueError("FLEET_POLICY_HOST_DIFFERS")
        request = {"kind": "update", "target": _target(agent), "expected_revision": before["revision"],
                   "idempotency_key": "adapter_live_" + uuid.uuid4().hex, "parameters": before["parameters"]}
        preview = None
        if agent.get("_simulation") is not True:
            preview = _request(connection, "POST", "/v3/console/fleet/operations/preview", request)
            if preview.get("request_sha256") != _hash(request) or preview.get("target") != _target(agent) \
                    or preview.get("expected_revision") != before["revision"] or preview.get("kind") != "update":
                raise ValueError("FLEET_PREVIEW_RECEIPT_MISMATCH")
        query = urlencode(_target(agent))
        history = _request(connection, "GET", "/v3/console/fleet/operations?" + query)
        active = [row for row in history.get("operations", []) if row.get("status") not in _TERMINAL]
    except ValueError as error:
        return _blocked(agent, ref, str(error))
    blockers = []
    if active:
        blockers.append("FLEET_EXISTING_OPERATION_MUST_SETTLE")
    if preview is not None and (preview.get("can_apply") is not True or any(
            item.get("blocking") is True for item in preview.get("dependencies", []))):
        blockers.append("FLEET_PREVIEW_BLOCKED")
    public = {"strategy": "fleet", "alias": agent["alias"], "ref": ref, "ready": not blockers,
              "ready_source": True, "preview_required": preview is None, "blockers": blockers,
              "prerequisites": [_PREREQUISITE], "source": source,
              "status": "blocked" if blockers else "source_verified" if preview is None else "planned"}
    if agent.get("_simulation") is True:
        return public
    return {**public, "before": before, "request": request, "preview": preview}


def apply_fleet(agent, ref, remote, checkpoint) -> dict:
    agent = {**agent, "_simulation": False}
    plan = plan_fleet(agent, ref, remote)
    if not plan["ready"]:
        return plan
    record = {"strategy": "fleet", "alias": agent["alias"], "ref": ref, "status": "submitting",
              "before": plan["before"], "source": plan["source"], "request": plan["request"],
              "previous_ref": agent.get("current_ref"), "blockers": []}
    checkpoint(record)
    try:
        connection = _client(agent)
        if _physical(agent, ref, remote, "source") != plan["source"]:
            record.update(status="blocked", blockers=["FLEET_SOURCE_CHANGED_AFTER_PREVIEW"])
            checkpoint(record)
            return record
        receipt = _request(connection, "POST", "/v3/console/fleet/operations", plan["request"])
        operation = _operation(agent, receipt["operation"])
        if receipt.get("operation_id") != operation["id"] or operation["request_sha256"] != _hash(plan["request"]):
            raise ValueError("FLEET_SUBMISSION_RECEIPT_MISMATCH")
        record.update(operation_id=operation["id"], status=operation["status"], operation=operation)
        checkpoint(record)
        deadline = time.monotonic() + min(600, max(1, int(agent.get("fleet_timeout_seconds", 180))))
        while operation["status"] not in _TERMINAL and operation["status"] != "awaiting_auth" and time.monotonic() < deadline:
            time.sleep(min(2, max(0, deadline - time.monotonic())))
            observed = _operation(agent, _request(connection, "GET",
                "/v3/console/fleet/operations/" + operation["id"]), operation["id"])
            if observed["request_sha256"] != operation["request_sha256"] or observed["version"] < operation["version"]:
                raise ValueError("FLEET_OPERATION_RECEIPT_MISMATCH")
            operation = observed
            record.update(status=operation["status"], operation=operation)
            checkpoint(record)
        unsettled = any(step["status"] in {"running", "waiting"} for step in operation["steps"])
        if operation["status"] not in _TERMINAL or unsettled:
            record.update(status="pending", blockers=["FLEET_AUTHENTICATION_REQUIRED" if operation["status"] == "awaiting_auth"
                                                     else "FLEET_OPERATION_SETTLE_PENDING"])
        elif operation["status"] != "succeeded":
            record.update(status="failed", blockers=["FLEET_COORDINATOR_OPERATION_FAILED"])
        else:
            steps = {step["name"]: step for step in operation["steps"]}
            if any(steps.get(name, {}).get("status") != "succeeded" for name in ("verify", "admission")):
                raise ValueError("FLEET_FUNCTIONAL_VERIFICATION_INCOMPLETE")
            after = _snapshot(agent, connection)
            proof = _physical(agent, ref, remote, "verify", parameters=after["parameters"], operation_id=operation["id"])
            if proof["source"] != plan["source"]:
                raise ValueError("FLEET_SOURCE_CHANGED_AFTER_UPDATE")
            if not after["presence"].get("online") or after["presence"].get("instance_id") != proof.get("expected_instance_id"):
                raise ValueError("FLEET_RUNTIME_OR_LEASE_UNVERIFIED")
            record.update(status="succeeded", after=after, runtime_verified=True, normal_delivery_verification_required=True)
    except ValueError as error:
        record.update(status="pending", blockers=[str(error)], submission_state_unknown=not bool(record.get("operation_id")))
    checkpoint(record)
    return record


def rollback_fleet(agent, previous, remote, checkpoint) -> dict:
    operation_id = previous.get("operation_id")
    if previous.get("submission_state_unknown") or previous.get("status") in {"pending", "submitting"} and not operation_id:
        return _blocked(agent, previous.get("previous_ref"), "FLEET_SUBMISSION_SETTLE_PENDING")
    saved = previous.get("before", previous)
    ref = previous.get("previous_ref") or saved.get("ref") or saved.get("current_ref")
    if not isinstance(ref, str) or not _REF.fullmatch(ref) or ref == previous.get("ref"):
        return _blocked(agent, ref, "FLEET_PREVIOUS_SOURCE_REFERENCE_REQUIRED")
    if operation_id:
        try:
            current = _operation(agent, _request(_client(agent), "GET",
                                 "/v3/console/fleet/operations/" + operation_id), operation_id)
        except ValueError as error:
            return _blocked(agent, ref, str(error))
        if current["status"] not in _TERMINAL or any(step["status"] in {"running", "waiting"} for step in current["steps"]):
            return _blocked(agent, ref, "FLEET_OPERATION_SETTLE_PENDING")
    plan = plan_fleet(agent, ref, remote)
    if not plan["ready"]:
        return {**plan, "rollback_requires": "Restore the previous signed host kit and approved executor policy through their canonical installer first."}
    if agent.get("_simulation") is True:
        return {**plan, "rollback": True}
    if plan["before"].get("parameters") != saved.get("parameters"):
        return _blocked(agent, ref, "FLEET_ROLLBACK_CONFIGURATION_CHANGED")
    checkpoint({"strategy": "fleet", "alias": agent["alias"], "status": "rollback_prepared", "ref": ref})
    return apply_fleet(agent, ref, remote, checkpoint)
