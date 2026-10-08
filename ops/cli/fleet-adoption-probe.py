#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys

from fleet_adoption_probe_fence import SupervisorFence, recover_fence
from fleet_adoption_probe_policy import ProbeFailure, digest_file, load_policy, select
from fleet_adoption_probe_supervisor import controlled, verify_control


def output(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def read_packet() -> dict | None:
    raw = sys.stdin.buffer.readline(8193)
    if not raw:
        return None
    if len(raw) > 8192 or not raw.endswith(b'\n'):
        raise ProbeFailure('invalid_packet')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ProbeFailure('invalid_packet')
    return value


def session(policy: dict, recovery: bool = False) -> int:
    fences: dict[tuple[str, str], SupervisorFence] = {}
    try:
        request = read_packet()
        if request is None or set(request) != {'id', 'action', 'targets', 'session_nonce'} or request['action'] != ('recover' if recovery else 'acquire') \
                or request['id'] != 0 or not isinstance(request['targets'], list) or not 1 <= len(request['targets']) <= 100:
            raise ProbeFailure('invalid_acquire_request')
        nonce = request['session_nonce']
        if not isinstance(nonce, str) or len(nonce) != 64 or any(char not in '0123456789abcdef' for char in nonce):
            raise ProbeFailure('invalid_acquire_request')
        for target in request['targets']:
            row = select(policy, target)
            if recovery:
                recover_fence(row, nonce)
                continue
            key = (target['tenant_id'], target['alias'])
            if key in fences:
                raise ProbeFailure('duplicate_target')
            fence = SupervisorFence(row, nonce)
            fences[key] = fence
            fence.acquire()
        output({'id': 0, 'ok': True})
        if recovery:
            return 0
        previous = 0
        while (request := read_packet()) is not None:
            identifier = request.get('id')
            if type(identifier) is not int or identifier <= previous:
                raise ProbeFailure('invalid_request_order')
            previous = identifier
            try:
                if request.get('action') == 'measure' and set(request) == {'id', 'action', 'target'}:
                    target = request['target']
                    row = select(policy, target)
                    facts = fences[(row['target']['tenant_id'], row['target']['alias'])].measure()
                    output({'id': identifier, 'ok': True, 'facts': facts})
                elif request.get('action') == 'assert' and set(request) == {'id', 'action'}:
                    for fence in fences.values():
                        fence.assert_held()
                    output({'id': identifier, 'ok': True})
                elif request.get('action') == 'release' and set(request) == {'id', 'action'}:
                    for fence in fences.values():
                        fence.close()
                    output({'id': identifier, 'ok': True})
                    return 0
                else:
                    raise ProbeFailure('invalid_request')
            except (ProbeFailure, KeyError, OSError, ValueError):
                output({'id': identifier, 'ok': False, 'code': 'probe_unavailable'})
        return 2
    finally:
        for fence in fences.values():
            fence.abandon()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', nargs='?', choices=['probe', 'recover', 'control', 'verify-control'])
    parser.add_argument('--step', choices=['probe', 'recover'])
    parser.add_argument('--policy', required=True)
    parser.add_argument('--runtime-key')
    arguments, command = parser.parse_known_args()
    try:
        policy = load_policy(arguments.policy)
        action = arguments.action or arguments.step
        if action is None or (arguments.action and arguments.step):
            raise ProbeFailure('invalid_probe_arguments')
        if action in {'probe', 'recover'}:
            if command:
                raise ProbeFailure('invalid_probe_arguments')
            return session(policy, recovery=action == 'recover')
        rows = [row for row in policy['targets'] if row['runtime_key'] == arguments.runtime_key]
        if len(rows) != 1:
            raise ProbeFailure('supervisor_target_ambiguous')
        row = rows[0]
        if action == 'verify-control':
            descriptor = os.environ.get('CAUCE_ADOPTION_CONTROL_FD', '')
            if not descriptor.isdecimal():
                raise ProbeFailure('control_descriptor_unavailable')
            verify_control(int(descriptor), row['supervisor']['socket'], row['target'])
            return 0
        command = command[1:] if command[:1] == ['--'] else command
        if command != [row['supervisor']['command'], 'stop', row['runtime_key']] \
                or digest_file(command[0]) != row['supervisor']['command_sha256']:
            raise ProbeFailure('control_command_changed')
        return controlled(row['supervisor']['socket'], row['target'], command)
    except (ProbeFailure, OSError, ValueError, KeyError):
        output({'id': 0, 'ok': False, 'code': 'probe_unavailable'})
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
