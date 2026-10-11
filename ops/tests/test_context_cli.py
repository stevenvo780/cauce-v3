import hashlib
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from context_client import ContextClient, ContextFailure, export_context, private_cookie, read_scoped, valid_path
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
        self.session.write_text(json.dumps({'cookie': 'cauce_session=synthetic-test', 'csrf_token': 'a' * 43}))
        self.session.chmod(0o600)
        Handler.snapshot = {'company_id': 'alpha', 'tenant_id': 'Alpha', 'alias': 'director', 'version': 0, 'digest': None, 'files': []}
        Handler.observed = []
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
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

    def test_mutations_without_session_csrf_are_rejected_before_network_access(self):
        self.session.write_text(json.dumps({'cookie': 'cauce_session=synthetic-test'}))
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


if __name__ == '__main__':
    unittest.main()
