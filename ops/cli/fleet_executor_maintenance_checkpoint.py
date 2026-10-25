from __future__ import annotations

import hashlib
import re

from fleet_executor_policy import SafeFailure, approve_agent, target_agent

SHA = re.compile(r'[a-f0-9]{64}')


def stored_receipt(entry: dict, value: dict) -> dict:
    try:
        pin = entry['original']['previous']
        state = entry['adapter_state']
        if entry['phase'] != 'captured' or entry['snapshot_sha256'] != value['snapshot_sha256'] \
                or entry['original_container_id'] != pin['container_id'] \
                or state.get('adapter_running') is not True or state.get('adapter_bootstrap') is not False \
                or not isinstance(pin['started_at'], str) or not 1 <= len(pin['started_at']) <= 128 \
                or any(not isinstance(entry[key], str) or SHA.fullmatch(entry[key]) is None
                       for key in ('snapshot_sha256', 'original_container_id', 'checkpoint_sha256',
                                   'normal_certificate_sha256', 'normal_token_sha256')):
            raise ValueError
        return {**{key: entry[key] for key in ('snapshot_sha256', 'original_container_id', 'checkpoint_sha256')},
                'generation': hashlib.sha256((pin['container_id'] + '\0' + pin['started_at']).encode()).hexdigest()}
    except (KeyError, TypeError, ValueError, AttributeError):
        raise SafeFailure('replacement authority unverified') from None


def checkpoint(policy: dict, context: dict, *, require_existing: bool = False) -> dict:
    from fleet_executor_authority import call, inventory, scope_for
    from fleet_executor_replacement_rollback import capture, restoration, snapshot
    from fleet_executor_steps import Executor, executor_lock
    request = context['request']
    if request['kind'] != 'update' or request['target']['resource'] != 'agent' \
            or request['parameters']['placement']['mode'] != 'container' \
            or context.get('fleet_scope', {}).get('placement_role') is not None \
            or context.get('restore_previous_runtime') is not None or not restoration(context) \
            or 'identity_directory' not in policy.get('authority', {}):
        raise SafeFailure('maintenance checkpoint requires a prepared container update')
    value = snapshot(context)
    agent = approve_agent(policy, target_agent(context))
    scope = scope_for(policy, context, agent)
    with executor_lock(policy):
        executor = Executor(policy, context)
        existing = executor.journal.get('replacement_compensation')
        if existing is None:
            if require_existing:
                raise SafeFailure('replacement authority unverified')
            capture(executor)
        entry = executor.journal.get('replacement_compensation')
        receipt = stored_receipt(entry, value)
        if existing is not None:
            inventory(call(policy['authority'], scope, 'inventory'), agent)
        return receipt
