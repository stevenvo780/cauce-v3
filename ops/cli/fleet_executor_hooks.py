from __future__ import annotations

import json
import os
import pwd
import secrets
import subprocess

from fleet_executor_policy import SafeFailure, approve_agent, digest, open_absolute_directory, path

IDENTITY_FIELDS = {'nonce', 'tenant_id', 'alias', 'runtime_key', 'account_id', 'identity'}
PROOF_FIELDS = {'authenticated', 'profile_verified', 'provider_verified', 'bootstrap_verified', 'roundtrip_verified', 'revocation_verified'}


def binding_for(policy: dict, agent: dict) -> tuple[str, dict]:
    from fleet_executor_templates import resolve_profile
    account = agent.get('primary_account_id')
    agent = approve_agent(policy, agent)
    binding = resolve_profile(policy, agent)
    if not isinstance(binding, dict) or set(binding) - {'container_name', 'command', 'command_sha256', 'command_files', 'openclaw'} != {'provider', 'path', 'identity', 'runtime_user'} \
            or binding['runtime_user'] != agent['runtime_user']:
        raise SafeFailure('missing approved provider profile binding')
    if agent['harness_id'] == 'openclaw':
        from fleet_provider_openclaw import validate_definition
        validate_definition(binding.get('openclaw'), binding['provider'])
    elif 'openclaw' in binding:
        raise SafeFailure('OpenClaw provider driver differs from the harness')
    if not isinstance(binding['identity'], str) or not binding['identity'] or not isinstance(binding['provider'], str):
        raise SafeFailure('invalid provider profile identity')
    if agent['runtime_mode'] == 'container':
        container_profile(policy, agent, binding)
        return account, binding
    if 'container_name' in binding:
        raise SafeFailure('native profile cannot bind a container')
    profile = path(binding['path'])
    descriptor = open_absolute_directory(profile)
    try:
        details = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    user = pwd.getpwnam(binding['runtime_user'])
    if details.st_uid != user.pw_uid or details.st_mode & 0o077:
        raise SafeFailure('provider profile ownership or privacy differs')
    if not isinstance(binding['identity'], str) or not binding['identity'] or not isinstance(binding['provider'], str):
        raise SafeFailure('invalid provider profile identity')
    return account, binding


def container_binding(policy: dict, agent: dict) -> tuple[dict, dict]:
    from fleet_executor_container import identity_for, inspect_container, user_identity, validate_container
    agent = approve_agent(policy, agent)
    observed = inspect_container(agent['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('approved profile container is not observed running')
    validate_container(policy, agent, observed)
    identity = identity_for(agent, observed)
    user_identity(agent, identity)
    return agent, identity


def container_profile(policy: dict, raw_agent: dict, binding: dict):
    from fleet_executor_container import docker
    agent, identity = container_binding(policy, raw_agent)
    if binding.get('container_name', agent['container_name']) != agent['container_name']:
        raise SafeFailure('provider profile container differs from the agent')
    profile = path(binding['path'])
    command = ('import json,os,sys;fd=os.open("/",os.O_RDONLY|os.O_DIRECTORY);'
        '\nfor part in sys.argv[1].split("/")[1:]:\n next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=next_fd'
        '\nst=os.fstat(fd);print(json.dumps({"uid":os.getuid(),"owner":st.st_uid,"mode":st.st_mode&511}));os.close(fd)')
    observed = json.loads(docker('exec', '--user', agent['runtime_user'], identity['container_id'],
        agent['_placement']['python'], '-c', command, str(profile)))
    if not isinstance(observed, dict) or set(observed) != {'uid', 'owner', 'mode'} \
            or type(observed['uid']) is not int or observed['uid'] <= 0 \
            or observed['owner'] != observed['uid'] or observed['mode'] & 0o077:
        raise SafeFailure('container provider profile has an unsafe owner or mode')


def invoke(policy: dict, context: dict, agent: dict, step: str, *, phase: str | None = None) -> dict:
    account, binding = binding_for(policy, agent)
    return invoke_bound(policy, context, agent, step, account, binding['identity'], binding, phase=phase)


def invoke_revoke(policy: dict, context: dict, agent: dict, credentials: dict) -> dict:
    return invoke_bound(policy, context, agent, 'revoke', None, 'cauce-runtime:' + agent['runtime_key'], None,
                        credentials=credentials)


def invoke_bound(policy: dict, context: dict, agent: dict, step: str, account, provider_identity: str,
                 binding: dict | None, *, credentials: dict | None = None, phase: str | None = None) -> dict:
    hook = policy['hooks'].get(step)
    if not isinstance(hook, dict) or set(hook) - {'files'} != {'executable', 'sha256', 'argv', 'user'}:
        raise SafeFailure('missing approved functional hook')
    if digest(path(hook['executable'])) != hook['sha256'] or not isinstance(hook['argv'], list) \
            or not all(isinstance(value, str) and '\0' not in value for value in hook['argv']) \
            or hook['user'] != (policy['executor_user'] if step == 'revoke' or agent['runtime_mode'] == 'container' else agent['runtime_user']):
        raise SafeFailure('functional hook identity or pinned executable differs')
    files = hook.get('files', {})
    if not isinstance(files, dict) or any(digest(path(filename)) != fingerprint for filename, fingerprint in files.items()):
        raise SafeFailure('functional hook file pin changed')
    if any(value.startswith('/') and (value not in files or digest(path(value)) != files[value]) for value in hook['argv']):
        raise SafeFailure('functional hook argument file is not pinned')
    nonce = secrets.token_hex(32)
    identity = {field: agent[field] for field in ('tenant_id', 'alias', 'runtime_key')}
    packet = {'operation_id': context['operation_id'], 'step': step, 'agent': {key: value for key, value in agent.items() if not key.startswith('_')},
              'account_id': account, 'identity': provider_identity, 'profile_binding': binding, 'nonce': nonce}
    if credentials is not None:
        packet['cauce_credentials'] = credentials
        packet['transport'] = policy.get('transport')
    if agent['runtime_mode'] == 'container' and step != 'revoke':
        agent, runtime = container_binding(policy, agent)
        packet['runtime_binding'] = {'container_id': runtime['container_id'], 'generation': runtime['generation'],
            'bundle_digest': policy['bundles'][agent['harness_id']]['digest'], 'image_digest': agent['_placement']['image'],
            'python': agent['_placement']['python']}
        if agent['_placement'].get('ownership') == 'shared':
            packet['runtime_binding'].update(ownership='shared', mounts=agent['_placement']['mounts'],
                runtime_uid=agent['_placement']['runtime_uid'], runtime_gid=agent['_placement']['runtime_gid'],
                control_directory=str(runtime['control']), bundle_directory=policy['bundles'][agent['harness_id']]['directory'])
    packet['transport'] = policy.get('transport')
    if phase is not None:
        if phase not in {'bootstrap', 'normal'}:
            raise SafeFailure('invalid functional proof phase')
        packet['phase'] = phase
    command = [hook['executable'], *hook['argv']]
    user = pwd.getpwnam(hook['user'])
    if user.pw_uid != os.geteuid():
        if os.geteuid() != 0:
            raise SafeFailure('executor cannot use the exact functional hook user')
        command = ['/usr/sbin/runuser', '-u', hook['user'], '--', *command]
    result = subprocess.run(command, input=json.dumps(packet).encode(), capture_output=True, timeout=45,
                            env={'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory']}, check=False)
    if result.returncode or len(result.stdout) > 8192:
        raise SafeFailure('functional hook has not demonstrated its effect')
    try:
        observed = json.loads(result.stdout)
    except ValueError:
        raise SafeFailure('functional hook returned no bounded proof') from None
    expected = {**identity, 'account_id': account, 'identity': provider_identity, 'nonce': nonce}
    if phase is not None:
        expected['phase'] = phase
    if not isinstance(observed, dict) or not IDENTITY_FIELDS.issubset(observed) or set(observed) - IDENTITY_FIELDS - PROOF_FIELDS - {'phase'} \
            or any(observed.get(field) != value for field, value in expected.items()) \
            or any(type(observed[field]) is not bool for field in set(observed) & PROOF_FIELDS):
        raise SafeFailure('functional proof identity or nonce differs')
    return {field: observed[field] for field in set(observed) & PROOF_FIELDS}
