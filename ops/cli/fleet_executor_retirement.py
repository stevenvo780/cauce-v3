from __future__ import annotations

import fcntl
import hashlib
import os
import pathlib
import re
import shutil
import ssl
import stat

from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, approve_agent, open_absolute_directory, open_regular_at
from fleet_executor_runtime import native_identity, stop


def assert_purge_supported(agent: dict) -> None:
    if agent['runtime_mode'] == 'native' and agent['_placement'].get('manager') is not None:
        raise SafeFailure('managed native unit must be decommissioned before residual removal')


def scoped_agents(policy: dict, context: dict) -> list[dict]:
    target = context['request']['target']
    rows = context['previous_agents']
    if context['request']['kind'] == 'create':
        rows = [row for row in rows if not (isinstance(row, dict)
                and (row.get('runtime_key') is None or 'runtime_mode' in row and row['runtime_mode'] is None
                     and isinstance(row.get('primary_room_id'), str))
                and row.get('lifecycle_state') == 'draft' and row.get('enabled') is not True)]
    if not rows and target['resource'] == 'agent':
        from fleet_executor_policy import target_agent
        rows = [target_agent(context)]
    fenced = {(row.get('tenant_id'), row.get('alias')) for row in context['fenced_targets']
              if isinstance(row, dict) and row.get('resource') == 'agent'}
    identities = set()
    approved = []
    for row in rows:
        if not isinstance(row, dict) or row.get('tenant_id') != target['tenant_id'] \
                or (target['resource'] == 'agent' and row.get('alias') != target['alias']):
            raise SafeFailure('placement is outside the fenced target')
        identity = (row['tenant_id'], row['alias'])
        if identity in identities or (context['fenced_targets'] and identity not in fenced):
            raise SafeFailure('placement is ambiguous or has no durable fence')
        if target['resource'] == 'room' and row.get('primary_room_id') != target['room_id']:
            members = context.get('snapshot', {}).get('memberships', []) + context['desired_memberships']
            if not any(member.get('tenant_id') == row['tenant_id'] and member.get('alias') == row['alias']
                       and member.get('room_id') == target['room_id'] for member in members):
                raise SafeFailure('placement has no membership in the fenced room')
        identities.add(identity)
        # Like target_agent: stopping a container whose image drifted recreates it and resolves the provider
        # profile, which needs the durable account trust of this operation.
        agent = approve_agent(policy, {**row, '_trusted_accounts': context.get('trusted_accounts', []),
                                       '_trusted_accounts_present': 'trusted_accounts' in context})
        if context['request']['kind'] == 'purge':
            assert_purge_supported(agent)
        approved.append(agent)
    return approved


def exact_principal(agent: dict, principal: dict) -> bool:
    if not isinstance(principal, dict) or principal.get('tenant_id') != agent['tenant_id'] or principal.get('alias') != agent['alias']:
        return False
    return (principal.get('channel'), principal.get('session_id')) in {
        ('bootstrap', 'bootstrap-' + agent['runtime_key']), ('adapter', 'adapter-' + agent['runtime_key'])}


def credential_references(policy: dict, agent: dict) -> dict:
    from fleet_executor_legacy_credentials import observe_references
    legacy = observe_references(policy, agent)
    references = {}
    key = agent['runtime_key']
    for kind in ('bootstrap', 'normal'):
        pair = pathlib.Path(policy['roots']['pki']) / kind / key
        token = pathlib.Path(policy['roots']['tokens']) / kind / (key + '.token')
        certificate, private = pair / ('agent-' + key + '.crt'), pair / ('agent-' + key + '.key')
        row = {}
        if certificate.exists() or certificate.is_symlink():
            pem = checked_file(certificate)
            checked_file(private, True)
            row.update(certificate_path=str(certificate), key_path=str(private),
                       certificate_fingerprint=hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest())
        elif (private.exists() or private.is_symlink()) and 'authority' not in policy:
            raise SafeFailure('credential pair is incomplete before revocation')
        if token.exists() or token.is_symlink():
            raw = checked_file(token, True).strip()
            if re.fullmatch(rb'[0-9a-f]{64}', raw) is None:
                raise SafeFailure('token credential has an invalid shape')
            row.update(token_path=str(token), token_sha256=hashlib.sha256(raw).hexdigest())
        if row:
            references[kind] = row
    if not references and legacy is None and agent.get('fleet_baseline') is not False:
        raise SafeFailure('empty Cauce credential references require an explicit durable nonbaseline identity')
    result = {'identities_directory': policy['roots']['identities'], 'credentials': references,
              'fleet_baseline': agent.get('fleet_baseline')}
    if legacy is not None:
        result['legacy'] = legacy
    return result


def remove_registry_principals(policy: dict, agent: dict, script_loader) -> None:
    from fleet_executor_legacy_credentials import remove_base_principals
    remove_base_principals(policy, agent)
    root = pathlib.Path(policy['roots']['identities'])
    descriptor = open_absolute_directory(root)
    try:
        for filename, module in (('token_hashes.json', script_loader('issue-alias-token.py')),
                                 ('mtls_identities.json', script_loader('register-agent-identity.py'))):
            lock = open_regular_at(descriptor, '.' + filename + '.lock', os.O_RDWR | os.O_CREAT, mode=0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX)
                document, original = module.read_identity_document(descriptor)
                kept = [record for record in document['identities']
                        if not isinstance(record, dict) or not exact_principal(agent, record.get('principal'))]
                if len(kept) != len(document['identities']):
                    document['identities'] = kept
                    module.publish_identity_document(descriptor, lock, document, original)
            finally:
                os.close(lock)
    finally:
        os.close(descriptor)

    from fleet_executor_registry import publish_gateway_registry
    publish_gateway_registry(policy)


def drop_owned_directory(root: pathlib.Path, name: str, removed: list[dict]) -> None:
    path = root / name
    try:
        existed = stat.S_ISDIR(os.lstat(path).st_mode)
    except FileNotFoundError:
        existed = False
    remove_tree(root, name)
    if existed and not path.exists():
        removed.append({'type': 'directory', 'name': str(path)})


def remove_tree(root: pathlib.Path, name: str) -> None:
    parent = open_absolute_directory(root)
    try:
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            details = os.fstat(descriptor)
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (details.st_dev, details.st_ino) != (actual.st_dev, actual.st_ino):
                raise SafeFailure('purge directory changed before removal')
            if not shutil.rmtree.avoids_symlink_attacks:
                raise SafeFailure('safe runtime directory removal is unavailable')
            shutil.rmtree(name, dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def remove_credentials(policy: dict, agent: dict) -> None:
    key = agent['runtime_key']
    for kind in ('bootstrap', 'normal'):
        pki = pathlib.Path(policy['roots']['pki']) / kind
        tokens = pathlib.Path(policy['roots']['tokens']) / kind
        if pki.exists():
            remove_tree(pki, key)
        if tokens.exists():
            parent = open_absolute_directory(tokens)
            try:
                try:
                    descriptor = open_regular_at(parent, key + '.token', os.O_RDONLY)
                except FileNotFoundError:
                    continue
                try:
                    details = os.fstat(descriptor)
                    actual = os.stat(key + '.token', dir_fd=parent, follow_symlinks=False)
                    if details.st_nlink != 1 or details.st_uid != os.geteuid() \
                            or (details.st_dev, details.st_ino) != (actual.st_dev, actual.st_ino):
                        raise SafeFailure('credential file changed before removal')
                    os.unlink(key + '.token', dir_fd=parent)
                    os.fsync(parent)
                finally:
                    os.close(descriptor)
            finally:
                os.close(parent)


def remove_runtime_credentials(policy: dict, agent: dict) -> None:
    if agent['runtime_mode'] == 'native':
        directory = pathlib.Path(agent['state_directory']) / '.cauce-credentials'
        if directory.parent.exists():
            from fleet_executor_view import remove
            remove(directory)
        return
    from fleet_executor_container import (
        EXECUTOR_DESTINATION,
        docker,
        identity_for,
        inspect_container,
        isolated_python,
        validate_container,
    )
    observed = inspect_container(agent['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        return
    validate_container(policy, agent, observed, teardown=True)
    identity = identity_for(agent, observed)
    docker('exec', '-w', '/', '--user', '0', identity['container_id'],
           *isolated_python(agent['_placement']['python'], f'{EXECUTOR_DESTINATION}/fleet_executor_view.py',
                            '--root', '/run/cauce-credentials/' + agent['runtime_key'], '--remove'))


def purge_runtime(policy: dict, agent: dict) -> dict:
    assert_purge_supported(agent)
    stop(policy, agent)
    removed: list[dict] = []
    if agent['runtime_mode'] == 'container':
        from fleet_executor_container import purge_container
        removed.extend(purge_container(policy, agent)['removed'])
    else:
        identity = native_identity(policy, agent)
        control = identity['control']
        if control.parent.exists():
            drop_owned_directory(control.parent, agent['runtime_key'], removed)
        drop_owned_directory(pathlib.Path(agent['_placement']['state_root']), agent['runtime_key'], removed)
    views = pathlib.Path(policy['roots']['runtime']) / '.credential-views'
    if views.exists():
        drop_owned_directory(views, agent['runtime_key'], removed)
    remove_credentials(policy, agent)
    return {'removed': removed}
