import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'cli' / 'cauce-login'
loader = importlib.machinery.SourceFileLoader('cauce_console_login', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
login_cli = importlib.util.module_from_spec(spec)
loader.exec_module(login_cli)
PASSWORD = 'synthetic-cli-password'
CSRF = 'c' * 43


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, body, headers=()):
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        self.server.observed.append((self.command, self.path, self.headers.get('Cookie'), self.headers.get('X-CSRF-Token')))
        if self.path != '/v3/auth/login':
            return self.respond(200 if self.headers.get('X-CSRF-Token') == CSRF else 403, {'ok': True})
        if self.server.redirect:
            return self.respond(307, {}, [('Location', self.server.redirect)])
        if body.get('password') != PASSWORD:
            return self.respond(401, {'message': 'Private denial content must not appear in output.'})
        self.server.counter += 1
        if self.server.before_response:
            self.server.before_response()
        result = {'authenticated': True, 'login_mode': 'password', 'subject': body['email'], 'csrf_token': CSRF,
                  'authority': {'home_company': 'synthetic', 'acting_company': 'synthetic', 'csrf_token': CSRF}}
        if self.server.missing_csrf:
            del result['csrf_token']
        self.respond(200, result, [('Set-Cookie', '__Host-cauce_session=synthetic-' + str(self.server.counter) + '; HttpOnly; Secure; Path=/')])

    def do_GET(self):
        self.server.observed.append((self.command, self.path, self.headers.get('Cookie'), self.headers.get('X-CSRF-Token')))
        if self.server.redirect:
            return self.respond(302, {}, [('Location', self.server.redirect)])
        self.respond(200, {'authenticated': not self.server.expired, 'login_mode': 'password', 'csrf_token': CSRF})


class ConsoleLoginTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.session = self.root / 'state' / 'console-session.json'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.observed = []
        self.server.counter = 0
        self.server.redirect = None
        self.server.expired = False
        self.server.missing_csrf = False
        self.server.before_response = None
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def authenticate(self, session=None):
        return login_cli.login(self.url, self.url, 'owner@example.test', PASSWORD, str(session or self.session))

    def command(self, *arguments, password=None):
        environment = os.environ.copy()
        for name in ('CAUCE_GATEWAY_URL', 'CAUCE_CONSOLE_SESSION_FILE'):
            environment.pop(name, None)
        return subprocess.run(['python3', '-B', str(SCRIPT), '--session-file', str(self.session), *arguments],
            input=password, text=True, capture_output=True, timeout=10, env=environment)

    def test_login_saves_private_owned_session_compatible_with_context_client(self):
        self.authenticate()
        info = self.session.stat()
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.geteuid())
        self.assertEqual(stat.S_IMODE(self.session.parent.stat().st_mode), 0o700)
        document = login_cli.private_session(str(self.session))
        self.assertEqual(document['gateway'], self.url)
        self.assertEqual(document['origin'], self.url)
        self.assertEqual(document['csrf_token'], CSRF)
        self.assertNotIn(PASSWORD, self.session.read_text())
        from context_client import ContextClient
        context = ContextClient(self.url, self.url, str(self.session))
        self.assertEqual(context.cookie, document['cookie'])
        client = login_cli.ConsoleSessionClient(str(self.session))
        self.assertTrue(client.request('GET', '/v3/auth/session')['authenticated'])
        self.assertTrue(client.request('POST', '/v3/console/spaces', {})['ok'])
        self.assertEqual(self.server.observed[-1][3], CSRF)

    def test_cli_login_status_and_renew_never_expose_authentication_material(self):
        result = self.command('--gateway', self.url, '--email', 'owner@example.test', '--password-stdin', password=PASSWORD + '\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['state'], 'authenticated')
        self.assertNotIn('csrf_token', result.stdout)
        self.assertNotIn('__Host-cauce_session', result.stdout)
        self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        original = self.session.read_bytes()
        inode = self.session.stat().st_ino
        status = self.command('--status')
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(json.loads(status.stdout)['state'], 'authenticated')
        self.assertEqual(self.session.read_bytes(), original)
        renewed = self.command('--renew', '--password-stdin', password=PASSWORD + '\n')
        self.assertEqual(renewed.returncode, 0, renewed.stderr)
        self.assertEqual(json.loads(renewed.stdout)['state'], 'renewed')
        self.assertNotEqual(self.session.read_bytes(), original)
        self.assertNotEqual(self.session.stat().st_ino, inode)
        self.assertEqual(stat.S_IMODE(self.session.stat().st_mode), 0o600)
        self.assertEqual(list(self.session.parent.glob('*.tmp')), [])

    def test_failed_renewal_preserves_session_without_printing_denial_body(self):
        self.authenticate()
        original = self.session.read_bytes()
        result = self.command('--renew', '--password-stdin', password='incorrect-synthetic-password\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('HTTP 401', result.stderr)
        self.assertIn('cauce login', result.stderr)
        self.assertNotIn('Private denial', result.stderr)
        self.assertEqual(self.session.read_bytes(), original)

    def test_status_reports_expired_without_printing_csrf(self):
        self.authenticate()
        self.server.expired = True
        result = self.command('--status')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['state'], 'expired')
        self.assertNotIn(CSRF, result.stdout + result.stderr)

    def test_destination_and_origin_overrides_do_not_receive_saved_cookie(self):
        self.authenticate()
        before = len(self.server.observed)
        for arguments in ({'gateway': 'https://other.example'}, {'origin': 'https://other.example'}):
            with self.assertRaisesRegex(login_cli.ContextFailure, 'bound'):
                login_cli.ConsoleSessionClient(str(self.session), **arguments)
        self.assertEqual(len(self.server.observed), before)
        result = self.command('--renew', '--gateway', 'https://other.example', '--password-stdin', password=PASSWORD + '\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ejecuta cauce login sin --renew', result.stderr)
        self.assertEqual(len(self.server.observed), before)

    def test_incomplete_saved_session_requires_a_new_login_for_status_and_renewal(self):
        self.authenticate()
        original = json.loads(self.session.read_text())
        before = len(self.server.observed)
        for field in ('gateway', 'origin'):
            self.session.write_text(json.dumps({key: value for key, value in original.items() if key != field}))
            for mode in ('--status', '--renew'):
                with self.subTest(field=field, mode=mode):
                    result = self.command(mode, '--gateway', self.url, '--origin', self.url)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn('vuelve a iniciar sesión con cauce login', result.stderr)
                    self.assertNotIn('cauce_session=', result.stdout + result.stderr)
        self.assertEqual(len(self.server.observed), before)

    def test_login_respects_https_proxy(self):
        class Proxy(Handler):
            def do_CONNECT(self):
                self.server.observed.append((self.command, self.path, self.headers.get('Cookie')))
                self.send_response(502)
                self.end_headers()

        self.server.RequestHandlerClass = Proxy
        with patch.dict(os.environ, {'HTTPS_PROXY': self.url}, clear=True):
            with self.assertRaisesRegex(login_cli.ContextFailure, 'console gateway is unavailable'):
                login_cli.login('https://console.example.invalid', None, 'owner@example.test', PASSWORD, str(self.session))
        self.assertEqual(self.server.observed, [('CONNECT', 'console.example.invalid:443', None)])
        self.assertFalse(self.session.exists())

    def test_login_status_and_renew_bypass_loopback_proxies(self):
        class Proxy(Handler):
            def do_GET(self):
                self.server.observed.append(self.path)
                self.send_response(502)
                self.end_headers()

            do_POST = do_GET

        proxy = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        proxy.observed = []
        thread = threading.Thread(target=proxy.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        proxy_url = 'http://127.0.0.1:' + str(proxy.server_port)
        try:
            with patch.dict(os.environ, {'HTTP_PROXY': proxy_url, 'HTTPS_PROXY': proxy_url}, clear=True):
                login = self.command('--gateway', self.url, '--email', 'owner@example.test',
                                     '--password-stdin', password=PASSWORD + '\n')
                self.assertEqual(login.returncode, 0, login.stderr)
                self.assertEqual(self.command('--status').returncode, 0)
                renewed = self.command('--renew', '--password-stdin', password=PASSWORD + '\n')
                self.assertEqual(renewed.returncode, 0, renewed.stderr)
                self.assertTrue(login_cli.ConsoleSessionClient(str(self.session)).request('POST', '/v3/console/spaces', {})['ok'])
            self.assertEqual(proxy.observed, [])
            self.assertEqual([row[1] for row in self.server.observed],
                             ['/v3/auth/login', '/v3/auth/session', '/v3/auth/login', '/v3/console/spaces'])
        finally:
            proxy.shutdown()
            proxy.server_close()
            thread.join()

    def test_refuses_public_session_and_foreign_owner(self):
        self.authenticate()
        self.session.chmod(0o644)
        with self.assertRaises(login_cli.ContextFailure):
            login_cli.ConsoleSessionClient(str(self.session))
        with self.assertRaisesRegex(login_cli.ContextFailure, 'usa --session-file'):
            self.authenticate()
        self.session.chmod(0o600)
        with patch.object(login_cli.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(login_cli.ContextFailure):
                login_cli.ConsoleSessionClient(str(self.session))

    def test_refuses_final_and_parent_symlinks_before_sending_password(self):
        victim = self.root / 'victim'
        victim.write_text('untouched')
        victim.chmod(0o600)
        self.session.parent.mkdir()
        self.session.symlink_to(victim)
        with self.assertRaises(login_cli.ContextFailure):
            self.authenticate()
        self.assertEqual(victim.read_text(), 'untouched')
        self.assertEqual(self.server.observed, [])
        linked = self.root / 'linked'
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.authenticate(linked / 'session.json')
        self.assertEqual(self.server.observed, [])

    def test_symlink_race_does_not_replace_target_or_leave_private_temp_file(self):
        victim = self.root / 'victim'
        victim.write_text('untouched')
        victim.chmod(0o600)
        self.server.before_response = lambda: self.session.symlink_to(victim)
        with self.assertRaises(login_cli.ContextFailure):
            self.authenticate()
        self.assertEqual(victim.read_text(), 'untouched')
        self.assertEqual(list(self.session.parent.glob('*.tmp')), [])

    def test_does_not_follow_password_or_cookie_redirects(self):
        self.server.redirect = self.url + '/redirect-target'
        with self.assertRaisesRegex(login_cli.ContextFailure, 'HTTP 307'):
            self.authenticate()
        self.assertEqual([row[1] for row in self.server.observed], ['/v3/auth/login'])
        self.assertFalse(self.session.exists())
        self.server.redirect = None
        self.authenticate()
        self.server.observed = []
        self.server.redirect = self.url + '/redirect-target'
        with self.assertRaisesRegex(login_cli.ContextFailure, 'HTTP 302'):
            login_cli.ConsoleSessionClient(str(self.session)).request('GET', '/v3/auth/session')
        self.assertEqual([row[1] for row in self.server.observed], ['/v3/auth/session'])

    def test_requires_csrf_and_rejects_foreign_paths_before_network(self):
        self.authenticate()
        document = json.loads(self.session.read_text())
        del document['csrf_token']
        self.session.write_text(json.dumps(document))
        client = login_cli.ConsoleSessionClient(str(self.session))
        before = len(self.server.observed)
        with self.assertRaisesRegex(login_cli.ContextFailure, 'csrf_token'):
            client.request('POST', '/v3/console/spaces', {})
        for path in ('https://other.example/path', '//other.example/path', '/\\other', '/v3/auth/session#fragment'):
            with self.assertRaises(login_cli.ContextFailure):
                client.request('GET', path)
        self.assertEqual(len(self.server.observed), before)

    def test_login_without_csrf_keeps_the_previous_private_session(self):
        self.authenticate()
        original = self.session.read_bytes()
        self.server.missing_csrf = True
        with self.assertRaisesRegex(login_cli.ContextFailure, 'vuelve a ejecutar cauce login'):
            self.authenticate()
        self.assertEqual(self.session.read_bytes(), original)

    def test_refuses_plaintext_remote_and_credential_or_path_origins(self):
        for value in ('http://external.example', 'https://user:secret@example.test', 'https://example.test/path',
                      'https://example.test?query', 'https://example.test#fragment', 'https://', 'https://example.test\n'):
            with self.assertRaises(login_cli.ContextFailure):
                login_cli.trusted_origin(value)
        self.assertEqual(login_cli.trusted_origin('https://EXAMPLE.TEST:443/'), 'https://example.test')
        self.assertEqual(login_cli.trusted_origin('http://[::1]:80'), 'http://[::1]')

    def test_password_argument_is_rejected_without_echoing_its_value(self):
        result = self.command('--gateway', self.url, '--email', 'owner@example.test', '--password=' + PASSWORD)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        self.assertEqual(self.server.observed, [])

    def test_noninteractive_password_requires_explicit_stdin_flag(self):
        result = self.command('--gateway', self.url, '--email', 'owner@example.test', password=PASSWORD + '\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Inicia cauce login en una terminal privada o usa --password-stdin', result.stderr)
        self.assertIn('la contraseña no se pasa como argumento', result.stderr)
        self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        self.assertEqual(self.server.observed, [])

    def test_missing_gateway_explains_how_to_select_it_before_network(self):
        result = self.command('--email', 'owner@example.test', '--password-stdin', password=PASSWORD + '\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Falta el gateway; usa cauce login --gateway <URL> o configura CAUCE_GATEWAY_URL.', result.stderr)
        self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        self.assertFalse(self.session.exists())
        self.assertEqual(self.server.observed, [])

    def test_status_and_renew_require_login_when_saved_session_is_missing(self):
        for mode in ('--status', '--renew'):
            with self.subTest(mode=mode):
                result = self.command(mode, '--gateway', self.url)
                self.assertEqual(result.returncode, 1)
                self.assertIn('No hay una sesión de consola guardada', result.stderr)
                self.assertIn('cauce login --gateway', result.stderr)
                self.assertFalse(self.session.exists())
        self.assertEqual(self.server.observed, [])

    def test_status_rejects_login_inputs_with_next_step_before_network(self):
        for arguments in (('--email', 'owner@example.test'), ('--password-stdin',)):
            with self.subTest(arguments=arguments):
                result = self.command('--status', *arguments, password=PASSWORD + '\n')
                self.assertEqual(result.returncode, 1)
                self.assertIn('--status usa solo la sesión guardada; quita --email y --password-stdin', result.stderr)
                self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        self.assertEqual(self.server.observed, [])

    def test_login_validation_gives_spanish_next_steps_before_network(self):
        cases = ((None, PASSWORD, self.session, 'usa --email <CORREO>'),
                 ('owner@example.test', '', self.session, 'usa --password-stdin'),
                 ('owner@example.test', PASSWORD, self.root / '..' / 'session.json', 'elige otra ruta con --session-file'))
        for email, password, session, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(login_cli.ContextFailure, expected):
                    login_cli.login(self.url, self.url, email, password, str(session))
        self.assertFalse(self.session.exists())
        self.assertEqual(self.server.observed, [])

    def test_rejected_login_response_gives_next_step_without_saving_session(self):
        with patch.object(login_cli, 'request_json', return_value=({'authenticated': False}, [])):
            with self.assertRaisesRegex(login_cli.ContextFailure, 'revisa el acceso en la consola y vuelve a ejecutar cauce login'):
                self.authenticate()
        self.assertFalse(self.session.exists())

    def test_invalid_cookie_gives_next_step_without_saving_session(self):
        with patch.object(login_cli.SimpleCookie, 'load', side_effect=login_cli.CookieError):
            with self.assertRaisesRegex(login_cli.ContextFailure, 'cookie de sesión inválida; vuelve a ejecutar cauce login'):
                self.authenticate()
        self.assertFalse(self.session.exists())

    def test_invalid_session_response_gives_login_next_step(self):
        self.authenticate()
        stderr = io.StringIO()
        with patch.object(login_cli.sys, 'argv', [str(SCRIPT), '--status', '--session-file', str(self.session)]), \
                patch.object(login_cli.ConsoleSessionClient, 'request', return_value=[]), patch('sys.stderr', stderr):
            self.assertEqual(login_cli.main(), 1)
        self.assertIn('La respuesta de la sesión es inválida; vuelve a ejecutar cauce login', stderr.getvalue())

    def test_default_session_location_respects_state_and_explicit_environment(self):
        with patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root)}, clear=True):
            self.assertEqual(login_cli.default_session_file(), str(self.root / 'cauce-v3' / 'console-session.json'))
        with patch.dict(os.environ, {'CAUCE_CONSOLE_SESSION_FILE': str(self.session)}, clear=True):
            self.assertEqual(login_cli.default_session_file(), str(self.session))


if __name__ == '__main__':
    unittest.main()
