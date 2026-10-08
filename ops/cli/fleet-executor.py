#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import signal
import sys

from fleet_executor_hooks import binding_for, container_binding
from fleet_executor_policy import SafeFailure, approve_agent, load_policy, target_agent, validate_payload
from fleet_executor_steps import perform

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from update_alias_lib import SafeArgumentParser


def cancelled(_signal, _frame):
    raise SafeFailure('fleet effect cancelled')


def approved_binding(policy: dict, context: dict) -> dict:
    agent = approve_agent(policy, target_agent(context))
    _account, profile = binding_for(policy, agent)
    receipt = {'agent': {key: value for key, value in agent.items() if not key.startswith('_')},
               'profile_binding': profile}
    if agent['runtime_mode'] == 'container':
        agent, identity = container_binding(policy, agent)
        receipt['runtime_binding'] = {key: identity[key] for key in ('container_id', 'generation')}
        receipt['runtime_binding'].update(image_digest=agent['_placement']['image'],
            python=agent['_placement']['python'], helper='/cauce/executor/provider-login.py')
    return receipt


def main() -> int:
    parser = SafeArgumentParser(description='Execute one bounded physical fleet effect')
    parser.add_argument('--policy', type=pathlib.Path, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--binding', action='store_true')
    action.add_argument('--capabilities', action='store_true')
    action.add_argument('--step', choices=('prepare', 'artifacts', 'credentials', 'runtime', 'authenticate',
        'profile', 'verify', 'admission', 'fence', 'stop', 'revoke', 'purge', 'compensate', 'login-stop'))
    args = parser.parse_args()
    policy = load_policy(args.policy)
    if args.capabilities:
        from fleet_executor_templates import capabilities
        print(json.dumps(capabilities(policy), sort_keys=True, separators=(',', ':')))
        return 0
    encoded = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(encoded) > 1024 * 1024:
        raise SafeFailure('execution payload exceeds its limit')
    context = validate_payload(json.loads(encoded))
    for termination in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(termination, cancelled)
    receipt = approved_binding(policy, context) if args.binding else perform(policy, context, args.step)
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SafeFailure as error:
        print('fleet effect failed: ' + str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print('fleet effect failed: unverified operational effect', file=sys.stderr)
        raise SystemExit(2) from None
