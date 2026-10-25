from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid

from fleet_executor_policy import SafeFailure, approve_agent

RETENTION = 'retain-until-verified-copy'
REQUIRED_PROOF = ('provider_verified', 'profile_verified', 'bootstrap_verified', 'roundtrip_verified')


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def container_pin(observed: dict) -> dict:
    identity = observed.get('Id')
    if not isinstance(identity, str) or re.fullmatch(r'[a-f0-9]{64}', identity) is None:
        raise SafeFailure('replacement container has no immutable identity')
    return {'container_id': identity, 'created_at': observed['Created'], 'started_at': observed['State']['StartedAt'],
            'image_id': observed['Image'], 'configuration_sha256': fingerprint({**{key: observed[key]
                for key in ('Name', 'Created', 'Image', 'Config', 'HostConfig')},
                # docker inspect lists mounts in a different order on each call.
                'Mounts': sorted(observed['Mounts'], key=lambda mount: (mount.get('Destination', ''), mount.get('Source', '')))})}


def volume_pins(policy: dict, agent: dict) -> list[dict]:
    from fleet_executor_container import docker, owned_volumes
    expected, existing = owned_volumes(policy, agent)
    rows = []
    for name, labels in sorted(expected.items()):
        if name not in existing:
            raise SafeFailure('replacement persistent volume is unavailable')
        observed = json.loads(docker('volume', 'inspect', name))
        if len(observed) != 1 or any((observed[0].get('Labels') or {}).get(key) != value for key, value in labels.items()):
            raise SafeFailure('replacement persistent volume ownership changed')
        rows.append({'name': name, 'created_at': observed[0].get('CreatedAt'),
                     'identity_sha256': fingerprint(observed[0])})
    return rows


def approved_observation(policy: dict, previous: dict) -> tuple[dict, dict | None]:
    from fleet_executor_container import inspect_container, validate_container
    from fleet_executor_image import previous_agent
    agent = approve_agent(policy, previous)
    if agent['runtime_mode'] != 'container' or agent['_placement'].get('ownership') == 'shared':
        raise SafeFailure('replacement retirement requires a dedicated container')
    observed = inspect_container(agent['container_name'])
    if observed is not None:
        validate_container(policy, previous_agent(agent, observed['Image']), observed, teardown=True)
    return agent, observed


def capture_previous(policy: dict, previous: dict) -> dict:
    agent, observed = approved_observation(policy, previous)
    if observed is None:
        raise SafeFailure('replacement requires an observed original container')
    return {'version': 1, 'name': agent['container_name'], 'tenant_id': agent['tenant_id'], 'alias': agent['alias'],
            'runtime_key': agent['runtime_key'], 'host_id': policy['host_id'], 'owner': policy['executor_user'],
            'previous': container_pin(observed), 'volumes': volume_pins(policy, agent),
            'retention': RETENTION, 'retention_reason': 'previous-harness-sessions-and-space-not-copied'}


def assert_previous(policy: dict, previous: dict, receipt: dict) -> tuple[dict, dict | None]:
    from fleet_executor_container import docker
    agent, observed = approved_observation(policy, previous)
    expected = {'version': 1, 'name': agent['container_name'], 'tenant_id': agent['tenant_id'], 'alias': agent['alias'],
                'runtime_key': agent['runtime_key'], 'host_id': policy['host_id'], 'owner': policy['executor_user'],
                'retention': RETENTION, 'retention_reason': 'previous-harness-sessions-and-space-not-copied'}
    if not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in expected.items()):
        raise SafeFailure('replacement retirement receipt differs from the approved owner')
    pin = receipt.get('previous')
    if not isinstance(pin, dict) or not isinstance(pin.get('container_id'), str) \
            or re.fullmatch(r'[a-f0-9]{64}', pin['container_id']) is None:
        raise SafeFailure('replacement retirement lacks its original identity pin')
    if volume_pins(policy, agent) != receipt.get('volumes'):
        raise SafeFailure('replacement persistent volume identity changed')
    if observed is None:
        if docker('ps', '-a', '-q', '--no-trunc', '--filter', 'id=' + pin['container_id']).strip():
            raise SafeFailure('replacement original container changed its approved name')
    elif container_pin(observed) != pin:
        raise SafeFailure('replacement original container identity changed')
    return agent, observed


def authorize_replacement(policy: dict, desired: dict, receipt: dict, proof: dict) -> dict:
    from fleet_executor_container import (
        adapter_restart_state,
        identity_for,
        inspect_container,
        process_proof,
        validate_container,
    )
    from fleet_executor_runtime import approved_bundle
    if not isinstance(proof, dict) or any(proof.get(field) is not True for field in REQUIRED_PROOF):
        raise SafeFailure('replacement retirement requires a verified normal nonce roundtrip')
    operation = proof.get('operation_id')
    try:
        if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
            raise ValueError
    except ValueError:
        raise SafeFailure('replacement verification has no exact operation identity') from None
    agent = approve_agent(policy, desired)
    if agent['runtime_mode'] != 'container' or agent['_placement'].get('ownership') == 'shared' \
            or agent['container_name'] == receipt.get('name') \
            or any(agent.get(key) != receipt.get(key) for key in ('tenant_id', 'alias', 'runtime_key', 'host_id')):
        raise SafeFailure('replacement differs from its original runtime identity')
    observed = inspect_container(agent['container_name'])
    if observed is None or not observed['State']['Running']:
        raise SafeFailure('replacement normal runtime is unavailable')
    validate_container(policy, agent, observed)
    state = adapter_restart_state(policy, agent, observed)
    if state.get('adapter_running') is not True or state.get('adapter_bootstrap') is not False:
        raise SafeFailure('replacement has no live normal adapter')
    if state.get('adapter_operation_id') != operation:
        raise SafeFailure('replacement adapter belongs to another verified operation')
    runtime = process_proof(policy, agent, identity_for(agent, observed), approved_bundle(policy, agent), bootstrap=False,
                            operation_id=operation)['runtime_digest']
    if 'runtime_digest' in proof and proof['runtime_digest'] != runtime:
        raise SafeFailure('replacement runtime differs from its normal verification')
    result = copy.deepcopy(receipt)
    result['replacement'] = {'agent': {key: value for key, value in desired.items() if not key.startswith('_')},
                             'pin': container_pin(observed), 'normal_verified': True,
                             'operation_id': operation, 'runtime_digest': runtime}
    return result


def retire_replaced(policy: dict, previous: dict, receipt: dict | None = None, *, apply: bool = False) -> dict:
    from fleet_executor_container import docker
    if receipt is None:
        if apply:
            raise SafeFailure('replacement retirement requires a persisted identity receipt')
        return capture_previous(policy, previous)
    _, observed = assert_previous(policy, previous, receipt)
    replacement = receipt.get('replacement')
    if not isinstance(replacement, dict) or replacement.get('normal_verified') is not True:
        if apply:
            raise SafeFailure('replacement retirement lacks normal runtime verification')
        return copy.deepcopy(receipt)
    proof = {**{field: True for field in REQUIRED_PROOF}, 'operation_id': replacement.get('operation_id'),
             'runtime_digest': replacement.get('runtime_digest')}
    renewed = authorize_replacement(policy, replacement['agent'], receipt, proof)
    if renewed['replacement'] != replacement:
        raise SafeFailure('replacement runtime changed after normal verification')
    if not apply:
        return renewed
    expected_commit = {'operation_id': replacement['operation_id'], 'status': 'succeeded',
                       'runtime_digest': replacement['runtime_digest'],
                       'container_id': replacement['pin']['container_id'], 'started_at': replacement['pin']['started_at']}
    if receipt.get('confirmed_operation') != expected_commit:
        raise SafeFailure('replacement retirement requires its confirmed operation and runtime identity')
    identity = receipt['previous']['container_id']
    if observed is not None:
        from fleet_executor_image import assert_no_login, image_guard
        with image_guard(identity):
            agent, current = assert_previous(policy, previous, receipt)
            if current is None:
                raise SafeFailure('replacement original disappeared before its guarded retirement')
            assert_no_login(agent, current)
            if observed['State']['Running']:
                docker('stop', '--time', '15', identity)
            _, stopped = assert_previous(policy, previous, receipt)
            if stopped is None or stopped['State']['Running'] or stopped['State'].get('Pid') != 0:
                raise SafeFailure('replacement original container stop is unverified')
            docker('rm', identity)
    _, remaining = assert_previous(policy, previous, receipt)
    if remaining is not None:
        raise SafeFailure('replacement original container removal is unverified')
    result = copy.deepcopy(receipt)
    result['removed'] = [{'type': 'container', 'name': receipt['name']}]
    result['complete'] = True
    return result


def capture_update(executor) -> None:
    from fleet_migration import placement_role
    context = executor.context
    if context['request']['kind'] != 'update' or context['request']['target']['resource'] != 'agent' \
            or placement_role(context) is not None:
        return
    previous = context['previous_agents']
    desired = executor.agent()
    if len(previous) != 1 or previous[0].get('runtime_mode') != 'container' or desired['runtime_mode'] != 'container' \
            or previous[0].get('container_name') == desired['container_name']:
        return
    agent = approve_agent(executor.policy, previous[0])
    if agent['_placement'].get('ownership') == 'shared':
        return
    if any(agent.get(key) != desired.get(key) for key in ('tenant_id', 'alias', 'runtime_key', 'host_id')):
        raise SafeFailure('replacement update changed its original durable identity')
    receipt = executor.journal.get('replacement_retirement')
    if receipt is None:
        executor.journal['replacement_retirement'] = capture_previous(executor.policy, agent)
        executor.save()
    else:
        assert_previous(executor.policy, agent, receipt)


def record_normal_verification(executor, agent: dict, normal: dict, runtime_digest: str) -> None:
    receipt = executor.journal.get('replacement_retirement')
    if receipt is None:
        return
    receipt = authorize_replacement(executor.policy, agent, receipt,
                                    {**normal, 'operation_id': executor.context['operation_id'], 'runtime_digest': runtime_digest})
    executor.journal['replacement_retirement'] = receipt
    executor.journal['admission_normal_proof'] = {**{field: True for field in REQUIRED_PROOF},
        'operation_id': executor.context['operation_id'], 'runtime_digest': receipt['replacement']['runtime_digest']}
