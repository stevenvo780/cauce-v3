#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import signal
import sys

from fleet_executor_hooks import binding_for, container_binding
from fleet_executor_image import image_operation
from fleet_executor_policy import SafeFailure, approve_agent, load_policy, target_agent, validate_payload
from fleet_executor_steps import executor_lock, perform

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from update_alias_lib import SafeArgumentParser

FAILURE_REASONS = {
    'running runtime has another SDK identity or transport': 'runtime_identity_mismatch',
    'running runtime has another credential namespace': 'runtime_identity_mismatch',
    'container process identity differs': 'runtime_identity_mismatch',
    'runtime lifecycle identity differs': 'runtime_identity_mismatch',
    'container isolation differs from the approved shape': 'runtime_security_mismatch',
    'container GPU or device access differs from the approved shape': 'runtime_security_mismatch',
    'container image or ownership labels differ': 'runtime_security_mismatch',
    'approved runtime bundle or executable changed': 'runtime_bundle_changed',
    'approved harness descriptor changed': 'runtime_bundle_changed',
    'container runtime executable hash differs': 'runtime_bundle_changed',
    'native systemd unit has not remained stopped': 'runtime_stop_unverified',
    'stopped state is not observed': 'runtime_stop_unverified',
    'functional hook has not demonstrated its effect': 'provider_functional_proof_failed',
    'functional proof identity or nonce differs': 'provider_functional_proof_failed',
}


def fleet_failure_reason(error: SafeFailure) -> str | None:
    from fleet_executor_recovery import failure_reason
    from harness_operations import HarnessOperationFailure
    if type(error) is SafeFailure and str(error) == 'fleet descriptor is unavailable' \
            and type(error.__context__) is HarnessOperationFailure \
            and str(error.__context__) == 'bundle digest: approved bundle changed':
        return 'runtime_bundle_changed'
    return failure_reason(error) or FAILURE_REASONS.get(str(error))


def cancelled(_signal, _frame):
    raise SafeFailure('fleet effect cancelled')


def approved_binding(policy: dict, context: dict, *, prepare_login: bool = False) -> dict:
    agent = approve_agent(policy, target_agent(context))
    if prepare_login and agent['runtime_mode'] == 'container':
        from fleet_executor_container import observe_container
        observe_container(policy, agent)
    _account, profile = binding_for(policy, agent)
    receipt = {'agent': {key: value for key, value in agent.items() if not key.startswith('_')},
               'profile_binding': profile}
    if agent['runtime_mode'] == 'container':
        agent, identity = container_binding(policy, agent)
        receipt['runtime_binding'] = {key: identity[key] for key in ('container_id', 'generation')}
        receipt['runtime_binding']['generation'] = identity['login_generation']
        receipt['runtime_binding'].update(image_digest=agent['_placement']['image'],
            python=agent['_placement']['python'], helper='/cauce/executor/provider-login.py')
        if prepare_login:
            from provider_login_container import reserve_runtime
            reserve_runtime(receipt['runtime_binding'], context['operation_id'])
    return receipt


def main() -> int:
    parser = SafeArgumentParser(description='Execute one bounded physical fleet effect')
    parser.add_argument('--policy', type=pathlib.Path, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--binding', action='store_true')
    action.add_argument('--recovery-preview', action='store_true')
    action.add_argument('--recovery-preflight', action='store_true')
    parser.add_argument('--prepare-login', action='store_true')
    action.add_argument('--capabilities', action='store_true')
    action.add_argument('--quota', action='store_true')
    action.add_argument('--quota-auth-verify', action='store_true')
    action.add_argument('--step', choices=('prepare', 'artifacts', 'credentials', 'runtime', 'authenticate',
        'profile', 'verify', 'admission', 'fence', 'stop', 'revoke', 'purge', 'compensate', 'login-stop'))
    args = parser.parse_args()
    if args.prepare_login and not args.binding:
        raise SafeFailure('login preparation requires a binding request')
    policy = load_policy(args.policy)
    if args.capabilities:
        from fleet_executor_templates import capabilities
        receipt = capabilities(policy)
        if 'quota_environments' in policy:
            from quota_runtime import capabilities as quota_capabilities
            receipt['quota_environments'] = quota_capabilities(policy)
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
        return 0
    encoded = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(encoded) > 1024 * 1024:
        raise SafeFailure('execution payload exceeds its limit')
    for termination in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(termination, cancelled)
    if args.quota or args.quota_auth_verify:
        from quota_runtime import perform as quota_perform
        from quota_runtime import verify_authentication
        receipt = (verify_authentication if args.quota_auth_verify else quota_perform)(policy, json.loads(encoded))
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
        return 0
    if args.recovery_preflight:
        from fleet_executor_recovery import preflight as recovery_preflight
        with executor_lock(policy):
            receipt = recovery_preflight(policy, json.loads(encoded))
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
        return 0
    context = validate_payload(json.loads(encoded))
    if args.recovery_preview:
        from fleet_executor_recovery import preview as recovery_preview
        if context['request']['kind'] != 'recover':
            raise SafeFailure('recovery preview requires an exact recovery request')
        with executor_lock(policy):
            receipt = recovery_preview(policy, context)
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
        return 0
    with image_operation(context['operation_id'], legacy_target=context['request']['target']['resource'] == 'agent'):
        if args.binding:
            agent = approve_agent(policy, target_agent(context))
            if args.prepare_login and agent['runtime_mode'] == 'container':
                with executor_lock(policy):
                    receipt = approved_binding(policy, context, prepare_login=True)
            else:
                receipt = approved_binding(policy, context)
        else:
            receipt = perform(policy, context, args.step)
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SafeFailure as error:
        from fleet_executor_recovery import failure_reason
        reason = fleet_failure_reason(error)
        if reason is not None:
            print('CAUCE_FLEET_FAILURE=' + reason, file=sys.stderr)
        recovery_reason = failure_reason(error)
        if recovery_reason is not None:
            print('CAUCE_RECOVERY_FAILURE=' + recovery_reason, file=sys.stderr)
        diagnostic = str(error).replace('\r', '\\r').replace('\n', '\\n')
        print('fleet effect failed: ' + diagnostic, file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print('fleet effect failed: unverified operational effect', file=sys.stderr)
        raise SystemExit(2) from None
