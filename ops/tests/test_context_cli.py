import hashlib
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from context_client import (
    ContextClient,
    ContextFailure,
    export_context,
    private_cookie,
    read_scoped,
    request_json,
    valid_path,
)
from context_native import sync


class Handler(BaseHTTPRequestHandler):
    snapshot = {}
    observed = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.observed.append((self.path, self.headers.get('Origin'), self.headers.get('Cookie')))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(self.snapshot).encode())

    def do_PUT(self):
        self.observed.append(('PUT', self.headers.get('X-CSRF-Token')))
        if self.headers.get('X-CSRF-Token') != 'a' * 43:
            self.send_response(403)
            self.end_headers()
            return
        document = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if document['expected_version'] != self.snapshot['version']:
            self.send_response(409)
            self.end_headers()
            return
        self.snapshot.update(version=self.snapshot['version'] + 1, files=document['files'])
        self.snapshot['digest'] = hashlib.sha256(json.dumps(document['files'], separators=(',', ':')).encode()).hexdigest()
        self.send_response(202)
        self.end_headers()
        self.wfile.write(json.dumps(self.snapshot).encode())


class ContextCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.session = self.root / 'console-cookie.json'
        Handler.snapshot = {'company_id': 'alpha', 'tenant_id': 'Alpha', 'alias': 'director', 'version': 0, 'digest': None, 'files': []}
        Handler.observed = []
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
        self.session.write_text(json.dumps({'cookie': 'cauce_session=synthetic-test', 'csrf_token': 'a' * 43,
                                            'gateway': self.url, 'origin': self.url}))
        self.session.chmod(0o600)
        self.client = ContextClient(self.url, self.url, str(self.session))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def test_real_http_read_and_native_cas_preserve_scope(self):
        (self.root / 'context').mkdir()
        (self.root / 'context' / 'mission.md').write_text('Use scoped context.')
        result = sync(self.client, 'Alpha', 'director', str(self.root), ['context/mission.md'], [], 0)
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['files'], [{'path': 'context/mission.md', 'content': 'Use scoped context.'}])
        self.assertEqual(Handler.observed[0], ('/v3/console/context/agents/Alpha/director', self.url, 'cauce_session=synthetic-test'))
        self.assertEqual(Handler.observed[-1], ('PUT', 'a' * 43))
        with self.assertRaisesRegex(ContextFailure, 'version changed'):
            sync(self.client, 'Alpha', 'director', str(self.root), ['context/mission.md'], [], 0)

    def test_refuses_symlink_files_and_directories(self):
        (self.root / 'context').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            read_scoped(self.root, 'context/console-cookie.json')
        (self.root / 'linked.md').symlink_to(self.session)
        with self.assertRaises(OSError):
            read_scoped(self.root, 'linked.md')

    def test_refuses_sensitive_and_unscoped_paths(self):
        for path in ('../auth.json', 'context/auth.json', 'projects/code.md', '/context/guide.md'):
            with self.assertRaises(ContextFailure):
                valid_path(path)

    def test_private_session_and_tls_are_required(self):
        self.session.chmod(0o644)
        with self.assertRaises(ContextFailure):
            private_cookie(str(self.session))
        with self.assertRaises(ContextFailure):
            ContextClient('http://external.example', 'https://console.example', str(self.session))

    def test_incomplete_session_requires_login_before_network_access(self):
        original = json.loads(self.session.read_text())
        for field in ('gateway', 'origin'):
            with self.subTest(field=field):
                self.session.write_text(json.dumps({key: value for key, value in original.items() if key != field}))
                with self.assertRaisesRegex(ContextFailure, 'vuelve a iniciar sesión con cauce login'):
                    ContextClient(self.url, self.url, str(self.session))
        self.assertEqual(Handler.observed, [])

    def test_https_proxy_from_environment_receives_a_connect_request(self):
        class Proxy(Handler):
            def do_CONNECT(self):
                Handler.observed.append((self.command, self.path, self.headers.get('Cookie')))
                self.send_response(502)
                self.end_headers()

        self.server.RequestHandlerClass = Proxy
        gateway = 'https://console.example.invalid'
        with patch.dict(os.environ, {'HTTPS_PROXY': self.url}, clear=True):
            with self.assertRaisesRegex(ContextFailure, 'console gateway is unavailable'):
                request_json(gateway, gateway, None, 'GET', '/v3/auth/session',
                             headers={'Cookie': 'cauce_session=synthetic-test'}, timeout=2)
        self.assertEqual(Handler.observed, [('CONNECT', 'console.example.invalid:443', None)])

    def test_redirects_from_an_environment_proxy_are_not_followed(self):
        class Proxy(Handler):
            def do_GET(self):
                Handler.observed.append((self.path, self.headers.get('Cookie')))
                self.send_response(302)
                self.send_header('Location', self.url + '/redirect-target')
                self.end_headers()

        Proxy.url = self.url
        self.server.RequestHandlerClass = Proxy
        gateway = 'http://127.0.0.1:9'
        with patch.dict(os.environ, {'HTTP_PROXY': self.url}, clear=True):
            with self.assertRaisesRegex(ContextFailure, 'HTTP 302; redirects are disabled'):
                request_json(gateway, gateway, None, 'GET', '/v3/auth/session',
                             headers={'Cookie': 'cauce_session=synthetic-test'}, timeout=2)
        self.assertEqual(Handler.observed, [(gateway + '/v3/auth/session', 'cauce_session=synthetic-test')])

    def test_mutations_without_session_csrf_are_rejected_before_network_access(self):
        self.session.write_text(json.dumps({'cookie': 'cauce_session=synthetic-test', 'gateway': self.url, 'origin': self.url}))
        client = ContextClient(self.url, self.url, str(self.session))
        self.assertEqual(client.request('GET', 'Alpha', 'director')['version'], 0)
        before = len(Handler.observed)
        for method in ('PUT', 'POST'):
            with self.assertRaisesRegex(ContextFailure, 'csrf_token'):
                client.request(method, 'Alpha', 'director', body={})
        self.assertEqual(len(Handler.observed), before)

    def test_export_only_writes_scoped_context_and_private_metadata(self):
        snapshot = {**Handler.snapshot, 'version': 2, 'digest': 'a' * 64,
                    'files': [{'path': 'directives/mission.md', 'content': 'Private context.'}]}
        destination = self.root / 'export'
        result = export_context(snapshot, str(destination))
        self.assertEqual(result['state'], 'exported')
        self.assertEqual((destination / 'directives' / 'mission.md').read_text(), 'Private context.')
        self.assertEqual(os.stat(destination / 'context-manifest.json').st_mode & 0o777, 0o600)
        self.assertEqual(sorted(path.name for path in destination.iterdir()), ['context-manifest.json', 'directives'])

    def test_redirects_are_not_followed_and_a_foreign_origin_is_rejected_before_network(self):
        class Redirect(Handler):
            def do_GET(self):
                Handler.observed.append((self.path, 'redirect'))
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1:9/stolen')
                self.end_headers()

        self.server.RequestHandlerClass = Redirect
        before = len(Handler.observed)
        with self.assertRaisesRegex(ContextFailure, 'HTTP 302'):
            self.client.request('GET', 'Alpha', 'director')
        self.assertEqual(len(Handler.observed), before + 1)
        foreign = self.root / 'foreign-session.json'
        foreign.write_text(json.dumps({'cookie': 'cauce_session=synthetic-test', 'csrf_token': 'a' * 43,
                                       'gateway': 'http://127.0.0.1:9', 'origin': 'http://127.0.0.1:9'}))
        foreign.chmod(0o600)
        seen = len(Handler.observed)
        with self.assertRaisesRegex(ContextFailure, 'bound to a different gateway'):
            ContextClient(self.url, self.url, str(foreign))
        self.assertEqual(len(Handler.observed), seen)


if __name__ == '__main__':
    unittest.main()
