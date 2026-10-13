import base64
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT / 'cli'))
bundle_digest = __import__('fleet_executor_runtime').bundle_digest
EXECUTOR = ROOT / 'cli' / 'fleet-executor.py'
LOGIN = ROOT / 'cli' / 'provider-login.py'
TAG = 'cauce-quota-cycle-t04:local'


def run(command, *, input_bytes=None, timeout=90, check=True):
    result = subprocess.run(command, input=input_bytes, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode != 0:
        raise AssertionError(f'{command!r} failed ({result.returncode}): {result.stderr.decode(errors="replace")[-4000:]}')
    return result


class QuotaEnvironmentDockerCycleTest(unittest.TestCase):
    def test_disposable_environment_cycles_without_a_real_provider_login(self):
        identity = uuid.uuid4()
        operation = uuid.uuid4()
        container = 'cauce-quota-' + identity.hex
        volume = container + '-profile'
        self.addCleanup(lambda: subprocess.run(['docker', 'rm', '-f', container], capture_output=True, check=False))
        self.addCleanup(lambda: subprocess.run(['docker', 'volume', 'rm', '-f', volume], capture_output=True, check=False))
        self.addCleanup(lambda: subprocess.run(['docker', 'image', 'rm', '-f', TAG], capture_output=True, check=False))
        context = pathlib.Path(tempfile.mkdtemp(prefix='cauce-quota-image-', dir='/var/tmp'))
        self.addCleanup(lambda: shutil.rmtree(context, ignore_errors=True))
        (context / 'codex.c').write_text(textwrap.dedent('''\
            #include <fcntl.h>
            #include <stdio.h>
            #include <string.h>
            #include <unistd.h>
            #include <sys/select.h>
            int main(int argc, char **argv) {
              if (argc == 2 && strcmp(argv[1], "--version") == 0) { puts("codex-cli 9.9.9-canary"); return 0; }
              if (argc == 3 && strcmp(argv[1], "login") == 0 && strcmp(argv[2], "--device-auth") == 0) {
                puts("user code CANARY-CODE"); fflush(stdout);
                int fd = open("/home/node/pty-input", O_WRONLY | O_CREAT | O_APPEND, 0600);
                char buf[4096];
                if (fd < 0) return 2;
                for (;;) {
                  fd_set set; struct timeval tv = {20, 0}; FD_ZERO(&set); FD_SET(0, &set);
                  int ready = select(1, &set, 0, 0, &tv);
                  if (ready <= 0) break;
                  ssize_t count = read(0, buf, sizeof buf);
                  if (count <= 0) break;
                  if (write(fd, buf, (size_t)count) != count) return 2;
                }
                return 0;
              }
              return 2;
            }
            '''))
        compiled = run(['gcc', '-O2', '-o', str(context / 'codex'), str(context / 'codex.c')], timeout=30)
        self.assertEqual(compiled.returncode, 0)
        (context / 'npm').write_text(textwrap.dedent('''\
            #!/usr/bin/python3
            import pathlib, sys
            expected = ['install', '--global', '--prefix', '/home/node/.local', '--ignore-scripts',
                        '--no-audit', '--no-fund', '@openai/codex']
            if sys.argv[1:] != expected:
                raise SystemExit(2)
            target = pathlib.Path('/home/node/.local/bin/codex')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('#!/usr/bin/python3\\nprint("codex-cli 9.9.10-updated")\\n')
            target.chmod(0o755)
            '''))
        (context / 'probe').write_text(textwrap.dedent('''\
            #!/usr/bin/python3
            import json, sys
            if sys.argv[1:] != ['/home/node/.codex', '--refresh-own-session']:
                raise SystemExit(2)
            print(json.dumps({'error': None, 'fuente': 'wham-http', 'extra': {'account_id': 'remote-canary'},
                'ventanas': [{'clave': '5h', 'key': '5h', 'limitId': 'default', 'usado_pct': 1, 'windowMinutes': 300}]}))
            '''))
        (context / 'Dockerfile').write_text(textwrap.dedent('''\
            FROM python:3.12-slim
            RUN id -u node >/dev/null 2>&1 || useradd --uid 1000 --home-dir /home/node --create-home --shell /usr/sbin/nologin node \
             && ln -sf /usr/local/bin/python3 /usr/bin/python3
            COPY --chmod=0755 codex /usr/local/bin/codex
            COPY --chmod=0755 npm /usr/local/bin/npm
            COPY --chmod=0755 probe /usr/local/bin/codex-http-probe.py
            CMD ["sleep", "infinity"]
            '''))
        run(['docker', 'build', '--pull=false', '-t', TAG, str(context)], timeout=180)
        image = run(['docker', 'image', 'inspect', TAG, '--format', '{{.Id}}']).stdout.decode().strip()
        self.assertRegex(image, r'^sha256:[a-f0-9]{64}$')
        temporary = tempfile.TemporaryDirectory(prefix='cauce-quota-cycle-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name)
        roots = {name: root / name for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
        for directory in roots.values():
            directory.mkdir(mode=0o700)
            directory.chmod(0o700)
        (roots['runtime'] / 'quota-login').mkdir(mode=0o700)
        bundle = root / 'bundle'
        bundle.mkdir(mode=0o700)
        shutil.copytree(REPO / 'packages/adapter-sdk/descriptors', bundle / 'packages/adapter-sdk/dist/descriptors')
        policy = {'schemaVersion': 1, 'host_id': 'canaryhost', 'executor_user': pwd.getpwuid(os.geteuid()).pw_name,
                  'roots': {name: str(path) for name, path in roots.items()}, 'native': [], 'containers': {},
                  'profiles': {}, 'hooks': {}, 'bundles': {'codex': {'directory': str(bundle),
                      'digest': bundle_digest(str(bundle)), 'executable': '/usr/local/bin/codex',
                      'executable_sha256': 'a' * 64, 'argv': []}},
                  'quota_environments': {'image': image, 'network': 'none', 'providers': ['codex']}}
        policy_file = root / 'policy.json'
        policy_file.write_text(json.dumps(policy))
        policy_file.chmod(0o600)
        environment = {'id': str(identity), 'company_id': 'humanizar', 'account_id': 'qacanary01',
                       'host_id': 'canaryhost', 'provider': 'codex', 'container_name': container}

        def effect(action, *, consent=False, verify=False):
            document = {'operation_id': str(operation), 'action': action, 'consent': consent, 'environment': environment}
            flag = '--quota-auth-verify' if verify else '--quota'
            result = run([sys.executable, str(EXECUTOR), '--policy', str(policy_file), flag],
                         input_bytes=json.dumps(document).encode(), timeout=120)
            return json.loads(result.stdout)

        created = effect('create')
        self.assertTrue(created['runtime_verified'])
        self.assertIn('9.9.9-canary', created['cli_version'])
        observed = json.loads(run(['docker', 'inspect', container]).stdout)[0]
        mounts = {row['Destination'] for row in observed['Mounts']}
        self.assertEqual(observed['Config']['User'], '1000:1000')
        self.assertTrue(observed['HostConfig']['ReadonlyRootfs'])
        self.assertEqual(observed['HostConfig']['NetworkMode'], 'none')
        self.assertIn('ALL', observed['HostConfig']['CapDrop'])
        self.assertEqual(mounts, {'/home/node', '/cauce/executor', '/cauce/lifecycle'})
        self.assertNotIn('/tmp', mounts)
        run(['docker', 'exec', '--user', '1000:1000', container, '/usr/bin/python3', '-c',
             'open("/home/node/writable","w").write("ok")'])
        authenticated = effect('authenticate', consent=True)
        plan = authenticated['login_plan']
        self.assertEqual(plan['command'][0], '/usr/local/bin/codex')
        self.assertNotIn('sh', plan['command'])
        login = subprocess.Popen([sys.executable, str(LOGIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        login.stdin.write(json.dumps(plan).encode() + b'\n')
        for text in ('; sh\n', 'id\n', 'touch /home/node/ESCAPED\n'):
            login.stdin.write(json.dumps({'type': 'input', 'data': base64.b64encode(text.encode()).decode()}).encode() + b'\n')
        login.stdin.flush()
        typed_text = ''
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and '; sh\n' not in typed_text:
            if login.poll() is not None:
                stdout, stderr = login.communicate(timeout=5)
                self.fail(stderr.decode(errors='replace')[-2000:] + stdout.decode(errors='replace')[-500:])
            typed = run(['docker', 'exec', container, '/usr/bin/python3', '-c',
                         'print(open("/home/node/pty-input","rb").read().decode(), end="")'], check=False)
            typed_text = typed.stdout.decode() if typed.returncode == 0 else ''
            time.sleep(0.2)
        login.stdin.write(b'{"type":"close"}\n')
        login.stdin.close()
        stdout, stderr = login.communicate(timeout=20)
        self.assertEqual(login.returncode, 0, stderr.decode(errors='replace')[-2000:])
        self.assertNotIn(b'uid=', stdout)
        self.assertIn('; sh\n', typed_text)
        self.assertIn('id\n', typed_text)
        self.assertIn('touch /home/node/ESCAPED\n', typed_text)
        escaped = run(['docker', 'exec', container, '/usr/bin/python3', '-c',
                       'import os,sys; sys.exit(0 if not os.path.exists("/home/node/ESCAPED") else 1)'])
        self.assertEqual(escaped.returncode, 0)
        verified = effect('authenticate', consent=True, verify=True)
        self.assertEqual(verified['account_identity'], 'remote-canary')
        self.assertTrue(verified['authenticated_verified'])
        queried = effect('query')
        self.assertEqual(queried['observation_status'], 'ok')
        self.assertEqual(queried['provider_report']['account_id'], 'qacanary01')
        updated = effect('update_cli')
        self.assertTrue(updated['cli_updated_verified'])
        self.assertIn('9.9.10-updated', updated['cli_version'])
        removed = effect('delete')
        self.assertTrue(removed['stopped_verified'] and removed['profile_removed_verified'])
        self.assertNotEqual(run(['docker', 'inspect', container], check=False).returncode, 0)
        names = run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).stdout.decode().splitlines()
        self.assertNotIn(volume, names)


if __name__ == '__main__':
    unittest.main()
