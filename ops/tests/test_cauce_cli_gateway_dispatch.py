from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

OPS = pathlib.Path(__file__).resolve().parents[1]
CLI = OPS / 'cli' / 'cauce'
PASSWORD = 'synthetic-cli-password'
CSRF = 'c' * 43
COOKIE = 'cauce_session=synthetic-dispatch-session'
DENIAL = 'Private denial content must not appear in output.'
PARAMETERS = {
    'runtime_key': 'cli-canary',
    'harness_id': 'codex',
    'primary_room_id': 'office',
    'memberships': [{'room_id': 'office', 'role': 'agent', 'enabled': True}],
    'placement': {
        'host_id': 'canary', 'mode': 'container', 'container_name': 'cli-canary',
        'runtime_user': 'dev', 'home_directory': '/workspace/runtime',
        'state_directory': '/workspace/cli-canary',
    },
    'primary_account_id': 'synthetic-account',
    'display_name': 'Canary',
}
CLEARED = (
    'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY',
    'CAUCE_GATEWAY_URL', 'CAUCE_CONSOLE_SESSION_FILE', 'CAUCE_FLEET_RUNTIME_STATE', 'CAUCE_TEST_EXIT',
)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def request_hash(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def observed(self, body):
        self.server.observed.append({
            'method': self.command,
            'path': urlsplit(self.path).path,
            'query': urlsplit(self.path).query,
            'body': body,
            'cookie': self.headers.get('Cookie'),
            'csrf': self.headers.get('X-CSRF-Token'),
            'origin': self.headers.get('Origin'),
        })

    def send_json(self, status, payload, extra=()):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        for name, value in extra:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        length = int(self.headers.get('Content-Length', '0') or '0')
        raw = self.rfile.read(length) if length else b''
        parsed = json.loads(raw) if raw else None
        self.observed(parsed)
        return parsed

    def do_POST(self):
        payload = self.body()
        path = urlsplit(self.path).path
        if path == '/v3/auth/login':
            if self.server.reject_password or payload.get('password') != PASSWORD:
                self.send_json(401, {'message': DENIAL, 'cookie': COOKIE, 'csrf_token': CSRF})
                return
            self.send_json(200, {
                'authenticated': True, 'login_mode': 'password', 'csrf_token': CSRF,
                'authority': {'home_company': 'synthetic', 'acting_company': 'synthetic'},
            }, [('Set-Cookie', COOKIE + '; HttpOnly; Path=/')])
            return
        if self.headers.get('X-CSRF-Token') != CSRF:
            self.send_json(403, {'error': 'csrf_rejected'})
            return
        if path == '/v3/console/fleet/operations/preview':
            self.send_json(200, {**payload, 'can_apply': True, 'request_sha256': request_hash(payload),
                                  'steps': ['prepare'], 'dependencies': []})
            return
        if path == '/v3/console/fleet/operations':
            digest = request_hash(payload)
            prior = next((row for row in self.server.operations if row['request_sha256'] == digest), None)
            if prior is None:
                prior = {**payload, 'id': 'op-' + digest[:16], 'version': 0, 'status': 'queued',
                         'request_sha256': digest, 'steps': [{'name': 'prepare', 'status': 'pending'}]}
                self.server.operations.append(prior)
            self.send_json(202, {'operation_id': prior['id'], 'status': prior['status'], 'operation': prior})
            return
        self.send_json(404, {'error': 'missing'})

    def do_GET(self):
        self.observed(None)
        parsed = urlsplit(self.path)
        if parsed.path == '/v3/auth/session':
            self.send_json(200, {'authenticated': True, 'login_mode': 'password', 'csrf_token': CSRF})
            return
        if parsed.path == '/v3/console/config':
            self.send_json(200, {
                'revision': 7,
                'tenants': [{'id': 'Alpha'}, {'id': 'Beta'}],
                'agents': [
                    {'tenant_id': 'Alpha', 'alias': 'canary', 'display_name': 'Canary', 'enabled': False,
                     'lifecycle_state': 'draft', 'unpublished_detail': 'omit'},
                    {'tenant_id': 'Beta', 'alias': 'other', 'enabled': True, 'lifecycle_state': 'active'},
                ],
                'retired': {'agents': [{'tenant_id': 'Alpha', 'alias': 'retired', 'enabled': False}]},
            })
            return
        if parsed.path == '/v3/console/fleet/capability':
            self.send_json(200, {'available': True, 'actions': ['create', 'update', 'retire'], 'placements': []})
            return
        if parsed.path == '/v3/console/fleet/operations':
            query = parse_qs(parsed.query)
            rows = [row for row in self.server.operations
                    if row['target'].get('resource') == query.get('resource', [None])[0]
                    and row['target'].get('tenant_id') == query.get('tenant_id', [None])[0]
                    and row['target'].get('alias') == query.get('alias', [None])[0]]
            self.send_json(200, {'operations': rows})
            return
        if parsed.path == '/v3/console/fleet/operations/recent':
            foreign = {'id': 'foreign-op', 'version': 0, 'status': 'queued', 'kind': 'create',
                       'target': {'resource': 'agent', 'tenant_id': 'Beta', 'alias': 'other'},
                       'expected_revision': 7, 'request_sha256': 'ab' * 32}
            self.send_json(200, {'operations': [*self.server.operations, foreign]})
            return
        if parsed.path.startswith('/v3/console/diagnose/'):
            identifier = unquote(parsed.path.removeprefix('/v3/console/diagnose/'))
            self.send_json(200, {'company_id': 'alpha', 'items': [{'source': 'audit', 'identifier': identifier}]})
            return
        self.send_json(404, {'error': 'missing'})


class DispatcherGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-cli-gateway-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.home = self.root / 'home'
        self.bin = self.home / '.local' / 'bin'
        self.bin.mkdir(parents=True)
        self.session = self.root / 'state' / 'console-session.json'
        self.parameters = self.root / 'parameters.json'
        self.parameters.write_text(json.dumps(PARAMETERS), encoding='utf-8')
        self.log = self.root / 'calls.jsonl'
        self.install_shims()
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.httpd.observed = []
        self.httpd.operations = []
        self.httpd.reject_password = False
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.url = 'http://127.0.0.1:' + str(self.httpd.server_port)

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def install_shims(self):
        getent = "#!/usr/bin/env python3\nimport os\nprint('fixture:x:1:1::%s:/bin/sh' % os.environ['CAUCE_TEST_CLI_HOME'])\n"
        recorder = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CAUCE_TEST_LOG'], 'a', encoding='utf-8') as stream:
    stream.write(json.dumps({'command': os.path.basename(sys.argv[0]), 'argv': sys.argv[1:],
        'home': os.environ.get('HOME'), 'runtime': os.environ.get('XDG_RUNTIME_DIR')}) + '\\n')
raise SystemExit(int(os.environ.get('CAUCE_TEST_EXIT', '0')))
"""
        for name, body in (('getent', getent), ('tmux', recorder), ('ssh', recorder),
                           ('docker', recorder), ('systemctl', recorder)):
            path = self.bin / name
            path.write_text(body, encoding='utf-8')
            path.chmod(0o700)

    def environment(self, **extra):
        environment = os.environ.copy()
        for name in CLEARED:
            environment.pop(name, None)
        environment.update({
            'HOME': str(self.home),
            'XDG_STATE_HOME': str(self.home / '.local' / 'state'),
            'PATH': str(self.bin) + os.pathsep + environment.get('PATH', ''),
            'PYTHONDONTWRITEBYTECODE': '1',
            'CAUCE_TEST_CLI_HOME': str(self.home),
            'CAUCE_TEST_LOG': str(self.log),
        })
        environment.update(extra)
        return environment

    def cli(self, *arguments, password=None, **extra):
        return subprocess.run(
            ['bash', str(CLI), *arguments], input=password, text=True, capture_output=True,
            timeout=30, env=self.environment(**extra), cwd=self.root,
        )

    def assert_silent(self, result):
        text = result.stdout + result.stderr
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn(COOKIE, text)
        self.assertNotIn(CSRF, text)
        self.assertNotIn(DENIAL, text)
        return text

    def login(self, **extra):
        result = self.cli(
            'login', '--gateway', self.url, '--email', 'owner@example.test',
            '--password-stdin', '--session-file', str(self.session), password=PASSWORD + '\n', **extra,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_silent(result)
        self.assertEqual(json.loads(result.stdout)['state'], 'authenticated')
        info = self.session.stat()
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.geteuid())
        self.assertEqual(stat.S_IMODE(self.session.parent.stat().st_mode), 0o700)
        document = json.loads(self.session.read_text(encoding='utf-8'))
        self.assertEqual(document['cookie'], COOKIE)
        self.assertEqual(document['csrf_token'], CSRF)
        self.assertEqual(document['gateway'], self.url)
        self.assertNotIn(PASSWORD, self.session.read_text(encoding='utf-8'))
        return document

    def spaces(self, command, *extra):
        arguments = ['spaces', command, '--json', '--session-file', str(self.session), '--tenant', 'Alpha']
        if command != 'list':
            arguments += ['--alias', 'canary', '--expected-revision', '7']
        if command in ('create', 'edit'):
            arguments += ['--input', str(self.parameters)]
        return self.cli(*arguments, *extra)

    def paths(self):
        return [(row['method'], row['path']) for row in self.httpd.observed]

    def test_login_status_and_rejected_password_stay_on_the_dispatcher(self):
        self.login()
        posted = self.httpd.observed[0]
        self.assertEqual((posted['method'], posted['path'], posted['body']['email']),
                         ('POST', '/v3/auth/login', 'owner@example.test'))
        self.assertEqual(posted['body']['password'], PASSWORD)
        self.assertIsNone(posted['cookie'])
        self.assertEqual(posted['origin'], self.url)
        self.httpd.observed.clear()
        status = self.cli('login', '--status', '--session-file', str(self.session))
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(json.loads(status.stdout)['state'], 'authenticated')
        self.assert_silent(status)
        self.assertEqual(self.paths(), [('GET', '/v3/auth/session')])
        self.assertEqual(self.httpd.observed[0]['cookie'], COOKIE)
        self.assertIsNone(self.httpd.observed[0]['csrf'])
        before = len(self.httpd.observed)
        rejected = self.cli('login', '--gateway', self.url, '--email', 'owner@example.test', '--password=' + PASSWORD,
                            '--session-file', str(self.session))
        self.assertEqual(rejected.returncode, 2)
        self.assert_silent(rejected)
        missing = self.cli('login', '--gateway', self.url, '--email', 'owner@example.test',
                           '--session-file', str(self.root / 'unused.json'), password=PASSWORD + '\n')
        self.assertEqual(missing.returncode, 1)
        self.assert_silent(missing)
        self.httpd.reject_password = True
        denied = self.cli('login', '--gateway', self.url, '--email', 'owner@example.test', '--password-stdin',
                          '--session-file', str(self.root / 'denied.json'), password='wrong-synthetic-password\n')
        self.assertEqual(denied.returncode, 1)
        self.assertIn('HTTP 401', denied.stderr)
        self.assert_silent(denied)
        self.assertFalse((self.root / 'denied.json').exists())
        self.assertEqual(len(self.httpd.observed), before + 1)

    def test_spaces_create_list_edit_and_retire_use_one_nominal_session(self):
        self.login()
        self.httpd.observed.clear()
        created = self.spaces('create', '--idempotency-key', 'create-canary')
        self.assertEqual(created.returncode, 0, created.stderr)
        preview = json.loads(created.stdout)
        self.assertEqual(preview['state'], 'preview')
        self.assertEqual(preview['preview']['kind'], 'create')
        self.assertEqual(preview['preview']['parameters'], PARAMETERS)
        self.assertEqual(self.paths(), [
            ('GET', '/v3/console/config'),
            ('GET', '/v3/console/fleet/capability'),
            ('POST', '/v3/console/fleet/operations/preview'),
        ])
        post = self.httpd.observed[-1]
        self.assertEqual((post['cookie'], post['csrf'], post['origin']), (COOKIE, CSRF, self.url))
        self.assert_silent(created)
        self.httpd.observed.clear()
        listed = self.spaces('list', '--alias', 'canary')
        self.assertEqual(listed.returncode, 0, listed.stderr)
        scoped = json.loads(listed.stdout)
        self.assertEqual([row['alias'] for row in scoped['agents']], ['canary'])
        self.assertNotIn('unpublished_detail', scoped['agents'][0])
        self.assertEqual(scoped['operations'], [])
        self.assertEqual(self.httpd.observed[1]['query'], 'resource=agent&tenant_id=Alpha&alias=canary')
        self.httpd.observed.clear()
        broad = self.spaces('list')
        self.assertEqual(broad.returncode, 0, broad.stderr)
        observed = json.loads(broad.stdout)
        self.assertEqual([row['alias'] for row in observed['agents']], ['canary'])
        self.assertEqual([row['alias'] for row in observed['retired_agents']], ['retired'])
        self.assertEqual(observed['operations'], [])
        self.assertEqual(self.paths(), [('GET', '/v3/console/config'), ('GET', '/v3/console/fleet/operations/recent')])
        self.httpd.observed.clear()
        edited = self.spaces('edit', '--idempotency-key', 'edit-canary')
        retired = self.spaces('retire', '--idempotency-key', 'retire-canary')
        self.assertEqual(json.loads(edited.stdout)['preview']['kind'], 'update')
        self.assertEqual(json.loads(edited.stdout)['preview']['parameters'], PARAMETERS)
        self.assertEqual(json.loads(retired.stdout)['preview']['kind'], 'retire')
        self.assertEqual(json.loads(retired.stdout)['preview']['parameters'], {})
        self.assert_silent(edited)
        self.assert_silent(retired)
        self.httpd.observed.clear()
        blocked = self.spaces('create')
        self.assertEqual(blocked.returncode, 1)
        self.assertEqual(self.httpd.observed, [])
        self.session.chmod(0o644)
        leaked = self.spaces('list')
        self.assertEqual(leaked.returncode, 1)
        self.assert_silent(leaked)
        self.assertEqual(self.httpd.observed, [])

    def test_apply_enqueues_once_and_replays_the_same_request(self):
        self.login()
        self.httpd.observed.clear()
        first = self.spaces('create', '--idempotency-key', 'create-canary', '--apply')
        self.assertEqual(first.returncode, 0, first.stderr)
        receipt = json.loads(first.stdout)
        self.assertEqual(receipt['state'], 'queued')
        self.assertIn('aún no está acreditado', receipt['message'])
        posts = [row['body'] for row in self.httpd.observed if row['method'] == 'POST']
        self.assertEqual(posts[0], posts[1])
        self.assertEqual([row['path'] for row in self.httpd.observed if row['method'] == 'POST'],
                         ['/v3/console/fleet/operations/preview', '/v3/console/fleet/operations'])
        original = posts[1]
        self.httpd.observed.clear()
        replay = self.spaces('create', '--idempotency-key', 'create-canary', '--apply')
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(json.loads(replay.stdout)['operation']['id'], receipt['operation']['id'])
        self.assertEqual([row['body'] for row in self.httpd.observed if row['method'] == 'POST'], [original])
        self.assertEqual(len(self.httpd.operations), 1)
        self.httpd.observed.clear()
        listed = self.spaces('list')
        visible = json.loads(listed.stdout)
        self.assertEqual([row['id'] for row in visible['operations']], [receipt['operation']['id']])
        self.assertTrue(all(row['target']['tenant_id'] == 'Alpha' for row in visible['operations']))

    def test_diagnose_requires_the_installed_helper_and_reuses_the_session(self):
        missing = self.cli('diagnose', 'trace-fixture', '--gateway', self.url, '--origin', self.url,
                           '--session-file', str(self.session))
        self.assertEqual(missing.returncode, 3)
        self.assertIn('falta cauce-diagnose', missing.stderr)
        self.assertEqual(self.httpd.observed, [])
        (self.bin / 'cauce-diagnose').symlink_to(OPS / 'cli' / 'cauce-diagnose')
        self.login()
        self.httpd.observed.clear()
        diagnosed = self.cli('diagnose', 'trace/a b', '--gateway', self.url, '--origin', self.url,
                             '--session-file', str(self.session))
        self.assertEqual(diagnosed.returncode, 0, diagnosed.stderr)
        self.assertEqual(diagnosed.stderr, '')
        self.assertEqual(json.loads(diagnosed.stdout)['items'][0]['identifier'], 'trace/a b')
        self.assertEqual(self.httpd.observed[0]['path'], '/v3/console/diagnose/trace%2Fa%20b')
        self.assertEqual(self.httpd.observed[0]['cookie'], COOKIE)
        self.assertIsNone(self.httpd.observed[0]['csrf'])
        self.assert_silent(diagnosed)
        self.httpd.observed.clear()
        for identifier in ('..', 'trace\nfixture'):
            rejected = self.cli('diagnose', identifier, '--gateway', self.url, '--origin', self.url,
                                '--session-file', str(self.session))
            self.assertEqual(rejected.returncode, 1)
            self.assert_silent(rejected)
        self.session.chmod(0o644)
        private = self.cli('diagnose', 'trace-fixture', '--gateway', self.url, '--origin', self.url,
                           '--session-file', str(self.session))
        self.assertEqual(private.returncode, 1)
        self.assert_silent(private)
        self.assertEqual(self.httpd.observed, [])

    def publish_inventory(self):
        scripts = str(OPS / 'scripts')
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        from fleet_runtime_materialization import materialize
        from test_fleet_runtime_materialization import dynamic_source
        user = pwd.getpwuid(os.geteuid()).pw_name
        source = dynamic_source()
        source['agents'][0].update(
            runtime_mode='native', host_id='local', container_name='host:local', runtime_user=user,
            state_directory='/var/lib/cauce-v3/aliases/physical-one', systemd_user=user,
            home_directory='/workspace/fixture-runtime', harness_id='codex',
        )
        state = self.root / 'inventory'
        receipt = materialize(source, {}, state)
        (state / 'applied-fleet.json').write_text(json.dumps(receipt), encoding='utf-8')
        share = self.home / '.local' / 'share' / 'cauce-v3'
        share.mkdir(parents=True, exist_ok=True)
        (share / 'ops').symlink_to(OPS)
        (self.bin / 'cauce-panel').symlink_to(OPS / 'cli' / 'cauce-panel')
        (self.bin / 'cauce-sesiones').symlink_to(OPS / 'guardias' / 'cauce-sesiones')
        return str(state)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines()]

    def test_dynamic_fleet_keeps_console_commands_and_attaches_by_alias(self):
        state = self.publish_inventory()
        fleet = {'CAUCE_FLEET_RUNTIME_STATE': state}
        self.login(**fleet)
        self.assertEqual(self.httpd.observed[0]['path'], '/v3/auth/login')
        (self.bin / 'cauce-diagnose').symlink_to(OPS / 'cli' / 'cauce-diagnose')
        self.httpd.observed.clear()
        listed = self.cli('spaces', 'list', '--session-file', str(self.session), '--tenant', 'Alpha', **fleet)
        diagnosed = self.cli('diagnose', 'trace-fixture', '--gateway', self.url, '--origin', self.url,
                             '--session-file', str(self.session), **fleet)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual(diagnosed.returncode, 0, diagnosed.stderr)
        self.assertEqual(json.loads(diagnosed.stdout)['items'][0]['identifier'], 'trace-fixture')
        nominal = self.cli('shared_alias', '--session-file', str(self.session), **fleet)
        self.assertEqual(nominal.returncode, 1, nominal.stderr)
        self.assertIn(('GET', '/v3/console/terminal/targets'), self.paths())
        self.assertEqual(self.calls(), [])
        self.session.unlink()
        before = len(self.httpd.observed)
        attached = self.cli('shared_alias', **fleet)
        self.assertEqual(attached.returncode, 0, attached.stderr)
        self.assertIn('Abriendo la terminal existente de physical-one', attached.stderr)
        self.assertEqual(len(self.httpd.observed), before)
        call, = self.calls()
        self.assertEqual(call['command'], 'tmux')
        self.assertEqual(call['argv'], ['-L', 'cauce', 'attach-session', '-t', 'cauce-physical-one:agente'])
        self.assertEqual(call['home'], '/workspace/fixture-runtime')
        self.assertEqual(call['runtime'], '/run/user/' + str(os.geteuid()))
        self.log.unlink()
        for verb in ('on', 'off', 'retirar'):
            refused = self.cli('shared_alias', verb, **fleet)
            self.assertEqual(refused.returncode, 2, refused.stderr)
            self.assertIn('consola', refused.stderr)
        unknown = self.cli('missing-alias', **fleet)
        self.assertEqual(unknown.returncode, 2, unknown.stderr)
        self.assertIn('no figura en el inventario aplicado', unknown.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(len(self.httpd.observed), before)


if __name__ == '__main__':
    unittest.main()
