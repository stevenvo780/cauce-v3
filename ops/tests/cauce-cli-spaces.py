import contextlib
import copy
import datetime
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
                                      'enabled': False, 'lifecycle_state': 'draft', 'unpublished_detail': 'omit',
                                      'harness_id': 'codex', 'host_id': 'labhost', 'runtime_mode': 'container',
                                      'placement': {'address': '100.99.88.77', 'public_key': 'ssh-ed25519 synthetic-key',
                                                    'fingerprint': 'SHA256:synthetic-fingerprint',
                                                    'state_directory': '/spaces/cli-canary'}},
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

    def run_cli(self, command, *options, json_output=True, alias='canary'):
        flags = [command, '--session-file', str(self.session), '--tenant', 'Alpha', '--alias', alias]
        if json_output:
            flags.append('--json')
        if command != 'list':
            flags.extend(['--expected-revision', '7'])
        if command in ('create', 'edit'):
            flags.extend(['--input', str(self.input)])
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = MODULE['main']([*flags, *options])
        output = out.getvalue()
        return code, json.loads(output) if output and json_output else output or None, err.getvalue()

    def posts(self):
        return [entry for entry in Handler.observed if entry[0] == 'POST']

    def test_missing_session_requires_login_before_listing_or_mutating(self):
        self.session.unlink()
        for command in ('list', 'create', 'edit', 'retire'):
            with self.subTest(command=command):
                code, result, error = self.run_cli(command, '--apply') if command != 'list' else self.run_cli(command)
                self.assertEqual((code, result), (1, None))
                self.assertIn('No hay una sesión de consola guardada', error)
                self.assertIn('cauce login --gateway', error)
        self.assertEqual(Handler.observed, [])

    def test_create_rejects_reserved_cli_aliases_without_contacting_the_gateway(self):
        for alias in ('spaces', 'hosts', 'platform', 'login'):
            with self.subTest(alias=alias):
                for options in ((), ('--registry-only',)):
                    code, result, error = self.run_cli('create', '--idempotency-key', 'create-reserved', *options, alias=alias)
                    self.assertEqual((code, result), (1, None))
                    self.assertIn('reservado para un subcomando', error)
        self.assertEqual(Handler.observed, [])

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

    def test_default_list_is_a_spanish_table_with_latest_operation_and_no_private_details(self):
        selected = {'resource': 'agent', 'tenant_id': 'Alpha', 'alias': 'canary'}
        now = datetime.datetime.now(datetime.UTC)
        Handler.operations = [
            {'target': selected, 'kind': 'create', 'status': 'succeeded',
             'created_at': (now - datetime.timedelta(days=2)).isoformat()},
            {'target': selected, 'kind': 'update', 'status': 'awaiting_auth',
             'created_at': (now - datetime.timedelta(hours=3)).isoformat(),
             'updated_at': (now - datetime.timedelta(hours=2)).isoformat(),
             'steps': [{'evidence': {'key': 'ssh-ed25519 synthetic-key', 'ip': '100.99.88.77'}}]},
        ]
        code, output, error = self.run_cli('list', json_output=False)
        self.assertEqual((code, error), (0, ''))
        for value in ('Alias', 'Nombre visible', 'Arnés', 'Ordenador', 'Modo', 'Ciclo de vida', 'Habilitado',
                      'Última operación', 'canary', 'Canario', 'codex', 'labhost', 'Contenedor', 'Borrador',
                      'Editar / Espera de login / hace 2 h', 'No'):
            self.assertIn(value, output)
        for value in ('100.99.88.77', 'ssh-ed25519', 'SHA256:', '/spaces/', 'synthetic-key', 'steps'):
            self.assertNotIn(value, output)
        self.assertNotIn('Crear / Completada', output)

    def test_json_list_keeps_exact_previous_bytes_and_complete_operation_details(self):
        Handler.operations = [{'target': {'resource': 'agent', 'tenant_id': 'Alpha', 'alias': 'canary'},
                               'kind': 'update', 'status': 'running', 'steps': [{'evidence': {'ip': '100.99.88.77'}}]}]
        out = io.StringIO()
        args = MODULE['parser']().parse_args(['list', '--tenant', 'Alpha', '--alias', 'canary'])
        login = runpy.run_path(str(ROOT / 'ops/cli/cauce-login'), run_name='spaces_json_session')
        client = login['ConsoleSessionClient'](self.session)
        expected = MODULE['list_spaces'](client, args)
        with contextlib.redirect_stdout(out):
            code = MODULE['main'](['list', '--tenant', 'Alpha', '--alias', 'canary', '--json',
                                   '--session-file', str(self.session)])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), json.dumps(expected, ensure_ascii=False, separators=(',', ':')) + '\n')
        for value in ('ssh-ed25519 synthetic-key', 'SHA256:synthetic-fingerprint', '100.99.88.77', '/spaces/cli-canary'):
            self.assertIn(value, out.getvalue())

    def test_json_changes_keep_exact_previous_preview_bytes(self):
        login = runpy.run_path(str(ROOT / 'ops/cli/cauce-login'), run_name='spaces_json_session')
        client = login['ConsoleSessionClient'](self.session)
        for command in ('create', 'edit', 'retire'):
            flags = [command, '--session-file', str(self.session), '--tenant', 'Alpha', '--alias', 'canary',
                     '--expected-revision', '7', '--idempotency-key', 'json-preview-canary', '--json']
            if command != 'retire':
                flags.extend(['--input', str(self.input)])
            args = MODULE['parser']().parse_args(flags)
            expected = MODULE['fleet_change'](client, args)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = MODULE['main'](flags)
            self.assertEqual(code, 0)
            self.assertEqual(out.getvalue(), json.dumps(expected, ensure_ascii=False, separators=(',', ':')) + '\n')

    def test_previews_describe_changes_without_raw_parameters_or_dependencies(self):
        for command, label in (('create', 'Crear'), ('edit', 'Editar'), ('retire', 'Retirar')):
            with self.subTest(command=command):
                code, output, error = self.run_cli(command, '--idempotency-key', 'preview-canary', json_output=False)
                self.assertEqual((code, error), (0, ''))
                self.assertIn('Previsualización: ' + label, output)
                self.assertIn('No se aplicó ningún cambio.', output)
                self.assertIn('Puede aplicarse: Sí', output)
                if command != 'retire':
                    self.assertIn('Nombre visible: Canario → Canario de prueba', output)
                    self.assertIn('Ordenador: labhost → canary', output)
                    self.assertIn('Membresías solicitadas: 1', output)
                for value in ('/home/dev', '/spaces/', 'synthetic-account', 'request_sha256', 'runtime_key'):
                    self.assertNotIn(value, output)

    def test_registry_preview_and_apply_use_safe_human_output(self):
        self.input.write_text(json.dumps({'display_name': 'Nuevo canario', 'state_directory': '/private/internal'}))
        code, output, error = self.run_cli('create', '--registry-only', json_output=False)
        self.assertEqual((code, error), (0, ''))
        self.assertIn('Nombre visible: Canario → Nuevo canario', output)
        self.assertIn('Alcance: solo registro.', output)
        self.assertNotIn('/private/internal', output)
        for command, options in (('create', ('--registry-only',)), ('retire', ('--idempotency-key', 'retire-canary'))):
            code, output, error = self.run_cli(command, *options, '--apply', json_output=False)
            self.assertEqual((code, error), (0, ''))
            self.assertIn('Resultado:', output)
            for value in ('/private/internal', 'request_sha256', 'mutation_sha256', 'synthetic-account'):
                self.assertNotIn(value, output)

    def test_declarative_edit_shows_omitted_optional_resets_without_changing_request(self):
        desired = copy.deepcopy(PARAMETERS)
        desired.pop('display_name')
        desired.pop('primary_account_id')
        original = copy.deepcopy(desired)
        args = MODULE['parser']().parse_args(['edit', '--tenant', 'Alpha', '--alias', 'canary',
            '--expected-revision', '7', '--input', str(self.input)])
        args.preview_request = {'parameters': desired}
        args.preview_current = {'display_name': 'Canario anterior', 'model_id': 'previous-model',
            'reasoning_effort': 'high', 'primary_account_id': 'synthetic-private-account',
            'systemd_user': 'private-user', 'container_name': 'private-container', 'host_id': 'canary'}
        result = {'state': 'preview', 'preview': {'can_apply': True, 'dependencies': []}}
        output = MODULE['human_change'](result, args)
        for expected in ('Nombre visible: Canario anterior → sin asignar', 'Modelo: previous-model → sin asignar',
                         'Esfuerzo: high → sin asignar', 'Cuenta de proveedor: se elimina la asignación',
                         'Usuario del servicio: vuelve al valor predeterminado'):
            self.assertIn(expected, output)
        self.assertEqual(desired, original)
        for value in ('synthetic-private-account', 'private-user', 'private-container'):
            self.assertNotIn(value, output)
        desired['placement'].pop('container_name')
        output = MODULE['human_change'](result, args)
        self.assertIn('Contenedor: vuelve al valor predeterminado', output)

    def test_registry_edit_does_not_reset_omitted_fields(self):
        args = MODULE['parser']().parse_args(['edit', '--tenant', 'Alpha', '--alias', 'canary',
            '--expected-revision', '7', '--input', str(self.input), '--registry-only'])
        args.preview_current = {'display_name': 'Anterior', 'model_id': 'previous-model',
            'reasoning_effort': 'high', 'primary_account_id': 'synthetic-account', 'systemd_user': 'private-user'}
        result = {'state': 'preview', 'registry_only': True, 'receipt': {'mutation': {'value': {'display_name': 'Nuevo'}}}}
        output = MODULE['human_change'](result, args)
        self.assertIn('Nombre visible: Anterior → Nuevo', output)
        for field in ('Modelo:', 'Esfuerzo:', 'Cuenta de proveedor:', 'Usuario del servicio:'):
            self.assertNotIn(field, output)

    def test_preview_lists_replacement_memberships_even_when_count_is_unchanged(self):
        args = MODULE['parser']().parse_args(['edit', '--tenant', 'Alpha', '--alias', 'canary',
            '--expected-revision', '7', '--input', str(self.input)])
        args.preview_current = {'memberships': [{'room_id': 'old-a', 'role': 'agent'}, {'room_id': 'old-b', 'role': 'agent'}]}
        desired = copy.deepcopy(PARAMETERS)
        desired['memberships'] = [{'room_id': 'new-a', 'role': 'reader', 'enabled': False},
                                  {'room_id': 'new-b', 'role': 'writer'}]
        args.preview_request = {'parameters': desired}
        args.preview_rooms = [{'id': 'new-a', 'tenant_id': 'Alpha', 'display_name': 'Sala nueva'},
                              {'id': 'new-b', 'tenant_id': 'Alpha', 'display_name': '/internal/private-room'}]
        output = MODULE['human_change']({'state': 'preview', 'preview': {'can_apply': True, 'dependencies': []}}, args)
        self.assertIn('Membresías solicitadas: 2', output)
        self.assertIn('Se reemplazan las membresías por:', output)
        self.assertIn('Sala: Sala nueva · Rol: reader · Habilitada: No', output)
        self.assertIn('Sala: [oculto] · Rol: writer · Habilitada: Sí', output)
        for value in ('/internal/private-room', 'old-a', 'old-b'):
            self.assertNotIn(value, output)

    def test_human_cells_hide_sensitive_values_and_terminal_control_characters(self):
        for value in ('100.99.88.77', 'fd7a:115c:a1e0::1', '/private/path', r'C:\private\path',
                      'ssh-ed25519 synthetic-key', 'SHA256:synthetic-fingerprint', 'f' * 64,
                      'Alice\x1b[2J', 'Alice\nInjected', 'Alice\u202eInjected'):
            self.assertEqual(MODULE['cell'](value), '[oculto]')
        self.assertEqual(MODULE['cell']('Canario español'), 'Canario español')

    def test_human_inventory_keeps_retired_and_operation_only_rows_and_empty_state(self):
        data = {'tenant_id': 'Alpha', 'revision': 7, 'agents': [], 'retired_agents': [], 'operations': []}
        self.assertIn('No hay agentes', MODULE['human_inventory'](data))
        data['retired_agents'] = [{'alias': 'retired', 'enabled': False, 'runtime_mode': 'native'}]
        data['operations'] = [{'target': {'resource': 'agent', 'tenant_id': 'Alpha', 'alias': 'new'},
                               'kind': 'create', 'status': 'queued'}]
        output = MODULE['human_inventory'](data)
        for value in ('retired', 'Retirado', 'Nativo', 'Sin registro visible', 'Crear / Pendiente / sin fecha'):
            self.assertIn(value, output)

    def test_relative_age_has_safe_fallbacks(self):
        now = datetime.datetime.now(datetime.UTC)
        for seconds, expected in ((-60, 'hace menos de 1 min'), (30, 'hace menos de 1 min'),
                                  (120, 'hace 2 min'), (7200, 'hace 2 h'), (172800, 'hace 2 d')):
            self.assertEqual(MODULE['age']({'updated_at': (now - datetime.timedelta(seconds=seconds)).isoformat()}, now), expected)
        for value in (None, 'invalid', '2026-01-01'):
            self.assertEqual(MODULE['age']({'updated_at': value}, now), 'sin fecha')

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
