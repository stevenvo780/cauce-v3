from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures
from cauce_container_base import bundle_digest
from plazos import plazo

IDENTITY = 'SYNTHETIC_ACCOUNT_SHARED_ñ_🧪'
IDENTITY_HASH = 'cdec757647de138bf5c817110c408b6c8d7e995789a328b37527fb058416cf18'
PRIVATE_MARKER = 'SYNTHETIC_PRIVATE_OUTPUT_MUST_NOT_ESCAPE'


class AgentQuotaPacketTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    save_policy = fixtures.PhysicalExecutorTest.save_policy

    def tearDown(self):
        self.temporary.cleanup()

    def quota_packet(self):
        agent = {field: self.agent[field] for field in (
            'tenant_id', 'alias', 'runtime_key', 'harness_id', 'host_id', 'runtime_mode',
            'container_name', 'runtime_user', 'home_directory', 'state_directory', 'systemd_user')}
        agent['primary_account_id'] = self.agent.get('primary_account_id')
        return {'operation_id': str(uuid.uuid4()), 'action': 'query_agent', 'agent': agent}

    def query(self, packet=None, executable=None):
        return subprocess.run([sys.executable, '-B', str(executable or fixtures.CLI), '--policy', str(self.policy_file), '--quota'],
            input=json.dumps(self.quota_packet() if packet is None else packet), text=True,
            capture_output=True, timeout=plazo(75))

    def unsupported_agent(self, harness='openclaw'):
        self.policy['bundles'][harness] = copy.deepcopy(self.policy['bundles']['codex'])
        self.agent.update(harness_id=harness, runtime_mode='container', container_name='zz-canary-quota-absent')
        self.policy['containers'][self.agent['container_name']] = {
            'image': 'sha256:' + 'a' * 64, 'runtime_user': self.user, 'systemd_user': self.user,
            'home_directory': str(self.root), 'state_root': str(self.roots['runtime']), 'python': '/usr/bin/python3'}
        self.save_policy()

    def test_harness_without_reader_returns_explicit_state_without_a_container_or_credential(self):
        for harness in ('openclaw', 'muse', 'hermes', 'opencode'):
            with self.subTest(harness=harness):
                self.unsupported_agent(harness)
                packet = self.quota_packet()
                response = self.query(packet)
                self.assertEqual(response.returncode, 0, response.stderr)
                result = json.loads(response.stdout)
                self.assertEqual(result['status'], 'unsupported')
                self.assertEqual(result['reason'], 'quota_reader_unavailable')
                self.assertEqual(result['operation_id'], packet['operation_id'])
                self.assertEqual(set(result), {'status', 'reason', 'operation_id', 'tenant', 'alias',
                    'host_id', 'container_name', 'harness', 'captured_at'})

    def test_foreign_scope_and_arbitrary_execution_fields_are_rejected(self):
        self.unsupported_agent()
        variants = []
        for field, value in [('host_id', 'foreign-host'), ('runtime_user', 'unapproved'),
                             ('home_directory', '/another/home'), ('tenant_id', 'bad/tenant')]:
            packet = self.quota_packet()
            packet['agent'][field] = value
            variants.append(packet)
        for field in ('command', 'env', 'profile_path'):
            packet = self.quota_packet()
            packet[field] = PRIVATE_MARKER
            variants.append(packet)
        for packet in variants:
            with self.subTest(packet=packet):
                response = self.query(packet)
                self.assertNotEqual(response.returncode, 0)
                self.assertNotIn(PRIVATE_MARKER, response.stdout + response.stderr)

class AgentQuotaProjectionTest(unittest.TestCase):
    def project(self, provider, raw):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_agent_quota import safe_observation
        from quota_snapshot import ERROR_CODES
        return safe_observation(provider, raw, sorted(ERROR_CODES))

    def test_claude_and_grok_identities_hash_like_misquotas_without_exposing_metadata(self):
        for provider, expected in [('claude', 'b255561690a6288fa96112aa25336f39d1a659ac536b5b28d3e2a82344c66f48'),
                                   ('grok', '6aef42440dceae734b4c18d8d274de16b3664948f3dafe984bb4f65cf749e948')]:
            raw = {'ok': True, 'provider': provider, 'windows': [], 'tokens': PRIVATE_MARKER,
                'email': IDENTITY, 'plan': PRIVATE_MARKER, 'note': PRIVATE_MARKER}
            if provider == 'claude':
                raw['account_id'] = IDENTITY
            result = self.project(provider, raw)
            self.assertEqual(result['identity_hash'], expected)
            self.assertNotIn(IDENTITY, json.dumps(result, ensure_ascii=False))
            self.assertNotIn(PRIVATE_MARKER, json.dumps(result))

def release_readable(tree: pathlib.Path) -> None:
    """Give a checkout tree the read modes of a packaged release (build-adapter-release.sh applies go=rX)."""
    for item in [tree, *tree.rglob('*')]:
        if item.is_symlink():
            continue
        mode = item.stat().st_mode
        readable_mode = mode | (0o055 if item.is_dir() or mode & 0o111 else 0o044)
        if readable_mode != mode:
            item.chmod(readable_mode)


class DockerAgentQuotaTest(AgentQuotaPacketTest):
    @classmethod
    def setUpClass(cls):
        probe = subprocess.run(['docker', 'image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'],
            capture_output=True, text=True, timeout=plazo(15))
        if probe.returncode:
            raise unittest.SkipTest('disposable local Python image is unavailable')
        # The non-root reader requires packaged release go=rX modes on the mounted checkout.
        for tree in ('cli', 'container-runtime'):
            release_readable(fixtures.OPS / tree)
        cls.image_tag = 'zz-canary-agent-quota-' + uuid.uuid4().hex[:12]
        with tempfile.TemporaryDirectory(prefix='zz-canary-quota-image-', dir='/var/tmp') as directory:
            root = pathlib.Path(directory)
            reader = root / 'reader.py'
            reader.write_text('''#!/usr/local/bin/python3.12
import json,os,pathlib,sys,time
assert os.getuid()==65534 and os.getgid()==65534
assert os.environ['HOME']=='/nonexistent'
assert sys.argv[1].startswith('/nonexistent/.codex')
assert 'CODEX_HOME' not in os.environ and 'CLAUDE_CONFIG_DIR' not in os.environ
fixture_file=pathlib.Path(sys.argv[1])/'fixture.json'
if not fixture_file.is_file():
    fixture_file=pathlib.Path('/nonexistent/.codex/fixture.json')
document=json.loads(fixture_file.read_text())
if document.get('mode')=='missing_identity': document['extra']={}
if document.get('mode')=='invalid':
    print(document['private']);print(document['private'],file=sys.stderr);sys.exit(2)
if document.get('mode')=='oversized':
    print('x'*65537);sys.exit(0)
if document.get('mode')=='restart':
    pathlib.Path('/nonexistent/.codex/started').write_text('ready');time.sleep(3)
print(json.dumps(document,ensure_ascii=False))
''')
            (root / 'Dockerfile').write_text('FROM python:3.12-slim\nCOPY --chmod=0755 reader.py /usr/local/bin/fake-quota-reader\n')
            built = subprocess.run(['docker', 'build', '--pull=false', '--network', 'none', '--tag', cls.image_tag, directory],
                capture_output=True, text=True, timeout=plazo(90))
            if built.returncode:
                raise AssertionError('disposable quota image failed to build: ' + built.stderr)
        cls.image = subprocess.run(['docker', 'image', 'inspect', cls.image_tag, '--format', '{{.Id}}'],
            capture_output=True, text=True, timeout=plazo(15), check=True).stdout.strip()

    @classmethod
    def tearDownClass(cls):
        result = subprocess.run(['docker', 'image', 'rm', cls.image_tag], capture_output=True, timeout=plazo(20))
        if result.returncode:
            raise AssertionError('disposable quota image cleanup failed')

    def setUp(self):
        super().setUp()
        self.resources = []
        descriptor = self.bundle / 'packages/adapter-sdk/dist/descriptors/codex.json'
        document = json.loads(descriptor.read_text())
        document['provider']['quota_argv'] = ['/usr/local/bin/fake-quota-reader', '/home/node/.codex']
        descriptor.write_text(json.dumps(document))
        self.policy['bundles']['codex']['digest'] = bundle_digest(str(self.bundle))
        self.bundle.chmod(0o755)

    def tearDown(self):
        try:
            for name in self.resources:
                subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=plazo(20))
                subprocess.run(['docker', 'volume', 'rm', name + '-state', name + '-provider-profiles'],
                    capture_output=True, timeout=plazo(20))
                containers = subprocess.run(['docker', 'ps', '-aq', '--filter', 'name=' + name],
                    capture_output=True, text=True, timeout=plazo(15), check=True).stdout.strip()
                volumes = subprocess.run(['docker', 'volume', 'ls', '-q', '--filter', 'name=' + name],
                    capture_output=True, text=True, timeout=plazo(15), check=True).stdout.strip()
                self.assertEqual((containers, volumes), ('', ''), 'canary cleanup left resources')
        finally:
            super().tearDown()

    def configure_canary(self, raw=None, harness='codex', dynamic_account=None, binds=None):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_container import create_container
        from fleet_executor_policy import approve_agent
        name = 'zz-canary-agent-quota-' + uuid.uuid4().hex[:12]
        self.resources.append(name)
        self.agent.update(alias='canary_' + uuid.uuid4().hex[:12], harness_id=harness,
            runtime_key='quota-' + uuid.uuid4().hex[:12], runtime_mode='container', container_name=name,
            runtime_user='nobody', home_directory='/nonexistent')
        self.agent['state_directory'] = '/tmp/cauce-state/' + self.agent['runtime_key']
        self.agent['primary_account_id'] = dynamic_account
        if dynamic_account is not None:
            if 'profile_templates' not in self.policy:
                self.policy['profile_templates'] = []
            self.policy['profile_templates'].append({
                'provider': harness, 'runtime_user': 'nobody', 'path_root': '/nonexistent/.codex',
                'runtime_mode': 'container', 'container_name': name,
                'command': '/usr/local/bin/fake-quota-reader', 'command_sha256': 'a' * 64,
            })
        self.policy['containers'][name] = {'image': self.image, 'runtime_user': 'nobody',
            'systemd_user': self.user, 'home_directory': '/nonexistent', 'state_root': '/tmp/cauce-state',
            'profile_root': '/nonexistent/.codex', 'python': '/usr/local/bin/python3.12'}
        self.policy['bundles']['codex'].update(executable='/usr/local/bin/python3.12', executable_sha256=None)
        self.policy['bundles'][harness] = copy.deepcopy(self.policy['bundles']['codex'])
        self.save_policy()
        create_container(self.policy, approve_agent(self.policy, self.agent), binds)
        subprocess.run(['docker', 'start', name], capture_output=True, timeout=plazo(15), check=True)
        observation = {'error': None, 'fuente': 'wham-http', 'extra': {'account_id': IDENTITY},
            'provider': 'codex', 'email': 'private@fixture.invalid', 'tokens': PRIVATE_MARKER,
            'plan': PRIVATE_MARKER, 'source': IDENTITY, 'private': PRIVATE_MARKER,
            'ventanas': [{'clave': '5h', 'limitId': 'default', 'usado_pct': 25, 'restante_pct': 75,
                'windowMinutes': 300, 'label': PRIVATE_MARKER, 'family': IDENTITY, 'model': PRIVATE_MARKER,
                'account_id': 'forged-account', 'binding_note': PRIVATE_MARKER, 'status': 'ok'}]}
        observation.update(raw or {})
        program = ('import json,os,pathlib,sys;p=pathlib.Path("/nonexistent/.codex");'
            'p.chmod(448);os.chown(p,65534,65534);f=p/"fixture.json";'
            'f.write_text(sys.stdin.read());f.chmod(384);os.chown(f,65534,65534)')
        if dynamic_account is not None:
            account_hash = hashlib.sha256(dynamic_account.encode()).hexdigest()
            program += (f';sub=p/"{self.agent["runtime_key"]}"/"{account_hash}";'
                'sub.mkdir(parents=True,exist_ok=True);sub.chmod(448);os.chown(sub,65534,65534);'
                'f2=sub/"fixture.json";f2.write_text(f.read_text());f2.chmod(384);os.chown(f2,65534,65534)')
        subprocess.run(['docker', 'exec', '-i', '--user', '0', name, '/usr/local/bin/python3.12', '-B', '-c', program],
            input=json.dumps(observation), capture_output=True, text=True, timeout=plazo(15), check=True)
        return self.quota_packet()

    def measured(self, packet):
        response = self.query(packet)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertNotIn(IDENTITY, response.stdout + response.stderr)
        self.assertNotIn(PRIVATE_MARKER, response.stdout + response.stderr)
        self.assertNotIn('private@fixture.invalid', response.stdout + response.stderr)
        receipt = json.loads(response.stdout)
        self.assertEqual(receipt['status'], 'measured')
        self.assertEqual(receipt['identity_hash'], IDENTITY_HASH)
        self.assertEqual(receipt['operation_id'], packet['operation_id'])
        self.assertNotIn('account_id', receipt['provider_report'])
        for window in receipt['provider_report']['windows']:
            self.assertNotIn('account_id', window)
        return receipt

    def test_real_reader_uses_the_approved_uid_home_and_profile_without_refresh(self):
        packet = self.configure_canary()
        receipt = self.measured(packet)
        self.assertEqual(receipt['observation_status'], 'ok')
        window = receipt['provider_report']['windows'][0]
        self.assertEqual((window['window_key'], window['used_percent'], window['remaining_percent']), ('5h', 25, 75))
        self.assertEqual(receipt['container_name'], packet['agent']['container_name'])

    def test_two_real_containers_return_the_same_identity_hash_for_shared_account_ingestion(self):
        packets = [self.configure_canary(), self.configure_canary()]
        receipts = [self.measured(packet) for packet in packets]
        self.assertNotEqual(receipts[0]['container_name'], receipts[1]['container_name'])
        self.assertEqual(receipts[0]['identity_hash'], receipts[1]['identity_hash'])
        unsupported = self.configure_canary(harness='openclaw')
        response = self.query(unsupported)
        self.assertEqual(response.returncode, 0, response.stderr)
        receipts.append(json.loads(response.stdout))
        self.assertEqual(receipts[-1]['status'], 'unsupported')
        packets.append(unsupported)
        destination = os.environ.get('CAUCE_AGENT_QUOTA_RECEIPTS')
        if destination:
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                json.dump({'receipts': receipts,
                    'snapshots': [{'operation_id': packet['operation_id'], **packet['agent']} for packet in packets]},
                    stream, ensure_ascii=False)
                stream.write('\n')

    def test_provider_failure_with_known_identity_preserves_a_closed_error_code(self):
        receipt = self.measured(self.configure_canary({'error': PRIVATE_MARKER, 'error_code': 'token_expired', 'ventanas': []}))
        self.assertEqual(receipt['observation_status'], 'error')
        self.assertEqual(receipt['provider_report']['note'], 'token_expired')

    def staged_releases(self, previous_name='a' * 64, current_name='b' * 64):
        """Two sibling release trees named by revision, as a host keeps them after a deploy, and the executor of the current one."""
        base = pathlib.Path(self.temporary.name) / 'releases'
        trees = {}
        for name in (previous_name, current_name):
            for tree in ('cli', 'container-runtime', 'scripts'):
                shutil.copytree(fixtures.OPS / tree, base / name / 'ops' / tree, ignore=shutil.ignore_patterns('__pycache__'))
            release_readable(base / name)
            trees[name] = base / name
        base.chmod(0o755)
        return trees[previous_name], trees[current_name], trees[current_name] / 'ops/cli/fleet-executor.py'

    def test_container_bound_to_the_previous_release_is_still_measured_after_a_deploy(self):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_container import runtime_mounts
        previous, current, executable = self.staged_releases()
        binds = runtime_mounts(self.policy, {'harness_id': 'codex'}, previous, current)
        packet = self.configure_canary(binds=binds)
        response = self.query(packet, executable)
        self.assertEqual(response.returncode, 0, response.stderr)
        receipt = json.loads(response.stdout)
        self.assertEqual((receipt['status'], receipt['identity_hash']), ('measured', IDENTITY_HASH))
        self.assertNotIn(IDENTITY, response.stdout + response.stderr)

    def test_container_bound_to_a_release_that_is_not_an_installed_sibling_is_refused(self):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_container import runtime_mounts
        previous, current, executable = self.staged_releases(previous_name='not-a-release')
        binds = runtime_mounts(self.policy, {'harness_id': 'codex'}, previous, current)
        packet = self.configure_canary(binds=binds)
        response = self.query(packet, executable)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn('container runtime mounts differ', response.stderr)
        self.assertNotIn(IDENTITY, response.stdout + response.stderr)

class AgentQuotaContrastAuditTest(unittest.TestCase):
    RESET = '2026-10-13T12:00:00Z'

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        module = __import__('fleet_executor_agent_quota')
        cls.contrast = staticmethod(module.contrast_same_instant)
        cls.audit = staticmethod(module.audit_quota_logs)
        cls.redact = staticmethod(module.redact_secrets)
        cls.matches = staticmethod(module.secret_match_count)

    def web(self, rows):
        return {'windows': [{'window_key': key, 'remaining_percent': percent, 'reset_at': reset} for key, percent, reset in rows]}

    def coutas(self, provider, rows):
        if provider == 'codex':
            return {'ventanas': [{'clave': key, 'restante_pct': percent, 'reinicia_en': reset} for key, percent, reset in rows]}
        return {'windows': [{'key': key, 'remainingPercent': percent, 'resetAt': reset} for key, percent, reset in rows]}

    def pair(self, claude_coutas=None):
        web = {'claude': self.web([('five_hour', 40, self.RESET), ('seven_day', 70, self.RESET)]),
               'codex': self.web([('7d', 55, self.RESET)]), 'grok': self.web([('7d', 80, self.RESET)])}
        coutas = {'claude': claude_coutas or self.coutas('claude', [('five_hour', 41, self.RESET), ('seven_day', 70, self.RESET)]),
                  'codex': self.coutas('codex', [('7d', 55, self.RESET)]),
                  'grok': self.coutas('grok', [('7d', 79, self.RESET)])}
        return web, coutas

    def test_planted_secret_is_detected_and_absent_after_redaction(self):
        planted = 'access_token=zz-canary refresh_token=zz sk-ant-zz eyJhbGci user_code=device'
        gateway = [planted, 'ordinary gateway line']
        host = ['host log access_token leaked once']
        events = [{'action': 'authenticate', 'note': 'user_code=abcd eyJabc'}]
        raw = self.audit(gateway, host, events)
        self.assertGreater(raw['matches'], 0)
        self.assertGreater(raw['gateway'], 0)
        self.assertGreater(raw['host'], 0)
        self.assertGreater(raw['audit_events'], 0)
        self.assertEqual(self.matches(planted), 5)
        self.assertEqual(self.matches(self.redact(planted)), 0)
        clean_events = json.loads(self.redact(json.dumps(events[0])))
        clean = self.audit([self.redact(line) for line in gateway], [self.redact(line) for line in host], [clean_events])
        self.assertEqual(clean, {'matches': 0, 'gateway': 0, 'host': 0, 'audit_events': 0})


if __name__ == '__main__':
    unittest.main()
