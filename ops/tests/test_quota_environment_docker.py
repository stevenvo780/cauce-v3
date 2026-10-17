import argparse
import base64
import hashlib
import json
import os
import pathlib
import pwd
import re
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT / 'cli'))
bundle_digest = __import__('fleet_executor_runtime').bundle_digest
runtime = __import__('quota_runtime')
EXECUTOR = ROOT / 'cli' / 'fleet-executor.py'
LOGIN = ROOT / 'cli' / 'provider-login.py'
TASK = '20261013T070408-20261013T065533-r-20261013T051651-t04-mis-cuotas-ciclo-web-real'
EVIDENCE = REPO / '.test-state/quota-environments' / TASK / 'runtime'
PROVIDERS = {'claude': '@anthropic-ai/claude-code', 'codex': '@openai/codex', 'grok': '@xai-official/grok'}
SCOPE = 'quota-environments'


def run(command, *, input_bytes=None, timeout=90, check=True):
    result = subprocess.run(command, input=input_bytes, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode != 0:
        raise AssertionError(f'{command!r} failed ({result.returncode}): {result.stderr.decode(errors="replace")[-4000:]}')
    return result


def record(directory, name, value):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(json.dumps(value, indent=2) + '\n')


def remove_image(directory):
    metadata = json.loads((directory / 'image.json').read_text())
    tag = metadata['tag']
    if re.fullmatch(r'zz-canary-quota-[a-f0-9]{32}:local', tag) is None:
        raise AssertionError('image tag is outside the canary scope')
    inspected = run(['docker', 'image', 'inspect', tag], check=False)
    if inspected.returncode == 0:
        image = json.loads(inspected.stdout)[0]
        labels = image['Config'].get('Labels') or {}
        if image['Id'] != metadata['image'] or labels.get('cauce.canary.run') != metadata['run_id'] \
                or labels.get('cauce.canary.scope') != SCOPE:
            raise AssertionError('canary image ownership differs')
        run(['docker', 'image', 'rm', tag])
    absent = tag not in run(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).stdout.decode().splitlines()
    if not absent:
        raise AssertionError('canary image removal was not observed')
    record(directory, 'image-cleanup.json', {'tag': tag, 'image_removed_verified': absent})
    return {'image_removed_verified': absent}


def prepare_image(directory):
    directory.mkdir(parents=True, exist_ok=True)
    sources = {name: hashlib.sha256((ROOT / 'cuotas' / name).read_bytes()).hexdigest()
               for name in ('Dockerfile', 'leer-cuota.mjs', 'leer-cuota-grok.mjs', 'codex-http-probe.py')}
    metadata_file = directory / 'image.json'
    if metadata_file.exists():
        previous = json.loads(metadata_file.read_text())
        live = run(['docker', 'image', 'inspect', previous['tag']], check=False)
        if live.returncode == 0:
            remove_image(directory)
    identity = uuid.uuid4().hex
    tag = 'zz-canary-quota-' + identity + ':local'
    command = ['docker', 'build', '--pull=false', '--label', 'cauce.canary.run=' + identity,
               '--label', 'cauce.canary.scope=' + SCOPE, '-t', tag, '-f', str(ROOT / 'cuotas/Dockerfile'), str(ROOT / 'cuotas')]
    built = run(command, timeout=600, check=False)
    (directory / 'build.log').write_bytes(built.stdout + built.stderr)
    record(directory, 'build.json', {'command': command, 'exit': built.returncode, 'sources': sources,
                                   'git_sha': run(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).stdout.decode().strip()})
    if built.returncode:
        raise AssertionError('real quota image build failed; see durable build.log')
    image = json.loads(run(['docker', 'image', 'inspect', tag]).stdout)[0]['Id']
    metadata = {'image': image, 'tag': tag, 'run_id': identity, 'sources': sources}
    record(directory, 'image.json', metadata)
    probe = 'zz-canary-quota-probe-' + identity
    probe_command = ['docker', 'run', '--rm', '--name', probe, '--label', 'cauce.canary.run=' + identity,
                     '--label', 'cauce.canary.scope=' + SCOPE, '--network', 'none', image]
    try:
        script = 'import pathlib,hashlib,json;print(json.dumps({p:hashlib.sha256(pathlib.Path("/usr/local/bin/"+p).read_bytes()).hexdigest() for p in ["claude","codex","grok"]}))'
        hashes = json.loads(run([*probe_command, '/usr/bin/python3', '-c', script]).stdout)
        versions = {provider: run([*probe_command, '/usr/local/bin/' + provider, '--version']).stdout.decode().strip()
                    for provider in PROVIDERS}
        packages = json.loads(run([*probe_command, '/usr/local/bin/npm', 'list', '--global', '--depth=0', '--json']).stdout)['dependencies']
        pins = dict(re.findall(r'^ARG (CLAUDE_CODE|CODEX|GROK)_VERSION=(\S+)$', (ROOT / 'cuotas/Dockerfile').read_text(), re.M))
        for provider, variable in (('claude', 'CLAUDE_CODE'), ('codex', 'CODEX'), ('grok', 'GROK')):
            if packages[PROVIDERS[provider]]['version'] != pins[variable] or pins[variable] not in versions[provider]:
                raise AssertionError('installed provider differs from its Dockerfile pin')
        absent = run([*probe_command, '/usr/bin/python3', '-c',
                      'import pathlib,sys;sys.exit(any(pathlib.Path(p).exists() for p in ["/usr/local/bin/gemini","/usr/local/lib/node_modules/@google/gemini-cli"]))']).returncode == 0
        if not absent or any('gemini' in package for package in packages):
            raise AssertionError('retired Gemini is installed')
        bundle = directory / 'bundle'
        if bundle.exists():
            shutil.rmtree(bundle)
        shutil.copytree(REPO / 'packages/adapter-sdk/descriptors', bundle / 'packages/adapter-sdk/dist/descriptors')
        digest = bundle_digest(str(bundle))
        bundles = {provider: {'directory': str(bundle.resolve()), 'digest': digest, 'executable': '/usr/local/bin/' + provider,
                   'executable_sha256': hashes[provider], 'argv': [], 'descriptor_sha256': hashlib.sha256(
                       (bundle / 'packages/adapter-sdk/dist/descriptors' / (provider + '.json')).read_bytes()).hexdigest()}
                   for provider in PROVIDERS}
        metadata.update(versions=versions, pins=pins, gemini_absent=absent, bundle_digest=digest, bundles=bundles)
        record(directory, 'image.json', metadata)
        return metadata
    finally:
        failed = sys.exc_info()[0] is not None
        inspected = run(['docker', 'inspect', probe], check=False)
        if inspected.returncode == 0:
            observed = json.loads(inspected.stdout)[0]
            labels = observed['Config'].get('Labels') or {}
            if observed['Image'] != image or labels.get('cauce.canary.run') != identity \
                    or labels.get('cauce.canary.scope') != SCOPE:
                raise AssertionError('canary probe ownership differs')
            run(['docker', 'rm', '-f', observed['Id']])
        if probe in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).stdout.decode().splitlines():
            raise AssertionError('canary probe removal was not observed')
        if failed:
            remove_image(directory)


class QuotaEnvironmentDockerCycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = EVIDENCE / ('unittest-' + uuid.uuid4().hex)
        cls.metadata = prepare_image(cls.evidence)
        cls.addClassCleanup(remove_image, cls.evidence)

    def setUp(self):
        self.evidence = self.evidence / self._testMethodName
        temporary = tempfile.TemporaryDirectory(prefix='zz-canary-quota-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.directory = pathlib.Path(temporary.name)
        roots = {name: self.directory / name for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
        for directory in roots.values():
            directory.mkdir(mode=0o700)
        (roots['runtime'] / 'quota-login').mkdir(mode=0o700)
        self.policy = {'schemaVersion': 1, 'host_id': 'zz-canary-host', 'executor_user': pwd.getpwuid(os.geteuid()).pw_name,
                       'roots': {name: str(path) for name, path in roots.items()}, 'native': [], 'containers': {},
                       'profiles': {}, 'hooks': {}, 'bundles': self.metadata['bundles'],
                       'quota_environments': {'image': self.metadata['image'], 'network': 'bridge', 'providers': list(PROVIDERS)}}
        self.policy_file = self.directory / 'policy.json'
        self.policy_file.write_text(json.dumps(self.policy))
        self.policy_file.chmod(0o600)

    def environment(self, provider):
        identity = uuid.uuid4()
        environment = {'id': str(identity), 'company_id': 'zz-canary-company', 'account_id': 'zz-canary-account',
                       'host_id': self.policy['host_id'], 'provider': provider, 'container_name': 'cauce-quota-' + identity.hex}
        self.addCleanup(runtime.remove, self.policy, environment)
        return environment

    def effect(self, environment, action, *, consent=False, verify=False, check=True):
        document = {'operation_id': str(uuid.uuid4()), 'action': action, 'consent': consent, 'environment': environment}
        command = [sys.executable, str(EXECUTOR), '--policy', str(self.policy_file), '--quota-auth-verify' if verify else '--quota']
        result = run(command, input_bytes=json.dumps(document).encode(), timeout=240, check=check)
        receipt = json.loads(result.stdout) if result.returncode == 0 else {'exit': result.returncode}
        record(self.evidence, environment['provider'] + '-' + action + ('-verify' if verify else '') + '.json',
               {'command': command, 'operation_id': document['operation_id'], 'exit': result.returncode, 'receipt': receipt})
        return receipt

    def assert_removed(self, environment):
        container = environment['container_name']
        self.assertNotIn(container, run(['docker', 'ps', '-a', '--format', '{{.Names}}']).stdout.decode().splitlines())
        self.assertNotIn(container + '-profile', run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).stdout.decode().splitlines())

    def test_declared_digest_matches_docker_inspect_and_excludes_gemini(self):
        inspected = json.loads(run(['docker', 'image', 'inspect', self.metadata['tag']]).stdout)[0]
        self.assertEqual(inspected['Id'], self.policy['quota_environments']['image'])
        self.assertEqual(inspected['Id'], self.metadata['image'])
        self.assertTrue(self.metadata['gemini_absent'])
        self.assertNotIn('gemini', json.dumps(inspected['RootFS']))
        environment = self.environment('grok')
        self.effect(environment, 'create')
        absent = run(['docker', 'exec', environment['container_name'], '/usr/bin/python3', '-c',
                      'import pathlib,sys; sys.exit(0 if not any(pathlib.Path(p).exists() for p in '
                      '["/usr/local/bin/gemini","/usr/local/lib/node_modules/@google/gemini-cli"]) else 1)'])
        self.assertEqual(absent.returncode, 0)
        self.effect(environment, 'delete')
        self.assert_removed(environment)

    def test_real_pinned_providers_and_unauthenticated_readers(self):
        capability = json.loads(run([sys.executable, str(EXECUTOR), '--policy', str(self.policy_file), '--capabilities']).stdout)
        self.assertEqual(capability['quota_environments']['providers'], list(PROVIDERS))
        self.assertNotIn('gemini', capability['quota_environments']['providers'])
        for provider in PROVIDERS:
            with self.subTest(provider=provider):
                environment = self.environment(provider)
                created = self.effect(environment, 'create')
                self.assertTrue(created['runtime_verified'])
                self.assertEqual(created['cli_version'], self.metadata['versions'][provider])
                observed = json.loads(run(['docker', 'inspect', environment['container_name']]).stdout)[0]
                security = {'user': observed['Config']['User'], 'image': observed['Image'], 'host': {key: observed['HostConfig'][key]
                            for key in ('ReadonlyRootfs', 'Privileged', 'CapDrop', 'CapAdd', 'Memory', 'PidsLimit', 'Tmpfs', 'NetworkMode')},
                            'mounts': [{key: row[key] for key in ('Destination', 'Type', 'RW', 'Source')} for row in observed['Mounts']]}
                record(self.evidence, provider + '-security.json', security)
                self.assertEqual(observed['Image'], self.policy['quota_environments']['image'])
                self.assertEqual(security['user'], '1000:1000')
                self.assertTrue(security['host']['ReadonlyRootfs'])
                self.assertEqual(security['host']['CapDrop'], ['ALL'])
                self.assertEqual(security['host']['Memory'], 512 * 1024 * 1024)
                self.assertEqual(security['host']['PidsLimit'], 128)
                self.assertEqual(security['host']['Tmpfs'], runtime.TMPFS)
                self.assertEqual({row['Destination'] for row in security['mounts']}, {'/home/node', '/cauce/executor', '/cauce/lifecycle'})
                queried = self.effect(environment, 'query')
                self.assertEqual(queried['cli_version'], created['cli_version'])
                self.assertEqual(queried['observation_status'], 'error')
                self.assertEqual(queried['provider_report']['note'], 'not_authenticated')
                self.assertEqual(queried['provider_report']['windows'], [])
                failed_login = self.effect(environment, 'authenticate', consent=True, verify=True, check=False)
                self.assertNotEqual(failed_login['exit'], 0)
                if provider == 'codex':
                    updated = self.effect(environment, 'update_cli')
                    self.assertTrue(updated['cli_updated_verified'])
                    self.assertRegex(updated['cli_version'], r'^codex-cli \d+\.\d+\.\d+')
                    updated_login = self.effect(environment, 'authenticate', consent=True)['login_plan']
                    self.assertTrue(updated_login['command'][0].startswith('/home/node/.local/lib/node_modules/@openai/codex/'))
                    after = self.effect(environment, 'query')
                    self.assertEqual(after['cli_version'], updated['cli_version'])
                    self.assertEqual(after['provider_report']['note'], 'not_authenticated')
                removed = self.effect(environment, 'delete')
                self.assertTrue(removed['stopped_verified'] and removed['profile_removed_verified'])
                self.assert_removed(environment)

    def test_real_login_pty_does_not_execute_shell_input(self):
        environment = self.environment('codex')
        self.effect(environment, 'create')
        plan = self.effect(environment, 'authenticate', consent=True)['login_plan']
        self.assertEqual(plan['command'][1:], ['login', '--device-auth'])
        self.assertTrue(plan['command'][0].endswith('/vendor/x86_64-unknown-linux-musl/bin/codex')
                        or plan['command'][0].endswith('/vendor/aarch64-unknown-linux-musl/bin/codex'))
        login = subprocess.Popen([sys.executable, str(LOGIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def close_login():
            if login.poll() is None:
                login.terminate()
            try:
                login.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                login.kill()
                login.communicate(timeout=5)
            for stream in (login.stdin, login.stdout, login.stderr):
                stream.close()
        self.addCleanup(close_login)
        login.stdin.write(json.dumps(plan).encode() + b'\n')
        login.stdin.flush()
        pending = bytearray()
        frames = []
        with selectors.DefaultSelector() as poller:
            poller.register(login.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not any(event.get('type') == 'started' for event in frames):
                for _key, _events in poller.select(0.2):
                    data = os.read(login.stdout.fileno(), 65536)
                    if not data:
                        self.fail('real provider login ended before its PTY started')
                    pending.extend(data)
                    while b'\n' in pending:
                        line, _, remaining = pending.partition(b'\n')
                        pending = bytearray(remaining)
                        frames.append(json.loads(line))
        self.assertTrue(any(event.get('type') == 'started' for event in frames))
        for text in ('; sh\n', 'id\n', 'touch /home/node/ESCAPED\n'):
            login.stdin.write(json.dumps({'type': 'input', 'data': base64.b64encode(text.encode()).decode()}).encode() + b'\n')
        login.stdin.flush()
        time.sleep(0.5)
        stdout, stderr = login.communicate(input=b'{"type":"close"}\n', timeout=20)
        self.assertEqual(login.returncode, 0, stderr.decode(errors='replace')[-2000:])
        frames.extend(json.loads(line) for line in (pending + stdout).splitlines())
        output = b''.join(base64.b64decode(event['data']) for event in frames if event.get('type') == 'output')
        self.assertFalse(b'uid=' in output, 'provider PTY produced shell identity output')
        self.assertTrue(any(event.get('type') == 'exited' and event.get('stopped_verified') is True for event in frames))
        escaped = run(['docker', 'exec', environment['container_name'], '/usr/bin/test', '!', '-e', '/home/node/ESCAPED'])
        self.assertEqual(escaped.returncode, 0)
        record(self.evidence, 'pty.json', {'command': plan['command'], 'shell_escape_absent': True, 'uid_output_absent': True,
                                         'stopped_verified': True, 'provider_output_recorded': False, 'authenticated': False})
        self.effect(environment, 'delete')
        self.assert_removed(environment)

    def test_failed_creation_removes_only_its_new_container_and_volume(self):
        environment = self.environment('codex')
        document = {'operation_id': str(uuid.uuid4()), 'action': 'create', 'consent': False, 'environment': environment}
        with patch.object(runtime, 'provider_version', side_effect=runtime.SafeFailure('forced CLI readiness failure')):
            with self.assertRaisesRegex(runtime.SafeFailure, 'forced CLI readiness failure'):
                runtime.perform(self.policy, document)
        self.assert_removed(environment)
        record(self.evidence, 'create-failure-cleanup.json', {'fault': 'CLI readiness verification',
               'container_name': environment['container_name'], 'container_removed_verified': True, 'profile_removed_verified': True})


if __name__ == '__main__':
    if '--prepare-image' in sys.argv or '--remove-image' in sys.argv:
        parser = argparse.ArgumentParser()
        parser.add_argument('--prepare-image', action='store_true')
        parser.add_argument('--remove-image', action='store_true')
        parser.add_argument('--evidence-dir', required=True, type=pathlib.Path)
        args = parser.parse_args()
        print(json.dumps(prepare_image(args.evidence_dir.resolve()) if args.prepare_image else remove_image(args.evidence_dir.resolve())))
    else:
        unittest.main()
