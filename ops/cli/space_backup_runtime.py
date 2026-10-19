from __future__ import annotations

import argparse
import json
import os
import pathlib
import pwd
import re
import subprocess
import sys
import uuid

from fleet_executor_policy import SafeFailure, approve_agent, digest, load_policy, path

AGENT_FIELDS = {'company_id', 'tenant_id', 'alias', 'runtime_key', 'host_id', 'harness_id', 'runtime_mode',
                'container_name', 'runtime_user', 'home_directory', 'state_directory', 'systemd_user'}
CLAIM_FIELDS = {'id', 'claim_token', 'claim_epoch', 'company_id', 'tenant_id', 'alias', 'host_id',
                'policy_sha256', 'agent_snapshot'}


def validate_request(request: dict) -> dict:
    if not isinstance(request, dict) or request.get('action') not in {'export', 'read', 'remove'} \
            or set(request) != {'action', 'claim'} | ({'offset'} if request.get('action') == 'read' else set()):
        raise SafeFailure('invalid closed backup request')
    claim = request['claim']
    if not isinstance(claim, dict) or set(claim) != CLAIM_FIELDS \
            or any(str(uuid.UUID(claim[field])) != claim[field] for field in ('id', 'claim_token')) \
            or type(claim['claim_epoch']) is not int or not 1 <= claim['claim_epoch'] <= 2147483647 \
            or not isinstance(claim['policy_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', claim['policy_sha256']):
        raise SafeFailure('invalid space backup claim')
    agent = claim['agent_snapshot']
    if not isinstance(agent, dict) or set(agent) != AGENT_FIELDS \
            or any(agent[field] != claim[field] for field in ('company_id', 'tenant_id', 'alias', 'host_id')):
        raise SafeFailure('space backup target differs')
    from space_archive import identity
    identity({field: agent[field] for field in ('company_id', 'tenant_id', 'alias', 'runtime_key')})
    return claim


def execute(policy_file: pathlib.Path, request: dict) -> dict:
    claim = validate_request(request)
    if digest(policy_file) != claim['policy_sha256']:
        raise SafeFailure('space backup policy changed')
    policy = load_policy(policy_file)
    if digest(policy_file) != claim['policy_sha256']:
        raise SafeFailure('space backup policy changed during read')
    agent = approve_agent(policy, claim['agent_snapshot'])
    local = {'action': request['action'], 'id': claim['id'], 'claim_epoch': claim['claim_epoch'],
             'state_directory': agent['state_directory'],
             'identity': {field: agent[field] for field in ('company_id', 'tenant_id', 'alias', 'runtime_key')}}
    if request['action'] == 'read':
        local['offset'] = request['offset']
    binding = None
    if agent['runtime_mode'] == 'container':
        from fleet_executor_container import isolated_python
        from fleet_executor_hooks import container_binding
        agent, binding = container_binding(policy, agent)
        command = ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', agent['runtime_user'], binding['container_id'],
                   *isolated_python(str(path(agent['_placement']['python'])), '/cauce/executor/space_backup_local.py')]
    else:
        user = pwd.getpwnam(agent['runtime_user'])
        if user.pw_dir != agent['home_directory']:
            raise SafeFailure('space backup runtime home differs')
        command = [str(pathlib.Path(sys.executable).resolve()), str(pathlib.Path(__file__).with_name('space_backup_local.py'))]
        if user.pw_uid != os.geteuid():
            if os.geteuid() != 0:
                raise SafeFailure('space backup executor is not the exact runtime owner')
            command = ['/usr/sbin/runuser', '-u', agent['runtime_user'], '--', *command]
    result = subprocess.run(command, input=json.dumps(local).encode(), capture_output=True, timeout=120,
                            env={'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'PYTHONDONTWRITEBYTECODE': '1'}, check=False)
    if result.returncode or len(result.stdout) > 131072 or digest(policy_file) != claim['policy_sha256']:
        raise SafeFailure('space backup export effect is unverified')
    if binding is not None:
        from fleet_executor_hooks import container_binding
        _, after = container_binding(policy, agent)
        if after['container_id'] != binding['container_id'] or after['generation'] != binding['generation']:
            raise SafeFailure('space backup container was replaced')
    output = json.loads(result.stdout)
    if not isinstance(output, dict):
        raise SafeFailure('space backup export receipt is unavailable')
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise SafeFailure('space backup request exceeds its limit')
        print(json.dumps(execute(path(args.policy), json.loads(raw)), separators=(',', ':')))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print('Space backup runtime could not verify the requested effect.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
