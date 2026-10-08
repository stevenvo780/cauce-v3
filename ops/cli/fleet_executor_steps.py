from __future__ import annotations

import copy
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys

from fleet_executor_hooks import binding_for, invoke, invoke_revoke
from fleet_executor_identity import principal_for
from fleet_executor_pki import provision
from fleet_executor_policy import SafeFailure, approve_agent, private_directory, target_agent
from fleet_executor_retirement import (
    credential_references,
    purge_runtime,
    remove_credentials,
    remove_registry_principals,
    remove_runtime_credentials,
    scoped_agents,
)
from fleet_executor_runtime import NamespaceMismatch, start, stop

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from atomic_file import atomic_write  # noqa: E402
from fleet_runtime_apply import publish_applied  # noqa: E402
from fleet_runtime_materialization import (  # noqa: E402
    _destination,
    load_applied_fleet,
    load_desired_fleet,
    materialize,
)


def script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Executor:
    def __init__(self, policy: dict, context: dict):
        self.policy, self.context = policy, context
        self.state = pathlib.Path(policy['roots']['state'])
        self.operation = _destination(self.state, 'operations/' + context['operation_id'])
        self.operation.mkdir(parents=True, mode=0o700, exist_ok=True)
        private_directory(str(self.operation))
        self.journal_path = _destination(self.operation, 'effects.json')
        self.request_hash = hashlib.sha256(json.dumps(context['request'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.journal = json.loads(self.journal_path.read_bytes()) if self.journal_path.exists() else {'request_sha256': self.request_hash}
        if self.journal.get('request_sha256') != self.request_hash:
            raise SafeFailure('operation replay changed its declarative request')
        inputs = {name: context[name] for name in ('fenced_targets', 'previous_agents', 'desired_memberships')}
        inputs_hash = hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if self.journal.setdefault('inputs_sha256', inputs_hash) != inputs_hash:
            raise SafeFailure('operation replay changed its fenced placements or membership intent')
        self.journal.setdefault('expected_applied', load_applied_fleet(self.state)['generation'] if (self.state / 'applied-fleet.json').exists() else None)
        self.save()

    def save(self):
        atomic_write(_destination(self.operation, 'effects.json'), json.dumps(self.journal, sort_keys=True).encode(), mode=0o600)

    def agent(self):
        return approve_agent(self.policy, target_agent(self.context))

    def materialize_snapshot(self, source: dict) -> dict:
        source = copy.deepcopy(source)
        for agent in source.get('agents', []):
            agent.pop('fleet_baseline', None)
        return materialize(source, {}, self.state)

    def generation(self):
        receipt = load_desired_fleet(self.state)
        if receipt['generation'] != self.journal.get('generation'):
            raise SafeFailure('desired generation changed before effect')
        return self.state / 'generations' / receipt['generation']

    def artifacts(self):
        kind = self.context['request']['kind']
        if kind in {'stop', 'retire', 'purge'}:
            if self.journal.get('stopped') is not True or (kind != 'stop' and not self.journal.get('revoked')):
                raise SafeFailure('fenced artifacts require observed stop and revocation')
            rows = scoped_agents(self.policy, self.context)
            for row in rows:
                stop(self.policy, row)
            source = copy.deepcopy(self.context.get('snapshot'))
            if not isinstance(source, dict):
                raise SafeFailure('missing durable fenced snapshot')
            identities = {(row['tenant_id'], row['alias']) for row in rows}
            if kind == 'purge':
                if self.journal.get('purged') is not True:
                    raise SafeFailure('purge artifacts require observed residual removal')
                source['agents'] = [row for row in source['agents'] if (row['tenant_id'], row['alias']) not in identities]
                source['memberships'] = [row for row in source['memberships'] if (row['tenant_id'], row['alias']) not in identities]
            elif any(row.get('enabled') is not False for row in source['agents'] if (row['tenant_id'], row['alias']) in identities):
                raise SafeFailure('durable targets were not fenced before artifacts')
            receipt = self.materialize_snapshot(source)
            publish_applied(self.state, receipt['generation'], self.journal['expected_applied'])
            self.journal['generation'] = receipt['generation']
            self.save()
            return {'artifact_sha256': receipt['generation']}
        if kind == 'restore' and self.context['request']['target']['resource'] != 'agent':
            receipt = self.materialize_snapshot(self.context['snapshot'])
            self.journal['generation'] = receipt['generation']
            self.save()
            return {'artifact_sha256': receipt['generation']}
        agent = self.agent()
        source = self.context.get('snapshot')
        if not isinstance(source, dict):
            raise SafeFailure('missing durable fleet snapshot hook')
        matches = [row for row in source.get('agents', []) if row.get('tenant_id') == agent['tenant_id'] and row.get('alias') == agent['alias']]
        if len(matches) != 1:
            raise SafeFailure('durable snapshot target is missing or ambiguous')
        observed = approve_agent(self.policy, matches[0])
        for field in ('runtime_key', 'harness_id', 'host_id', 'runtime_mode', 'container_name', 'runtime_user',
                      'systemd_user', 'home_directory', 'state_directory', 'primary_account_id', 'model_id'):
            if observed.get(field) != agent.get(field):
                raise SafeFailure('durable snapshot differs from approved request')
        if matches[0].get('enabled') is not False:
            raise SafeFailure('preparation must remain fenced before admission')
        receipt = self.materialize_snapshot(source)
        generation = self.state / 'generations' / receipt['generation']
        bootstrap = json.loads((generation / 'flota.json').read_bytes()).get('bootstrap', {})
        if agent['runtime_key'] not in bootstrap:
            raise SafeFailure('target has no complete bootstrap artifacts')
        self.journal['generation'] = receipt['generation']
        applied = self.state / 'applied-fleet.json'
        self.journal.setdefault('expected_applied', load_applied_fleet(self.state)['generation'] if applied.exists() else None)
        self.save()
        return {'artifact_sha256': receipt['generation']}

    def credentials(self):
        agent = self.agent()
        return self.prepare_credentials(agent, self.generation(), bootstrap=True)

    def prepare_credentials(self, agent: dict, generation: pathlib.Path, *, bootstrap: bool):
        key = agent['runtime_key']
        kind = 'bootstrap' if bootstrap else 'normal'
        snapshot = generation / 'flota.json'
        manifest = generation / ('bootstrap/manifests' if bootstrap else 'manifests') / f'{key}.yaml'
        principal = principal_for(snapshot, key, bootstrap)
        signer = self.policy.get('signer')
        if not isinstance(signer, dict) or set(signer) != {'certificate', 'key'}:
            raise SafeFailure('missing approved bootstrap signer')
        issuer, registry = script('issue-alias-token.py'), script('register-agent-identity.py')
        identities = pathlib.Path(self.policy['roots']['identities'])
        pki = _destination(pathlib.Path(self.policy['roots']['pki']), kind)
        tokens = _destination(pathlib.Path(self.policy['roots']['tokens']), kind)
        for directory in (pki, tokens):
            directory.mkdir(mode=0o700, exist_ok=True)
            private_directory(str(directory))
        identity_fd = registry.open_absolute_directory(identities, 'identities')
        try:
            document, _ = registry.read_identity_document(identity_fd)
        finally:
            os.close(identity_fd)
        if not (pki / key).exists() and any(record.get('principal') == principal for record in document['identities'] if isinstance(record, dict)):
            raise SafeFailure('registered certificate pair is missing; no rotation performed')
        proof = provision(key, pki, pathlib.Path(signer['certificate']), pathlib.Path(signer['key']), snapshot, manifest, bootstrap=bootstrap)
        expires = datetime.datetime.fromisoformat(proof['expires_at'].replace('Z', '+00:00'))
        ttl_days = 1 if bootstrap else max(1, (expires - datetime.datetime.now(datetime.timezone.utc)).days)
        registered = registry.register(key, pki / key, identities, snapshot, ttl_days, bootstrap=bootstrap)
        if registered['certificate_sha256'] != proof['certificate_fingerprint']:
            raise SafeFailure('registered certificate fingerprint differs')
        issuer.issue(key, tokens, identities, snapshot, ttl_days, bootstrap=bootstrap, idempotent=True)
        from fleet_executor_registry import publish_gateway_registry
        publish_gateway_registry(self.policy)
        self.journal[kind + '_credentials'] = proof['certificate_fingerprint']
        self.save()
        return {'certificate_fingerprint': proof['certificate_fingerprint']}

    def runtime(self):
        if self.context['request']['kind'] == 'start' and 'generation' not in self.journal:
            self.artifacts()
            self.credentials()
        self.generation()
        agent = self.agent()
        if self.context['request']['kind'] == 'update':
            previous = [row for row in self.context['previous_agents'] if row.get('tenant_id') == agent['tenant_id'] and row.get('alias') == agent['alias']]
            if len(previous) != 1:
                raise SafeFailure('update requires the original runtime placement')
            if previous[0].get('runtime_key') != agent['runtime_key']:
                raise SafeFailure('update cannot replace the physical runtime identity')
            stop(self.policy, previous[0])
        elif self.context['request']['kind'] == 'start' and 'runtime' not in self.journal:
            self.stop()
        evidence = start(self.policy, agent, operation_id=self.context['operation_id'])
        self.journal['runtime'] = evidence['runtime_digest']
        self.save()
        return evidence

    def stop(self):
        rows = scoped_agents(self.policy, self.context)
        for row in rows:
            stop(self.policy, row)
        self.journal['stopped'] = True
        self.save()
        return {'stopped_verified': True}

    def revoke(self):
        if self.journal.get('stopped') is not True:
            raise SafeFailure('revocation requires observed stop')
        rows = scoped_agents(self.policy, self.context)
        revoked = self.journal.setdefault('revoked', {})
        for row in rows:
            stop(self.policy, row)
            references = credential_references(self.policy, row)
            key = row['runtime_key']
            if key in revoked and (references.get('legacy') != revoked[key].get('legacy')
                    or references['credentials'] and references != revoked[key]):
                raise SafeFailure('credential identity changed after observed revocation')
            remove_registry_principals(self.policy, row, script)
            if key not in revoked or references.get('legacy') is not None:
                observed = invoke_revoke(self.policy, self.context, row, references)
                if observed.get('revocation_verified') is not True:
                    raise SafeFailure('old Cauce credentials were not observed rejected')
                if references.get('legacy') is not None:
                    from fleet_executor_legacy_credentials import capture_absence
                    self.journal.setdefault('legacy_authority_absence', {})[key] = capture_absence(references, row)
                stop(self.policy, row)
                revoked[key] = references
                self.save()
            remove_credentials(self.policy, row)
            remove_runtime_credentials(self.policy, row)
        self.journal['revocation_complete'] = True
        self.save()
        return {'revocation_verified': True}

    def purge(self):
        if self.context['request']['kind'] != 'purge' or self.journal.get('stopped') is not True \
                or self.journal.get('revocation_complete') is not True:
            raise SafeFailure('purge requires observed stop and credential revocation')
        rows = scoped_agents(self.policy, self.context)
        for row in rows:
            if credential_references(self.policy, row)['credentials']:
                raise SafeFailure('new credential material appeared after revocation')
            purge_runtime(self.policy, row)
        self.journal['purged'] = True
        self.save()
        return {'stopped_verified': True, 'revocation_verified': True}

    def authenticate(self):
        agent = self.agent()
        from fleet_executor_templates import resolve_profile
        if 'authenticate' not in self.policy['hooks'] or resolve_profile(self.policy, agent) is None:
            return {'evidence': {}, 'awaiting_auth': True}
        observed = invoke(self.policy, self.context, agent, 'authenticate')
        if observed.get('authenticated') is not True:
            return {'evidence': {}, 'awaiting_auth': True}
        account, binding = binding_for(self.policy, agent)
        self.journal['authenticated'] = {'account_id': account, 'binding': binding}
        self.save()
        return {'evidence': {'provider_verified': True}}

    def profile(self):
        agent = self.agent()
        account, binding = binding_for(self.policy, agent)
        if self.journal.get('authenticated') != {'account_id': account, 'binding': binding}:
            raise SafeFailure('provider profile has no current authenticated identity proof')
        observed = invoke(self.policy, self.context, agent, 'profile')
        if observed.get('profile_verified') is not True:
            raise SafeFailure('provider profile was not acknowledged')
        self.journal['profile'] = True
        self.save()
        return {'profile_verified': True}

    def verify(self):
        if self.journal.get('profile') is not True or 'runtime' not in self.journal:
            raise SafeFailure('runtime profile was not prepared before functional verification')
        observed = invoke(self.policy, self.context, self.agent(), 'verify', phase='bootstrap')
        required = ('provider_verified', 'profile_verified', 'bootstrap_verified', 'roundtrip_verified')
        if any(observed.get(field) is not True for field in required):
            raise SafeFailure('provider, profile, bootstrap or nonce roundtrip was not demonstrated')
        self.journal['verified'] = {field: True for field in required}
        self.save()
        return self.journal['verified']

    def admission(self):
        if self.context['request']['target']['resource'] != 'agent':
            return self.admit_memberships()
        if not self.journal.get('verified') or not all(self.journal['verified'].values()):
            raise SafeFailure('admission requires complete functional verification')
        agent = self.agent()
        account, binding = binding_for(self.policy, agent)
        if self.journal.get('authenticated') != {'account_id': account, 'binding': binding}:
            raise SafeFailure('admission provider account or profile binding changed')
        source = copy.deepcopy(self.context.get('snapshot'))
        if not isinstance(source, dict):
            raise SafeFailure('missing durable admission snapshot')
        rows = [row for row in source['agents'] if row['tenant_id'] == agent['tenant_id'] and row['alias'] == agent['alias']]
        if len(rows) != 1:
            raise SafeFailure('admission target is missing or ambiguous')
        if self.context['request']['kind'] in {'create', 'update'}:
            intended = self.context['request']['parameters']['memberships']
            intended = [{'tenant_id': agent['tenant_id'], 'alias': agent['alias'], 'room_id': row['room_id'],
                         'role': row['role'], 'enabled': row.get('enabled', True)} for row in intended]
        else:
            intended = [row for row in self.context['desired_memberships']
                        if row['tenant_id'] == agent['tenant_id'] and row['alias'] == agent['alias']]
        if not intended or not any(row['room_id'] == rows[0]['primary_room_id'] and row['enabled'] is True for row in intended):
            raise SafeFailure('admission lacks an enabled primary membership intent')
        rows[0].update(enabled=True, lifecycle_state='ready')
        source['memberships'] = [row for row in source['memberships']
            if row['tenant_id'] != agent['tenant_id'] or row['alias'] != agent['alias']] + intended
        receipt = self.materialize_snapshot(source)
        generation = self.state / 'generations' / receipt['generation']
        current = load_applied_fleet(self.state)['generation'] if (self.state / 'applied-fleet.json').exists() else None
        if current not in {self.journal['expected_applied'], receipt['generation']}:
            raise SafeFailure('applied fleet changed before admission runtime effects')
        self.prepare_credentials(agent, generation, bootstrap=False)
        try:
            evidence = start(self.policy, agent, bootstrap=False, operation_id=self.context['operation_id'])
        except NamespaceMismatch:
            stop(self.policy, agent)
            evidence = start(self.policy, agent, bootstrap=False, operation_id=self.context['operation_id'])
        try:
            normal = invoke(self.policy, self.context, agent, 'verify', phase='normal')
            if any(normal.get(field) is not True for field in ('provider_verified', 'profile_verified', 'bootstrap_verified', 'roundtrip_verified')):
                raise SafeFailure('normal runtime provider, profile, hello or nonce roundtrip was not demonstrated')
            publish_applied(self.state, receipt['generation'], self.journal.get('expected_applied'))
        except BaseException:
            stop(self.policy, agent)
            raise
        self.journal['admission'] = {'generation': receipt['generation'], 'runtime': evidence['runtime_digest']}
        self.save()
        return {'artifact_sha256': receipt['generation'], **evidence}

    def admit_memberships(self):
        if self.context['request']['kind'] != 'restore':
            raise SafeFailure('membership admission requires restore')
        self.generation()
        target = self.context['request']['target']
        source = copy.deepcopy(self.context['snapshot'])
        for member in self.context['desired_memberships']:
            if member.get('tenant_id') != target['tenant_id'] \
                    or (target['resource'] == 'room' and member.get('room_id') != target['room_id']) \
                    or type(member.get('enabled')) is not bool:
                raise SafeFailure('membership admission intent is outside the target')
            matches = [row for row in source['memberships'] if all(row[field] == member[field] for field in ('tenant_id', 'alias', 'room_id'))]
            if len(matches) != 1:
                raise SafeFailure('membership admission target is missing or ambiguous')
            matches[0].update(member)
        receipt = self.materialize_snapshot(source)
        publish_applied(self.state, receipt['generation'], self.journal['expected_applied'])
        self.journal['admission'] = {'generation': receipt['generation']}
        self.save()
        return {'artifact_sha256': receipt['generation']}

    def perform(self, step: str) -> dict:
        if step == 'compensate':
            return {'evidence': self.compensate()}
        if step == 'login-stop':
            for row in self.physical_placements():
                stop(self.policy, row)
            return {'evidence': {'stopped_verified': True}}
        attempted = self.journal.setdefault('attempted', [])
        if step not in attempted:
            attempted.append(step)
            self.save()
        if step in {'artifacts', 'credentials', 'runtime', 'stop', 'revoke', 'purge', 'profile', 'verify', 'admission'}:
            return {'evidence': getattr(self, step)()}
        if step == 'authenticate':
            return self.authenticate()
        raise SafeFailure('missing verified hook for requested fleet step')

    def compensate(self) -> dict:
        rows = self.physical_placements()
        for row in rows:
            stop(self.policy, row)
        self.journal['stopped'] = True
        self.save()
        revoked = self.journal.setdefault('compensated', {})
        for row in rows:
            references = credential_references(self.policy, row)
            key = row['runtime_key']
            if key in revoked and references.get('legacy') is None:
                if references['credentials']:
                    raise SafeFailure('new credentials appeared after compensation')
                remove_runtime_credentials(self.policy, row)
                continue
            remove_registry_principals(self.policy, row, script)
            if references['credentials'] or references.get('legacy') is not None:
                observed = invoke_revoke(self.policy, self.context, row, references)
                if observed.get('revocation_verified') is not True:
                    raise SafeFailure('compensation credential rejection was not observed')
                if references.get('legacy') is not None:
                    from fleet_executor_legacy_credentials import capture_absence
                    self.journal.setdefault('legacy_authority_absence', {})[key] = capture_absence(references, row)
            remove_credentials(self.policy, row)
            remove_runtime_credentials(self.policy, row)
            revoked[key] = True
            self.save()
        return {'stopped_verified': True, 'revocation_verified': True}

    def physical_placements(self) -> list[dict]:
        rows = scoped_agents(self.policy, self.context)
        if self.context['request']['target']['resource'] == 'agent' and self.context['request']['kind'] in {'create', 'update', 'start', 'restore'}:
            agent = self.agent()
            if any(agent.get(field) != row.get(field) for row in rows for field in
                   ('state_directory', 'runtime_user', 'runtime_mode', 'container_name')) or not rows:
                rows.insert(0, agent)
        return rows


def perform(policy: dict, context: dict, step: str) -> dict:
    target = context['request']['target']
    if target['resource'] == 'agent':
        approve_agent(policy, target_agent(context))
    state = pathlib.Path(policy['roots']['state'])
    lock = os.open(_destination(state, '.executor.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        details = os.fstat(lock)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600:
            raise SafeFailure('executor lock has unsafe owner, link or mode')
        fcntl.flock(lock, fcntl.LOCK_EX)
        return Executor(policy, context).perform(step)
    finally:
        os.close(lock)
