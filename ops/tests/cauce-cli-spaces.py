import contextlib
import copy
import hashlib
import io
import json
import os
import pathlib
import runpy
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = runpy.run_path(str(ROOT / 'ops/cli/cauce-spaces'), run_name='cauce_spaces_tests')
PARAMETERS = {'runtime_key': 'cli-canary', 'harness_id': 'codex', 'primary_room_id': 'office',
              'memberships': [{'room_id': 'office', 'role': 'agent', 'enabled': True}],
              'placement': {'host_id': 'canary', 'mode': 'container', 'container_name': 'cli-canary',
                            'runtime_user': 'dev', 'home_directory': '/home/dev',
                            'state_directory': '/spaces/cli-canary'},
              'primary_account_id': 'synthetic-account', 'display_name': 'Canario de prueba'}


class Handler(BaseHTTPRequestHandler):
    revision = 7
    operations = []
    observed = []
    can_apply = True
    wrong_hash = False
    available = True
    status = 'queued'
    applied_revision = 10
    wrong_envelope = False
    missing_agent = False
    replay_conflict = False

    def log_message(self, *_):
        pass

    def respond(self, value, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())

    def do_GET(self):
        self.observed.append(('GET', self.path, None, dict(self.headers)))
        if self.path == '/v3/console/config':
            self.respond({'revision': self.revision, 'tenants': [{'id': 'Alpha'}, {'id': 'Beta'}],
                          'agents': [] if self.missing_agent else [{'tenant_id': 'Alpha', 'alias': 'canary', 'display_name': 'Canario',
                                      'enabled': False, 'lifecycle_state': 'draft', 'unpublished_detail': 'omit'},
                                     {'tenant_id': 'Beta', 'alias': 'other', 'enabled': True}],
                          'retired': {'agents': [{'tenant_id': 'Alpha', 'alias': 'retired', 'enabled': False}]}})
        elif self.path == '/v3/console/fleet/capability':
            self.respond({'available': self.available, 'actions': ['create', 'update', 'retire'], 'placements': []})
        else:
            self.respond({'operations': self.operations})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.observed.append(('POST', self.path, body, dict(self.headers)))
        if self.headers.get('X-CSRF-Token') != 'a' * 43:
            self.respond({'error': 'csrf_rejected'}, 403)
            return
        if self.path == '/v3/console/config/changes':
            mutation = body['mutation']
            encoded = 'cauce-v3:configuration-mutation:v1\n' + MODULE['canonical'](mutation)
            self.respond({'dry_run': body['dry_run'], 'applied': not body['dry_run'],
                          'revision': self.revision if body['dry_run'] else self.applied_revision,
                          'rolled_back_revision_id': None, 'mutation': mutation, 'inverse_mutation': {},
                          'mutation_sha256': hashlib.sha256(encoded.encode()).hexdigest()})
            return
        receipt = {'kind': body['kind'], 'target': body['target'], 'expected_revision': body['expected_revision'],
                   'request_sha256': '0' * 64 if self.wrong_hash else MODULE['request_hash'](body)}
        if self.path.endswith('/preview'):
            self.respond({**receipt, 'can_apply': self.can_apply, 'steps': ['prepare'], 'dependencies': []})
        else:
            prior = next((row for row in self.operations if row['request_sha256'] == receipt['request_sha256']), None)
            if prior is not None and self.replay_conflict:
                self.respond({'error': 'conflict'}, 409)
                return
            if prior is not None:
                self.respond({'operation_id': prior['id'], 'status': prior['status'], 'operation': prior}, 202)
                return
            receipt.update(id='3509d5e9-5d78-40f8-80f9-88dd46705ca0', version=0, status=self.status,
                           desired_revision=None, applied_revision=None, steps=[{'name': 'prepare', 'status': 'pending'}])
            self.operations.append(receipt)
            self.respond({'operation_id': 'wrong-id' if self.wrong_envelope else receipt['id'],
                          'status': receipt['status'], 'operation': receipt}, 202)


class SpacesCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.input = self.root / 'parameters.json'
        self.input.write_text(json.dumps(PARAMETERS))
        Handler.revision, Handler.applied_revision = 7, 10
        Handler.operations, Handler.observed = [], []
        Handler.can_apply, Handler.wrong_hash, Handler.available, Handler.status = True, False, True, 'queued'
        Handler.wrong_envelope, Handler.missing_agent = False, False
        Handler.replay_conflict = False
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
        self.session = self.root / 'console-session.json'
        self.session.write_text(json.dumps({'version': 1, 'gateway': self.url, 'origin': self.url,
                                           'cookie': 'cauce_session=synthetic-test', 'csrf_token': 'a' * 43}))
        self.session.chmod(0o600)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def run_cli(self, command, *options):
        flags = [command, '--session-file', str(self.session), '--tenant', 'Alpha', '--alias', 'canary']
        if command != 'list':
            flags.extend(['--expected-revision', '7'])
        if command in ('create', 'edit'):
            flags.extend(['--input', str(self.input)])
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = MODULE['main']([*flags, *options])
        return code, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()

    def posts(self):
        return [entry for entry in Handler.observed if entry[0] == 'POST']

    def test_create_defaults_to_preview_and_sends_cookie_csrf_scope(self):
        code, result, _ = self.run_cli('create', '--idempotency-key', 'create-canary')
        self.assertEqual((code, result['state']), (0, 'preview'))
        self.assertEqual(len(self.posts()), 1)
        method, path, body, headers = self.posts()[0]
        self.assertEqual((method, path), ('POST', '/v3/console/fleet/operations/preview'))
        self.assertEqual(body['target'], {'resource': 'agent', 'tenant_id': 'Alpha', 'alias': 'canary'})
        self.assertEqual(body['parameters'], PARAMETERS)
        headers = {key.lower(): value for key, value in headers.items()}
        self.assertEqual(headers['x-csrf-token'], 'a' * 43)
        self.assertEqual((headers['cookie'], headers['origin']), ('cauce_session=synthetic-test', self.url))

    def test_apply_uses_exact_preview_request_and_keeps_queued_state(self):
        code, result, _ = self.run_cli('create', '--idempotency-key', 'create-canary', '--apply')
        self.assertEqual((code, result['state'], result['operation']['desired_revision']), (0, 'queued', None))
        self.assertIn('aún no está acreditado', result['message'])
        self.assertEqual(self.posts()[0][2], self.posts()[1][2])
        self.assertEqual(self.posts()[1][1], '/v3/console/fleet/operations')

    def test_retry_after_revision_change_uses_exact_nominal_gateway_replay(self):
        _, first, _ = self.run_cli('create', '--idempotency-key', 'create-canary', '--apply')
        original_request = self.posts()[-1][2]
        Handler.revision = 42
        Handler.observed = []
        code, retry, _ = self.run_cli('create', '--idempotency-key', 'create-canary', '--apply')
        self.assertEqual((code, retry['operation']['id']), (0, first['operation']['id']))
        self.assertEqual(len(Handler.observed), 2)
        self.assertEqual(self.posts()[0][2], original_request)
        self.assertEqual(len(Handler.operations), 1)

    def test_history_hash_from_another_operator_requires_gateway_authorization(self):
        self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
        session = json.loads(self.session.read_text())
        session['cookie'] = 'cauce_session=synthetic-other-operator'
        self.session.write_text(json.dumps(session))
        Handler.replay_conflict, Handler.observed = True, []
        code, result, error = self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
        self.assertEqual((code, result, len(Handler.operations)), (1, None, 1))
        self.assertEqual(len(self.posts()), 1)
        self.assertIn('HTTP 409', error)
        self.assertNotIn('synthetic-other-operator', error)

    def test_blocked_preview_and_mismatched_receipt_do_not_enqueue(self):
        for wrong_hash, can_apply in ((False, False), (True, True)):
            Handler.wrong_hash, Handler.can_apply, Handler.observed = wrong_hash, can_apply, []
            code, result, _ = self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
            self.assertEqual((code, result, len(self.posts())), (1, None, 1))

    def test_invalid_acceptance_envelope_reports_unverified_effect_and_recovers_by_key(self):
        Handler.wrong_envelope = True
        code, result, error = self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
        self.assertEqual((code, result, len(Handler.operations)), (1, None, 1))
        self.assertIn('consulta spaces list', error)
        Handler.observed, Handler.wrong_envelope = [], False
        code, result, _ = self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
        self.assertEqual((code, result['state'], len(self.posts()), len(Handler.operations)), (0, 'queued', 1, 1))

    def test_stale_revision_or_unavailable_executor_does_not_mutate(self):
        for revision, available in ((8, True), (7, False)):
            Handler.revision, Handler.available, Handler.observed = revision, available, []
            code, result, _ = self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
            self.assertEqual((code, result, self.posts()), (1, None, []))

    def test_edit_uses_update_and_retire_never_sends_runtime_parameters(self):
        for command, kind in (('edit', 'update'), ('retire', 'retire')):
            Handler.observed = []
            code, result, _ = self.run_cli(command, '--idempotency-key', kind + '-canary')
            self.assertEqual((code, result['preview']['kind']), (0, kind))
            self.assertEqual(self.posts()[0][2]['parameters'], {} if command == 'retire' else PARAMETERS)

    def test_registry_apply_is_cas_previewed_disabled_and_accepts_revision_gaps(self):
        self.input.write_text(json.dumps({'display_name': ' Canario ', 'max_concurrent_deliveries': 2}))
        code, result, _ = self.run_cli('create', '--registry-only', '--apply')
        self.assertEqual((code, result['state'], result['receipt']['revision']), (0, 'registry_applied', 10))
        self.assertEqual([post[2]['dry_run'] for post in self.posts()], [True, False])
        self.assertEqual(self.posts()[0][2]['mutation'], self.posts()[1][2]['mutation'])
        self.assertEqual(self.posts()[1][2]['expected_revision'], 7)
        self.assertEqual(self.posts()[1][2]['mutation']['value']['enabled'], False)
        self.assertEqual(self.posts()[1][2]['mutation']['value']['display_name'], 'Canario')

    def test_registry_edit_blocks_enabling_and_runtime_relocation_before_write(self):
        for value in ({'enabled': True}, {'host_id': 'different-host'}, {'credential_ref': 'forbidden'}):
            self.input.write_text(json.dumps(value))
            Handler.observed = []
            code, result, _ = self.run_cli('edit', '--registry-only', '--apply')
            self.assertEqual((code, result, self.posts()), (1, None, []))

    def test_runtime_input_blocks_secret_fields_and_symlinks(self):
        document = copy.deepcopy(PARAMETERS)
        document['placement']['password'] = 'synthetic-not-a-secret'
        self.input.write_text(json.dumps(document))
        code, result, error = self.run_cli('create', '--idempotency-key', 'create-canary', '--apply')
        self.assertEqual((code, result, Handler.observed), (1, None, []))
        self.assertNotIn('synthetic-not-a-secret', error)
        self.input.unlink()
        self.input.symlink_to(self.session)
        code, _, _ = self.run_cli('create', '--idempotency-key', 'create-canary', '--apply')
        self.assertEqual((code, Handler.observed), (1, []))

    def test_list_keeps_scope_and_reports_pending_without_invented_runtime(self):
        Handler.missing_agent = True
        self.run_cli('create', '--idempotency-key', 'create-canary', '--apply')
        code, result, _ = self.run_cli('list')
        self.assertEqual((code, result['state'], result['operations'][0]['status']), (0, 'observed', 'queued'))
        self.assertEqual(result['agents'], [])

    def test_list_projects_authorized_agent_state_without_private_details(self):
        code, result, _ = self.run_cli('list')
        self.assertEqual((code, [row['alias'] for row in result['agents']]), (0, ['canary']))
        self.assertNotIn('unpublished_detail', result['agents'][0])
        self.assertEqual(result['agents'][0]['lifecycle_state'], 'draft')

    def test_failed_receipt_is_visible_and_returns_failure(self):
        Handler.status = 'failed'
        code, result, _ = self.run_cli('retire', '--idempotency-key', 'retire-canary', '--apply')
        self.assertEqual((code, result['state']), (1, 'failed'))

    def test_session_default_is_shared_with_login_and_auth_failures_are_sanitized(self):
        with patch.dict(os.environ, {'CAUCE_CONSOLE_SESSION_FILE': str(self.session)}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(MODULE['main'](['list', '--tenant', 'Alpha']), 0)
        self.session.chmod(0o644)
        Handler.observed = []
        code, _, error = self.run_cli('list')
        self.assertEqual((code, Handler.observed), (1, []))
        self.assertNotIn('synthetic-test', error)

    def test_invalid_arguments_do_not_echo_unknown_values(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as failure:
            MODULE['main'](['list', '--tenant', 'Alpha', '--unsupported-option', 'synthetic-private-value'])
        self.assertEqual(failure.exception.code, 2)
        self.assertNotIn('synthetic-private-value', err.getvalue())
        self.assertEqual(Handler.observed, [])


if __name__ == '__main__':
    unittest.main()
