from __future__ import annotations

import contextlib
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
from fleet_executor_native_retirement import decommission_native, verify_native_stopped
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
from fleet_migration import approve_step, placement_role

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


_PREVIOUS_FIELDS = ('tenant_id', 'alias', 'runtime_key', 'harness_id', 'host_id', 'runtime_mode', 'container_name',
                    'runtime_user', 'systemd_user', 'home_directory', 'state_directory', 'primary_room_id',
                    'primary_account_id', 'model_id', 'reasoning_effort', 'enabled', 'lifecycle_state')


def _canonical_extensions(value) -> list:
    rows = value if isinstance(value, list) else []
    normalized = [{key: row[key] for key in sorted(row)} if isinstance(row, dict) else row for row in rows]
    return sorted(normalized, key=lambda row: json.dumps(row, sort_keys=True, separators=(',', ':')))


def _canonical_previous(rows) -> list:
    if not isinstance(rows, list):
        return rows
    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            normalized.append(row)
            continue
        if (row.get('runtime_key') is None or ('runtime_mode' in row and row.get('runtime_mode') is None
                and isinstance(row.get('primary_room_id'), str))) \
                and row.get('lifecycle_state') == 'draft' and row.get('enabled') is not True:
            continue
        agent = {field: row.get(field) for field in _PREVIOUS_FIELDS}
        agent['extensions'] = _canonical_extensions(row.get('extensions', []))
        normalized.append(agent)
    return sorted(normalized, key=lambda row: (str(row.get('tenant_id')), str(row.get('alias')), str(row.get('runtime_key'))))


def _canonical_memberships(rows) -> list:
    if not isinstance(rows, list):
        return rows
    normalized = [{'tenant_id': row.get('tenant_id'), 'alias': row.get('alias'), 'room_id': row.get('room_id'),
                   'role': row.get('role'), 'enabled': row.get('enabled', True)} if isinstance(row, dict) else row for row in rows]
    return sorted(normalized, key=lambda row: (str(row.get('tenant_id')), str(row.get('alias')), str(row.get('room_id'))))


def _canonical_fenced(rows, context: dict) -> list:
    if not isinstance(rows, list):
        return rows
    normalized = [{'resource': row.get('resource'), 'tenant_id': row.get('tenant_id'), 'alias': row.get('alias')}
                  if isinstance(row, dict) else row for row in rows]
    normalized = sorted(normalized, key=lambda row: (str(row.get('tenant_id')), str(row.get('alias'))))
    request, target = context['request'], context['request']['target']
    if request['kind'] == 'create' and target['resource'] == 'agent' \
            and {(row.get('tenant_id'), row.get('alias')) for row in normalized if isinstance(row, dict)} \
            <= {(target['tenant_id'], target['alias'])}:
        return [{'resource': 'agent', 'tenant_id': target['tenant_id'], 'alias': target['alias']}]
    return normalized


def _canonical_inputs(context: dict) -> dict:
    inputs = {'fenced_targets': _canonical_fenced(context['fenced_targets'], context),
              'previous_agents': _canonical_previous(context['previous_agents']),
              'desired_memberships': _canonical_memberships(context['desired_memberships'])}
    if placement_role(context) is not None:
        inputs['placement_role'] = placement_role(context)
    if 'global_desired_memberships' in context:
        inputs['global_desired_memberships'] = _canonical_memberships(context['global_desired_memberships'])
    return inputs


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
        raw_inputs = {name: context[name] for name in ('fenced_targets', 'previous_agents', 'desired_memberships')}
        if placement_role(context) is not None:
            raw_inputs['placement_role'] = placement_role(context)
        if 'global_desired_memberships' in context:
            raw_inputs['global_desired_memberships'] = context['global_desired_memberships']
        raw_hash = hashlib.sha256(json.dumps(raw_inputs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        inputs_hash = hashlib.sha256(json.dumps(_canonical_inputs(context), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        stored_hash = self.journal.setdefault('inputs_sha256', inputs_hash)
        if stored_hash not in (inputs_hash, raw_hash):
            raise SafeFailure('operation replay changed its fenced placements or membership intent')
        if stored_hash == raw_hash and stored_hash != inputs_hash:
            self.journal['inputs_sha256'] = inputs_hash
        self.journal.setdefault('expected_applied', load_applied_fleet(self.state)['generation'] if (self.state / 'applied-fleet.json').exists() else None)
        self.save()

    def save(self):
        atomic_write(_destination(self.operation, 'effects.json'), json.dumps(self.journal, sort_keys=True).encode(), mode=0o600)

    def record_extension_receipt(self) -> dict:
        from fleet_executor_profiles import accept_extension_receipt
        receipt_path = self.operation / 'extension-receipt.json'
        if not receipt_path.is_file() or receipt_path.is_symlink():
            return {}
        receipt = accept_extension_receipt(self.agent(), receipt_path.read_bytes())
        self.journal['extensions_receipt'] = receipt
        return {'extensions_receipt': receipt}

    def agent(self):
        return approve_agent(self.policy, target_agent(self.context))

    def stop_placement(self, row: dict):
        entry = self.journal.get('native_decommission', {}).get(row['runtime_key'])
        if entry is not None:
            verify_native_stopped(self.policy, row, entry, absent=entry.get('complete') is True)
        else:
            stop(self.policy, row)

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
        if placement_role(self.context) == 'source':
            if self.journal.get('stopped') is not True or self.journal.get('revocation_complete') is not True:
                raise SafeFailure('migration source artifacts require observed stop and revocation')
            source = copy.deepcopy(self.context.get('snapshot'))
            if not isinstance(source, dict):
                raise SafeFailure('missing durable migration source snapshot')
            agent = self.agent()
            identity = (agent['tenant_id'], agent['alias'])
            if any((row.get('tenant_id'), row.get('alias')) == identity for row in source.get('agents', [])):
                raise SafeFailure('migration source snapshot still contains the moved agent')
            source['memberships'] = [row for row in source.get('memberships', [])
                                     if (row.get('tenant_id'), row.get('alias')) != identity]
            receipt = self.materialize_snapshot(source)
            publish_applied(self.state, receipt['generation'], self.journal['expected_applied'])
            self.journal['generation'] = receipt['generation']
            self.save()
            return {'artifact_sha256': receipt['generation']}
        if kind in {'stop', 'retire', 'purge'}:
            if self.journal.get('stopped') is not True or (kind != 'stop' and self.journal.get('revocation_complete') is not True):
                raise SafeFailure('fenced artifacts require observed stop and revocation')
            rows = scoped_agents(self.policy, self.context)
            for row in rows:
                self.stop_placement(row)
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
        if observed.get('extensions', []) != agent.get('extensions', []):
            raise SafeFailure('durable snapshot extensions differ from approved request')
        from fleet_executor_policy import approve_extensions
        approve_extensions(self.policy, agent)
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
        if 'authority' in self.policy:
            from fleet_executor_authority import prepare
            proof = prepare(self.policy, self.context, agent, generation / 'flota.json',
                generation / ('bootstrap/manifests' if bootstrap else 'manifests') / (agent['runtime_key'] + '.yaml'), bootstrap=bootstrap)
            self.journal[('bootstrap' if bootstrap else 'normal') + '_credentials'] = proof['certificate_fingerprint']
            self.save()
            return {'certificate_fingerprint': proof['certificate_fingerprint']}
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
        ttl_days = 1 if bootstrap else max(1, (expires - datetime.datetime.now(datetime.UTC)).days)
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
        if self.context['request']['kind'] == 'start':
            if 'generation' not in self.journal:
                self.artifacts()
            if 'bootstrap_credentials' not in self.journal:
                self.credentials()
        self.generation()
        agent = self.agent()
        if self.context['request']['kind'] == 'update' and placement_role(self.context) != 'destination':
            previous = [row for row in self.context['previous_agents'] if row.get('tenant_id') == agent['tenant_id'] and row.get('alias') == agent['alias']]
            if len(previous) != 1:
                raise SafeFailure('update requires the original runtime placement')
            if previous[0].get('runtime_key') != agent['runtime_key']:
                raise SafeFailure('update cannot replace the physical runtime identity')
            if previous[0].get('extensions', []) != agent.get('extensions', []) and previous[0].get('runtime_mode') == 'container' \
                    and agent['runtime_mode'] == 'container' and previous[0].get('container_name') == agent['container_name']:
                from fleet_executor_container import recreate_extensions
                recreate_extensions(self.policy, previous[0], agent)
            else:
                stop(self.policy, previous[0])
        elif self.context['request']['kind'] == 'start' and 'runtime' not in self.journal:
            self.stop()
        evidence = start(self.policy, agent, operation_id=self.context['operation_id'])
        self.journal['runtime'] = evidence['runtime_digest']
        evidence.update(self.record_extension_receipt())
        self.save()
        return evidence

    def stop(self):
        rows = scoped_agents(self.policy, self.context)
        for row in rows:
            self.stop_placement(row)
        self.journal['stopped'] = True
        self.save()
        return {'stopped_verified': True}

    def revoke(self):
        if self.journal.get('stopped') is not True:
            raise SafeFailure('revocation requires observed stop')
        rows = scoped_agents(self.policy, self.context)
        revoked = self.journal.setdefault('revoked', {})
        for row in rows:
            self.stop_placement(row)
            from fleet_executor_authority import revocation_scope
            revocation_policy, scoped = revocation_scope(self.policy, self.context, row)
            references = credential_references(revocation_policy, scoped)
            key = row['runtime_key']
            if key in revoked and (references.get('legacy') != revoked[key].get('legacy')
                    or references['credentials'] and references != {name: value for name, value in revoked[key].items() if name != 'central'}):
                raise SafeFailure('credential identity changed after observed revocation')
            if 'authority' in self.policy:
                from fleet_executor_authority import revoke
                references['central'] = revoke(self.policy, self.context, row, self.journal, self.save)
            else:
                remove_registry_principals(self.policy, row, script)
            if key not in revoked or references.get('legacy') is not None:
                observed = invoke_revoke(revocation_policy, self.context, scoped, references)
                if observed.get('revocation_verified') is not True:
                    raise SafeFailure('old Cauce credentials were not observed rejected')
                if references.get('legacy') is not None and 'authority' not in self.policy:
                    from fleet_executor_legacy_credentials import capture_absence
                    self.journal.setdefault('legacy_authority_absence', {})[key] = capture_absence(references, row)
                self.stop_placement(row)
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
        known = self.journal.get('removed')
        removed = known if isinstance(known, list) else []
        record = self.journal.get('purged') is not True
        for row in rows:
            if 'authority' in self.policy:
                from fleet_executor_authority import revoke
                revoke(self.policy, self.context, row, self.journal, self.save)
            if credential_references(self.policy, row)['credentials']:
                raise SafeFailure('new credential material appeared after revocation')
            decommissioned = decommission_native(self.policy, row, self.journal, self.save)
            observed = purge_runtime(self.policy, row, decommissioned=decommissioned,
                                     journal=self.journal, save=self.save)
            if decommissioned is not None:
                observed['removed'] = [*decommissioned['removed'], *observed['removed']]
            if record and isinstance(observed, dict):
                fresh = [item for item in observed.get('removed', []) if isinstance(item, dict)]
                if fresh:
                    for item in fresh:
                        if item not in removed:
                            removed.append(item)
                    self.journal['removed'] = removed
                    self.save()
        if record:
            self.journal['purged'] = True
            self.journal['removed'] = removed
            self.save()
        elif not isinstance(known, list):
            return {'stopped_verified': True, 'revocation_verified': True}
        evidence = {'stopped_verified': True, 'revocation_verified': True, 'removed': removed}
        if self.journal.get('native_decommission'):
            evidence['native_decommissioned'] = True
        return evidence

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
        self.journal.pop('account_identity', None)
        result = {'evidence': {'provider_verified': True}}
        if 'account_identity' in observed:
            self.journal['account_identity'] = observed['account_identity']
            result['account_identity'] = observed['account_identity']
        self.save()
        return result

    def authenticated_binding_matches(self, account, binding: dict) -> bool:
        proof = self.journal.get('authenticated')
        if proof == {'account_id': account, 'binding': binding}:
            return True
        if not isinstance(proof, dict) or proof.get('account_id') != account:
            return False
        previous = proof.get('binding')
        from fleet_provider_identity import valid_account_identity
        identity = self.journal.get('account_identity')
        return isinstance(previous, dict) and isinstance(previous.get('identity'), str) \
            and previous['identity'].startswith('unverified:') and valid_account_identity(identity) \
            and binding == {**previous, 'identity': identity}

    def profile(self):
        agent = self.agent()
        self.ensure_runtime(agent)
        account, binding = binding_for(self.policy, agent)
        if not self.authenticated_binding_matches(account, binding):
            # A deploy that pinned a new image changes the binding's command pins after the login: the stored credential
            # is proven again against the current binaries (the same probe as «Verificar conexión») instead of failing.
            if self.authenticate().get('awaiting_auth') is True or not self.authenticated_binding_matches(account, binding):
                raise SafeFailure('provider profile has no current authenticated identity proof')
        observed = invoke(self.policy, self.context, agent, 'profile')
        if observed.get('profile_verified') is not True:
            raise SafeFailure('provider profile was not acknowledged')
        self.journal['profile'] = True
        self.save()
        return {'profile_verified': True}

    def ensure_runtime(self, agent: dict) -> None:
        """The probes need a live runtime on the approved image. The console login may have stopped it, the adapter may
        have exited, or a deploy may have pinned a new image since the runtime step: start() is idempotent and recreates
        a container left on an older image before (re)starting its adapter. It runs before any binding check, which
        validates the container against the current image."""
        self.journal['runtime'] = start(self.policy, agent, operation_id=self.context['operation_id'])['runtime_digest']
        self.journal.pop('login_stopped', None)
        self.record_extension_receipt()
        self.save()

    def verify(self):
        if self.journal.get('profile') is not True or 'runtime' not in self.journal:
            raise SafeFailure('runtime profile was not prepared before functional verification')
        agent = self.agent()
        self.ensure_runtime(agent)
        observed = invoke(self.policy, self.context, agent, 'verify', phase='bootstrap')
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
        if agent['runtime_mode'] == 'container':
            # A deploy between steps pins a new image; refresh the container before the binding check validates it.
            from fleet_executor_container import observe_container
            observe_container(self.policy, agent)
        account, binding = binding_for(self.policy, agent)
        if not self.authenticated_binding_matches(account, binding):
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
        evidence.update(self.record_extension_receipt())
        self.save()
        return {'artifact_sha256': receipt['generation'], **evidence}

    def admit_memberships(self):
        if self.context['request']['kind'] != 'restore':
            raise SafeFailure('membership admission requires restore')
        self.generation()
        target = self.context['request']['target']
        source = copy.deepcopy(self.context['snapshot'])
        for member in self.context.get('global_desired_memberships', self.context['desired_memberships']):
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
                if row.get('runtime_mode') == 'container':
                    from fleet_executor_container import stop_container
                    stop_container(self.policy, row, login=True)
                else:
                    self.stop_placement(row)
            if 'runtime' in self.journal:
                self.journal['login_stopped'] = True
                self.save()
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
        if self.context.get('restore_previous_runtime') is True:
            return self.restore_previous_runtime()
        rows = self.physical_placements()
        for row in rows:
            if row.get('runtime_mode') == 'container':
                from fleet_executor_container import discard_operation
                discard_operation(self.policy, row, self.context['operation_id'])
            self.stop_placement(row)
        self.journal['stopped'] = True
        self.save()
        if placement_role(self.context) == 'source':
            from fleet_executor_authority import call, inventory, scope_for
            for row in rows:
                scope = scope_for(self.policy, self.context, row)
                inventory(call(self.policy['authority'], scope, 'verify_absent'), row, absent=True)
            self.journal['source_compensation_verified'] = True
            self.save()
            return {'stopped_verified': True, 'revocation_verified': True}
        revoked = self.journal.setdefault('compensated', {})
        for row in rows:
            from fleet_executor_authority import revocation_scope
            revocation_policy, scoped = revocation_scope(self.policy, self.context, row)
            references = credential_references(revocation_policy, scoped)
            key = row['runtime_key']
            if key in revoked and references.get('legacy') is None:
                if 'authority' in self.policy:
                    from fleet_executor_authority import revoke
                    revoke(self.policy, self.context, row, self.journal, self.save)
                if references['credentials']:
                    raise SafeFailure('new credentials appeared after compensation')
                remove_runtime_credentials(self.policy, row)
                continue
            if 'authority' in self.policy:
                from fleet_executor_authority import revoke
                references['central'] = revoke(self.policy, self.context, row, self.journal, self.save)
            else:
                remove_registry_principals(self.policy, row, script)
            if references['credentials'] or references.get('legacy') is not None or 'central' in references:
                observed = invoke_revoke(revocation_policy, self.context, scoped, references)
                if observed.get('revocation_verified') is not True:
                    raise SafeFailure('compensation credential rejection was not observed')
                if references.get('legacy') is not None and 'authority' not in self.policy:
                    from fleet_executor_legacy_credentials import capture_absence
                    self.journal.setdefault('legacy_authority_absence', {})[key] = capture_absence(references, row)
            remove_credentials(self.policy, row)
            remove_runtime_credentials(self.policy, row)
            revoked[key] = True
            self.save()
        return {'stopped_verified': True, 'revocation_verified': True}

    def restore_previous_runtime(self) -> dict:
        request = self.context['request']
        previous = self.context['previous_agents']
        if request['kind'] != 'update' or placement_role(self.context) is not None or len(previous) != 1 \
                or any(step not in {'prepare', 'stop'} for step in self.journal.get('attempted', [])) \
                or any(name in self.journal for name in ('bootstrap_credentials', 'normal_credentials', 'runtime')):
            raise SafeFailure('runtime restoration requires an update before credential or runtime effects')
        agent = previous[0]
        placement = request['parameters']['placement']
        if agent.get('runtime_mode') != 'container' or agent.get('runtime_key') != request['parameters']['runtime_key'] \
                or any(agent.get(field) != request['target'].get(field) for field in ('tenant_id', 'alias')) \
                or any(agent.get(field) != placement.get(field) for field in
                       ('host_id', 'container_name', 'runtime_user', 'home_directory', 'state_directory')):
            raise SafeFailure('runtime restoration differs from the previous placement')
        from fleet_executor_container import restore_existing_adapter
        restored = restore_existing_adapter(self.policy, {**agent, '_trusted_accounts': self.context.get('trusted_accounts', []),
                                            '_trusted_accounts_present': 'trusted_accounts' in self.context},
                                            was_running=agent.get('enabled') is True)
        self.journal['previous_runtime_restored'] = restored
        self.save()
        return {**restored, 'revocation_verified': True}

    def physical_placements(self) -> list[dict]:
        rows = scoped_agents(self.policy, self.context)
        if self.context['request']['target']['resource'] == 'agent' and self.context['request']['kind'] in {'create', 'update', 'start', 'restore'}:
            agent = self.agent()
            if any(agent.get(field) != row.get(field) for row in rows for field in
                   ('state_directory', 'runtime_user', 'runtime_mode', 'container_name')) or not rows:
                rows.insert(0, agent)
        return rows


@contextlib.contextmanager
def executor_lock(policy: dict):
    state = pathlib.Path(policy['roots']['state'])
    lock = os.open(_destination(state, '.executor.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        details = os.fstat(lock)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600:
            raise SafeFailure('executor lock has unsafe owner, link or mode')
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield
    finally:
        os.close(lock)


def perform(policy: dict, context: dict, step: str) -> dict:
    approve_step(context, step)
    if placement_role(context) is not None and step in {'credentials', 'revoke', 'compensate'} and 'authority' not in policy:
        raise SafeFailure('migration credentials require the durable central authority')
    if context.get('fleet_scope', {}).get('host_id', policy['host_id']) != policy['host_id']:
        raise SafeFailure('coordinated effect belongs to another host')
    target = context['request']['target']
    if target['resource'] == 'agent':
        approve_agent(policy, target_agent(context))
    with executor_lock(policy):
        return Executor(policy, context).perform(step)
