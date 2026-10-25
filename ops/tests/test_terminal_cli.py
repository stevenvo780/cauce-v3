from __future__ import annotations

import io
import json
import os
import pathlib
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops/cli'))
import context_client  # noqa: E402

SESSION_ID = '11111111-2222-4333-8444-555555555555'
COOKIE = 'cauce_session=synthetic-terminal-test'
TICKET = 'synthetic-terminal-ticket'
PROOF = 'ac2.synthetic-terminal-proof'


def target(**changes):
    return {
        'tenant_id': 'Alpha', 'alias': 'zz-canary-terminal', 'authorized': True,
        'pty_state': 'online', 'modes': ['shell', 'harness', 'harness_rw'],
        'writable_modes': ['shell', 'harness_rw'], **changes,
    }


def grant(**changes):
    return {
        'session_id': SESSION_ID, 'ticket': TICKET, 'authority_proof': PROOF,
        'websocket_path': '/v3/ws/terminal', 'owner_generation': '1',
        'request_id': 'synthetic-request', 'owner_token': 'synthetic-owner',
        'target': {'tenant_id': 'Alpha', 'alias': 'zz-canary-terminal', 'mode': 'harness_rw'},
        **changes,
    }


class TerminalTargetTests(unittest.TestCase):
    def resolve(self, *items, alias='zz-canary-terminal', tenant=None, mode=None):
        return context_client.terminal_target({'items': list(items)}, alias, tenant, mode)

    def test_tenant_qualification_resolves_ambiguous_alias(self):
        first, second = target(), target(tenant_id='Beta')
        with self.assertRaisesRegex(context_client.ContextFailure, 'ambiguo'):
            self.resolve(first, second)
        self.assertEqual(self.resolve(first, second, tenant='Beta'), (second, 'harness_rw'))
        self.assertEqual(self.resolve(first, second, alias='Alpha/zz-canary-terminal'), (first, 'harness_rw'))
        with self.assertRaisesRegex(context_client.ContextFailure, 'no coincide'):
            self.resolve(first, alias='Alpha/zz-canary-terminal', tenant='Beta')

    def test_ambiguous_alias_suggests_only_visible_tenants(self):
        with self.assertRaises(context_client.ContextFailure) as rejected:
            self.resolve(target(tenant_id='Steven'), target(tenant_id='Miguel'))
        self.assertIn('usa --tenant Miguel o usa --tenant Steven', str(rejected.exception))
        self.assertNotIn('inexistente', str(rejected.exception))

    def test_unique_authorized_target_is_inferred_without_tenant(self):
        selected = target(tenant_id='Steven')
        self.assertEqual(self.resolve(target(tenant_id='Miguel', authorized=False), selected), (selected, 'harness_rw'))
        with self.assertRaisesRegex(context_client.ContextFailure, 'permisos'):
            self.resolve(target(tenant_id='Miguel', authorized=False), selected, tenant='Miguel')

    def test_authorized_requires_boolean_true_and_online_pty(self):
        for value in (False, 1, 'true', None):
            with self.subTest(authorized=value), self.assertRaises(context_client.ContextFailure):
                self.resolve(target(authorized=value))
        with self.assertRaises(context_client.ContextFailure):
            self.resolve(target(pty_state='offline'))

    def test_denied_and_disconnected_terminals_offer_distinct_actions(self):
        with self.assertRaisesRegex(context_client.ContextFailure, 'revisa tus permisos'):
            self.resolve(target(authorized=False, pty_state='offline'))
        with self.assertRaisesRegex(context_client.ContextFailure, 'no está conectada.*autenticación del proveedor'):
            self.resolve(target(pty_state='offline'))

    def test_writable_modes_are_required_for_shell_and_tui_input(self):
        for mode in ('shell', 'harness_rw'):
            with self.subTest(mode=mode), self.assertRaises(context_client.ContextFailure):
                self.resolve(target(writable_modes=[]), mode=mode)
        readonly = target(modes=['harness'], writable_modes=[])
        self.assertEqual(self.resolve(readonly), (readonly, 'harness'))

    def test_missing_capabilities_and_invalid_targets_fail_closed(self):
        for item in (target(modes=None), target(writable_modes=None), target(tenant_id='../Beta')):
            with self.subTest(item=item), self.assertRaises(context_client.ContextFailure):
                self.resolve(item)
        for alias in ('../zz-canary-terminal', 'Alpha/Beta/zz-canary-terminal', ''):
            with self.subTest(alias=alias), self.assertRaises(context_client.ContextFailure):
                self.resolve(target(), alias=alias)
        for snapshot in (None, {}, {'items': {}}, {'items': []}):
            with self.subTest(snapshot=snapshot), self.assertRaises(context_client.ContextFailure):
                context_client.terminal_target(snapshot, 'zz-canary-terminal', None, None)

    def test_selected_mode_must_be_advertised(self):
        with self.assertRaises(context_client.ContextFailure):
            self.resolve(target(modes=['harness']), mode='shell')
        with self.assertRaises(context_client.ContextFailure):
            self.resolve(target(modes=['arbitrary'], writable_modes=['arbitrary']), mode='arbitrary')

    def test_websocket_stays_on_gateway_without_authentication_in_url(self):
        for gateway, expected in (('https://console.example', 'wss://console.example'),
                                  ('http://127.0.0.1:1234', 'ws://127.0.0.1:1234')):
            path = '/v3/ws/terminal'
            self.assertEqual(context_client.terminal_websocket(gateway, path), expected + path)
        for path in ('wss://foreign.example/v3/ws/terminal', '//foreign.example/v3/ws/terminal',
                     '/v3/ws/terminal?ticket=' + TICKET, '/v3/ws/terminal#' + PROOF,
                     '/v3/ws/terminal/../other', '/v3/console/config', None):
            with self.subTest(path=path), self.assertRaises(context_client.ContextFailure) as rejected:
                context_client.terminal_websocket('https://console.example', path)
            self.assertNotIn(TICKET, str(rejected.exception))
            self.assertNotIn(PROOF, str(rejected.exception))


class TerminalMainTests(unittest.TestCase):
    def client_for(self, terminals=None, tenant='Alpha', configuration=None, activity=None, operations=None,
                   sessions=None, failures=None):
        identity = {'tenant_id': tenant, 'alias': 'zz-canary-terminal'}
        snapshots = {
            '/v3/console/terminal/targets': {'items': [target(tenant_id=tenant)] if terminals is None else terminals},
            '/v3/console/config': configuration if configuration is not None else {'agents': [
                {**identity, 'host_id': 'zz-canary-host', 'runtime_mode': 'container', 'lifecycle_state': 'ready'}]},
            '/v3/console/activity': activity if activity is not None else {'agents': [
                {**identity, 'presence': {'online': True, 'lease_until': '2026-01-01T00:00:00Z'}}]},
            '/v3/console/fleet/operations?resource=agent&tenant_id=' + tenant + '&alias=zz-canary-terminal':
                {'operations': [] if operations is None else operations},
            '/v3/console/terminal/sessions': {'items': [] if sessions is None else sessions},
        }

        def request(method, path, body=None):
            self.assertEqual(method, 'GET', 'Read-only actions must not mutate terminal or runtime state')
            if path in (failures or {}):
                raise context_client.ContextFailure(
                    f'console request rejected with HTTP {failures[path]}; redirects are disabled')
            return snapshots[path]

        return SimpleNamespace(request=Mock(side_effect=request))

    def run_cli(self, client, *arguments):
        with patch.object(sys, 'argv', ['context_client', '--terminal', 'zz-canary-terminal', *arguments]), \
                patch.object(sys, 'stdout', io.StringIO()) as stdout, \
                patch.object(sys, 'stderr', io.StringIO()) as stderr, \
                patch.object(context_client, 'ConsoleSessionClient', return_value=client), \
                patch.object(context_client, 'terminal_transport') as transport:
            result = context_client.terminal_main()
        transport.assert_not_called()
        return result, stdout.getvalue(), stderr.getvalue()

    def test_status_works_offline_with_safe_fields_and_never_creates_a_terminal(self):
        for state, label in (('online', 'En línea'), ('agent_offline', 'Fuera de línea'),
                             ('unknown', 'Sin presencia confirmada'), ('not_installed', 'No instalado')):
            with self.subTest(state=state):
                private = {'container': '/private/terminal', 'runtime_user': 'private-user',
                           'image': 'sha256:private-image', 'last_seen': '100.64.0.7',
                           'reason': 'ssh-ed25519 private-key', 'harness': COOKIE,
                           'shares_container_with': [{'alias': 'private-cohort'}]}
                client = self.client_for(terminals=[target(pty_state=state, **private)])
                with patch.object(context_client.shutil, 'which', return_value=None):
                    code, output, error = self.run_cli(client, 'estado')
                self.assertEqual((code, error), (0, ''))
                self.assertIn('Destino: Alpha · zz-canary-terminal', output)
                self.assertIn('Terminal: ' + label, output)
                self.assertIn('Permiso de terminal: Autorizado', output)
                for value in private.values():
                    if isinstance(value, str):
                        self.assertNotIn(value, output)
                self.assertEqual(client.request.call_args_list, [unittest.mock.call('GET', path) for path in (
                    '/v3/console/terminal/targets', '/v3/console/config', '/v3/console/activity',
                    '/v3/console/fleet/operations?resource=agent&tenant_id=Alpha&alias=zz-canary-terminal')])

    def test_status_refuses_denied_targets_and_does_not_fallback_to_configuration(self):
        client = SimpleNamespace(request=Mock(return_value={'items': [target(authorized=False)]}))
        code, output, error = self.run_cli(client, 'estado')
        self.assertEqual((code, output), (1, ''))
        self.assertIn('revisa tus permisos', error)
        client.request.assert_called_once_with('GET', '/v3/console/terminal/targets')

    def test_visible_registry_without_terminal_is_diagnosed_without_authorizing_it(self):
        for action in ('ver', 'estado', ''):
            with self.subTest(action=action):
                registry = {'agents': [target(tenant_id='Steven', home_directory='/private/agent')]}
                client = self.client_for(terminals=[], tenant='Steven', configuration=registry)
                code, output, error = self.run_cli(client, *([action] if action else []))
                if action == 'estado':
                    self.assertEqual((code, error), (0, ''))
                    self.assertIn('Destino: Steven · zz-canary-terminal', output)
                    self.assertIn('Sin terminal publicada', output)
                    self.assertIn('Permiso de terminal: No acreditado', output)
                else:
                    self.assertEqual((code, output), (1, ''))
                    self.assertIn('existe en el registro visible, pero no publica una terminal', error)
                self.assertNotIn('/private/agent', output + error)
                expected = ['/v3/console/terminal/targets', '/v3/console/config']
                if action == 'estado':
                    expected.extend(('/v3/console/config', '/v3/console/activity',
                                     '/v3/console/fleet/operations?resource=agent&tenant_id=Steven&alias=zz-canary-terminal'))
                self.assertEqual(client.request.call_args_list, [unittest.mock.call('GET', path) for path in expected])

    def test_absent_alias_and_registry_ambiguity_have_distinct_diagnostics(self):
        for registry, expected in (({'agents': []}, 'no figura en el inventario visible'),
                                   ({'agents': [target(tenant_id='Steven'), target(tenant_id='Miguel')]},
                                    'usa --tenant Miguel o usa --tenant Steven')):
            with self.subTest(expected=expected):
                client = SimpleNamespace(request=Mock(side_effect=[{'items': []}, registry]))
                code, output, error = self.run_cli(client, 'ver')
                self.assertEqual((code, output), (1, ''))
                self.assertIn(expected, error)
                self.assertNotIn('no autorizado o ambiguo', error)

    def test_status_accepts_options_before_or_after_action(self):
        for arguments in (('estado', '--tenant', 'Steven'), ('--tenant', 'Steven', 'estado')):
            with self.subTest(arguments=arguments):
                client = self.client_for(tenant='Steven')
                code, output, error = self.run_cli(client, *arguments)
                self.assertEqual((code, error), (0, ''))
                self.assertIn('Destino: Steven', output)

    def test_status_scopes_lease_and_current_operations_to_selected_agent(self):
        identity = {'resource': 'agent', 'tenant_id': 'Alpha', 'alias': 'zz-canary-terminal'}
        operations = [{'target': identity, 'status': state, 'kind': kind, 'error': COOKIE}
                      for state, kind in (('queued', 'create'), ('running', 'update'),
                                          ('awaiting_auth', 'start'), ('cancelling', 'stop'))]
        operations.extend([
            {'target': {**identity, 'tenant_id': 'Beta'}, 'status': 'running', 'kind': 'purge'},
            {'target': {**identity, 'alias': 'zz-canary-foreign'}, 'status': 'running', 'kind': 'purge'},
            {'target': {**identity, 'resource': 'space'}, 'status': 'running', 'kind': 'purge'},
            {'target': identity, 'status': 'succeeded', 'kind': 'purge'},
        ])
        for online, lease in ((True, 'Vigente'), (False, 'Caducado'), (None, 'Sin lease observado')):
            with self.subTest(online=online):
                activity = {'agents': [
                    {'tenant_id': 'Beta', 'alias': identity['alias'], 'presence': {'online': not online}},
                    {**identity, 'presence': {'online': online, 'lease_until': '2026-01-01T00:00:00Z', 'secret': COOKIE}},
                ]}
                client = self.client_for(activity=activity, operations=operations)
                code, output, error = self.run_cli(client, 'estado')
                self.assertEqual((code, error), (0, ''))
                for label in ('Ordenador: zz-canary-host', 'Modo: Contenedor', 'Ciclo de vida: Listo',
                              'Lease: ' + lease, 'Terminal disponible: Sí',
                              'Vencimiento del lease: 2026-01-01 00:00:00 UTC', 'Crear · Pendiente',
                              'Editar · En ejecución', 'Iniciar · Espera de login', 'Detener · Cancelando'):
                    self.assertIn(label, output)
                self.assertNotIn('Purgar', output)
                self.assertNotIn(COOKIE, output)

    def test_sessions_show_only_safe_rows_for_the_selected_tenant_and_alias(self):
        sessions = [
            {'tenant_id': 'Alpha', 'alias': 'zz-canary-terminal', 'state': state, 'mode': mode,
             'opened_at': '2026-01-01T00:00:00Z', 'expires_at': '2026-01-01T01:00:00Z',
             'session_id': SESSION_ID, 'owner_token': COOKIE, 'ticket': TICKET, 'authority_proof': PROOF}
            for state, mode in (('issued', 'harness'), ('active', 'shell'), ('closed', 'harness_rw'))
        ]
        sessions.extend([
            {**sessions[0], 'tenant_id': 'Beta', 'state': 'foreign-state', 'mode': 'foreign-mode'},
            {**sessions[0], 'alias': 'zz-canary-foreign', 'state': 'foreign-state', 'mode': 'foreign-mode'},
        ])
        client = self.client_for(sessions=sessions)
        code, output, error = self.run_cli(client, 'sesiones')
        self.assertEqual((code, error), (0, ''))
        for row in ('1. TUI solo lectura · Emitida', '2. Consola de comandos · Activa',
                    '3. TUI con control · Cerrada', 'Abierta: 2026-01-01 00:00:00 UTC'):
            self.assertIn(row, output)
        for value in (SESSION_ID, COOKIE, TICKET, PROOF, 'foreign-state', 'foreign-mode', '4.'):
            self.assertNotIn(value, output)
        self.assertEqual(client.request.call_args, unittest.mock.call('GET', '/v3/console/terminal/sessions'))
        code, output, error = self.run_cli(self.client_for(), 'sesiones')
        self.assertEqual((code, error), (0, ''))
        self.assertIn('No hay sesiones terminales visibles para este agente.', output)

    def test_lifecycle_actions_resolve_visible_agent_and_require_console_without_mutation(self):
        for action in ('on', 'off'):
            for published in (True, False):
                with self.subTest(action=action, published=published):
                    client = self.client_for(terminals=None if published else [])
                    code, output, error = self.run_cli(client, action)
                    self.assertEqual((code, output), (1, ''))
                    self.assertIn('Usa la consola', error)
                    self.assertEqual([call.args[1] for call in client.request.call_args_list],
                                     ['/v3/console/terminal/targets'] + ([] if published else ['/v3/console/config']))

    def test_view_shows_agent_summary_then_opens_readonly_terminal(self):
        snapshots = self.client_for()

        def request(method, path, body=None):
            if method == 'GET':
                return snapshots.request(method, path)
            if method == 'POST':
                self.assertIn('Ordenador: zz-canary-host', stderr.getvalue())
                self.assertEqual(body['mode'], 'harness')
                return grant(request_id=body['request_id'], target={
                    'tenant_id': 'Alpha', 'alias': 'zz-canary-terminal', 'mode': 'harness'})
            return {'released': True}

        client = SimpleNamespace(gateway='https://console.example', request=Mock(side_effect=request))
        with patch.object(sys, 'argv', ['context_client', '--terminal', 'zz-canary-terminal', 'ver']), \
                patch.object(sys, 'stdout', io.StringIO()) as stdout, \
                patch.object(sys, 'stderr', io.StringIO()) as stderr, \
                patch.object(context_client, 'ConsoleSessionClient', return_value=client), \
                patch.object(context_client.shutil, 'which', return_value='/usr/bin/node'), \
                patch.object(context_client, 'terminal_transport', return_value=0) as transport:
            self.assertEqual(context_client.terminal_main(), 0)
        self.assertEqual(stdout.getvalue(), '')
        self.assertIn('Lease: Vigente', stderr.getvalue())
        self.assertEqual(transport.call_args.args[2], 'harness')
        self.assertEqual([call.args[0] for call in client.request.call_args_list],
                         ['GET', 'GET', 'GET', 'GET', 'POST', 'DELETE'])
        for value in (COOKIE, TICKET, PROOF, SESSION_ID):
            self.assertNotIn(value, stderr.getvalue())

    def test_status_tolerates_inaccessible_auxiliary_snapshots_but_requires_live_session(self):
        paths = ('/v3/console/config', '/v3/console/activity',
                 '/v3/console/fleet/operations?resource=agent&tenant_id=Alpha&alias=zz-canary-terminal')
        for status in (403, 404):
            with self.subTest(status=status):
                client = self.client_for(failures=dict.fromkeys(paths, status))
                code, output, error = self.run_cli(client, 'estado')
                self.assertEqual((code, error), (0, ''))
                self.assertIn('Ordenador: Sin ordenador confirmado', output)
                self.assertIn('Modo: Sin modo confirmado', output)
                self.assertIn('Lease: No disponible para esta sesión', output)
                self.assertIn('Operación en curso: No disponible para esta sesión', output)
        for path in paths:
            with self.subTest(unauthorized=path):
                code, output, error = self.run_cli(self.client_for(failures={path: 401}), 'estado')
                self.assertEqual((code, output), (1, ''))
                self.assertIn('cauce login', error)
                self.assertNotIn('redirects are disabled', error)

    def test_http_failures_offer_actions_without_forwarding_server_details(self):
        for code, action in ((401, 'cauce login'), (403, 'permisos'), (302, '--gateway'), (409, 'antes de reintentar')):
            with self.subTest(code=code), \
                    patch.object(sys, 'argv', ['context_client', '--terminal', 'zz-canary-terminal']), \
                    patch.object(sys, 'stderr', io.StringIO()) as stderr, \
                    patch.object(context_client, 'ConsoleSessionClient') as session, \
                    patch.object(context_client, 'terminal_transport') as transport:
                session.return_value.request.side_effect = context_client.ContextFailure(
                    f'console request rejected with HTTP {code}; redirects are disabled')
                self.assertEqual(context_client.terminal_main(), 1)
                self.assertIn(f'HTTP {code}', stderr.getvalue())
                self.assertIn(action, stderr.getvalue())
                self.assertNotIn('redirects are disabled', stderr.getvalue())
                transport.assert_not_called()

    def test_missing_session_fails_before_network_or_transport(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-session-') as temporary:
            arguments = ['context_client', '--terminal', 'zz-canary-terminal',
                         '--session-file', str(pathlib.Path(temporary) / 'missing.json')]
            with patch.object(sys, 'argv', arguments), patch.object(sys, 'stderr', io.StringIO()) as stderr, \
                    patch.object(context_client, 'request_json') as network, \
                    patch.object(context_client, 'terminal_transport') as transport:
                self.assertEqual(context_client.terminal_main(), 1)
            self.assertIn('cauce login', stderr.getvalue())
            network.assert_not_called()
            transport.assert_not_called()

    def test_rejected_grant_is_released_without_opening_transport(self):
        for changes in ({'target': {'tenant_id': 'Beta'}}, {'ticket': ''}, {'authority_proof': ''},
                        {'websocket_path': 'wss://foreign.example/v3/ws/terminal?ticket=' + TICKET}):
            with self.subTest(changes=changes):
                issued = grant(**changes)

                def request(method, path, body=None, issued=issued):
                    if method == 'GET':
                        return {'items': [target()]}
                    if method == 'POST':
                        issued['request_id'] = body['request_id']
                        return issued
                    return {'released': True}

                client = SimpleNamespace(gateway='https://console.example', request=Mock(side_effect=request))
                with patch.object(sys, 'argv', ['context_client', '--terminal', 'zz-canary-terminal']), \
                        patch.object(sys, 'stderr', io.StringIO()) as stderr, \
                        patch.object(context_client, 'ConsoleSessionClient', return_value=client), \
                        patch.object(context_client, 'terminal_transport') as transport:
                    self.assertEqual(context_client.terminal_main(), 1)
                transport.assert_not_called()
                self.assertEqual(client.request.call_args.args, (
                    'DELETE', '/v3/console/terminal/sessions/' + SESSION_ID,
                    {key: issued[key] for key in ('request_id', 'owner_generation', 'owner_token')}))
                for secret in (COOKIE, TICKET, PROOF):
                    self.assertNotIn(secret, stderr.getvalue())


class TerminalActionRoutingTests(unittest.TestCase):
    def test_nominal_actions_and_legacy_actions_remain_routed_separately(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-wrapper-') as temporary:
            root = pathlib.Path(temporary)
            binaries = root / '.local/bin'
            binaries.mkdir(parents=True)
            scripts = {'getent': '#!/bin/sh\nprintf "synthetic:x:1000:1000::%s:/bin/bash\\n" "$HOME"\n',
                       'python3': '#!/bin/sh\nif [ "$1" = -I ]; then printf "nominal\\n"; else printf "legacy-key\\n"; fi\n',
                       'cauce-panel': '#!/bin/sh\nprintf "legacy\\n"\n',
                       'cauce-sesiones': '#!/bin/sh\nprintf "legacy\\n"\n',
                       'cauce-estado': '#!/bin/sh\nprintf "legacy\\n"\n'}
            for name, content in scripts.items():
                path = binaries / name
                path.write_text(content)
                path.chmod(0o700)
            environment = {'HOME': str(root), 'PATH': str(binaries) + os.pathsep + os.defpath,
                           'XDG_STATE_HOME': str(root / 'state'), 'CAUCE_FLEET_RUNTIME_STATE': str(root / 'runtime.json')}
            for nominal in (False, True):
                selected = {**environment, **({'CAUCE_CONSOLE_SESSION_FILE': str(root / 'nominal.json')} if nominal else {})}
                for action in ([], ['ver'], ['estado'], ['sesiones']):
                    with self.subTest(nominal=nominal, action=action):
                        result = subprocess.run(['bash', str(ROOT / 'ops/cli/cauce'), 'zz-canary-terminal', *action],
                                                env=selected, capture_output=True, text=True, timeout=5)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.strip(), 'nominal' if nominal else 'legacy')
                for action in ([], ['ver'], ['estado'], ['sesiones'], ['on'], ['off'],
                               ['--tenant', 'Steven', 'estado']):
                    with self.subTest(action=action, options=True):
                        result = subprocess.run(['bash', str(ROOT / 'ops/cli/cauce'), 'zz-canary-terminal',
                                                 *action, '--tenant', 'Steven'],
                                                env=environment, capture_output=True, text=True, timeout=5)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.strip(), 'nominal')
            for action in ('on', 'off'):
                with self.subTest(action=action, dynamic=True):
                    result = subprocess.run(['bash', str(ROOT / 'ops/cli/cauce'), 'zz-canary-terminal', action],
                                            env={**environment, 'CAUCE_CONSOLE_SESSION_FILE': str(root / 'nominal.json')},
                                            capture_output=True, text=True, timeout=5)
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, 'nominal'), result.stderr)


SERVER_WIRE = r'''
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const { WebSocketServer } = createRequire(join(process.argv[1], 'package.json'))('ws');
const events = process.argv[2];
const mode = process.argv[3];
const event = (value) => appendFileSync(events, JSON.stringify(value) + '\n');
const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/v3/ws/terminal' });
server.on('listening', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
server.on('connection', (socket, request) => {
  event({ event: 'connected', cookie_ok: request.headers.cookie === 'cauce_session=synthetic-terminal-test',
    origin_ok: request.headers.origin === 'http://127.0.0.1:' + server.address().port });
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'attach') {
      event({ event: 'attach', ticket_ok: frame.ticket === 'synthetic-terminal-ticket',
        proof_ok: frame.authority_proof === 'ac2.synthetic-terminal-proof' });
      event({ event: 'ready' });
      socket.send(JSON.stringify({ type: 'ready', session_id: frame.session_id, mode }));
    } else if (frame.type === 'input') {
      event({ event: 'input', data: frame.data });
      socket.send(Buffer.from('terminal-response:' + frame.data));
      socket.send(JSON.stringify({ type: 'closed', exit_code: 0 }));
      socket.close(1000);
    }
  });
});
'''


class TerminalTransportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(shutil.which('node'), 'Node.js is required by the terminal runtime')
        self.assertTrue((ROOT / 'services/terminal-relay/src/session-limits.ts').is_file()
                        or (ROOT / 'dist/services/terminal-relay/src/session-limits.js').is_file(),
                        'The Cauce terminal runtime or its source checkout must be available')
        temporary = tempfile.TemporaryDirectory(prefix='cauce-terminal-cli-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.events_file = self.root / 'events.jsonl'
        self.children = []
        self.watchdogs = []
        self.addCleanup(self.stop_children)
        self.server = subprocess.Popen(
            ['node', '--input-type=module', '--eval', SERVER_WIRE, str(ROOT), str(self.events_file), 'harness_rw'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.children.append(self.server)
        self.assertTrue(select.select([self.server.stdout], [], [], 5)[0], 'WebSocket server did not start')
        self.url = 'http://127.0.0.1:' + str(json.loads(self.server.stdout.readline())['port'])
        self.grant = grant()
        self.client = SimpleNamespace(gateway=self.url, origin=self.url, cookie=COOKIE, ca_file=None)

    def stop_children(self):
        for timer in self.watchdogs:
            timer.cancel()
        for process in reversed(self.children):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()

    def events(self):
        return [json.loads(line) for line in self.events_file.read_text().splitlines()]

    def spawn_transport(self, command, **kwargs):
        for secret in (COOKIE, TICKET, PROOF):
            self.assertNotIn(secret, '\n'.join(command))
        process = self.real_popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, **kwargs)
        self.children.append(process)
        watchdog = threading.Timer(8, process.kill)
        watchdog.daemon = True
        watchdog.start()
        self.watchdogs.append(watchdog)
        process.stdin.write(b'canary-line\n')
        process.stdin.flush()
        return process

    def control(self, method, path, body):
        self.assertEqual((method, path), ('POST', '/v3/console/terminal/sessions/' + SESSION_ID + '/control'))
        self.assertEqual(body, {'action': 'take', **{key: self.grant[key] for key in (
            'request_id', 'owner_generation', 'owner_token', 'authority_proof')}})
        self.assertEqual([event['event'] for event in self.events()], ['connected', 'attach', 'ready'])
        with self.events_file.open('a') as stream:
            stream.write(json.dumps({'event': 'control'}) + '\n')
        return {'session_id': SESSION_ID, 'hold_id': 'synthetic-hold'}

    def test_real_websocket_waits_for_control_before_stdin_and_receives_output(self):
        self.client.request = Mock(side_effect=self.control)
        self.real_popen = subprocess.Popen
        with patch.object(context_client.subprocess, 'Popen', side_effect=self.spawn_transport):
            code = context_client.terminal_transport(self.client, self.grant, 'harness_rw', 100, 30)
        self.assertEqual(code, 0)
        process = self.children[-1]
        self.assertEqual(process.stdout.read(), b'terminal-response:canary-line\n')
        stderr = process.stderr.read()
        for secret in (COOKIE, TICKET, PROOF):
            self.assertNotIn(secret.encode(), stderr)
        self.assertEqual([event['event'] for event in self.events()],
                         ['connected', 'attach', 'ready', 'control', 'input'])
        self.assertTrue(all(self.events()[0][key] for key in ('cookie_ok', 'origin_ok')))
        self.assertTrue(all(self.events()[1][key] for key in ('ticket_ok', 'proof_ok')))
        self.client.request.assert_called_once()

    def test_control_rejection_blocks_stdin_and_releases_session(self):
        requests = []

        def request(method, path, body=None):
            requests.append((method, path, body))
            if method == 'GET':
                return {'items': [target()]}
            if path == '/v3/console/terminal/sessions':
                self.grant.update(request_id=body['request_id'], owner_token=body['owner_token'])
                return self.grant.copy()
            if path.endswith('/control'):
                self.control(method, path, body)
                raise context_client.ContextFailure('synthetic control rejected')
            return {'released': True}

        self.client.request = request
        self.real_popen = subprocess.Popen
        with patch.object(context_client, 'ConsoleSessionClient', return_value=self.client), \
                patch.object(context_client.subprocess, 'Popen', side_effect=self.spawn_transport), \
                patch.object(sys, 'argv', ['context_client', '--terminal', 'zz-canary-terminal']), \
                patch.object(sys, 'stderr') as stderr:
            self.assertEqual(context_client.terminal_main(), 1)
        self.assertIn('synthetic control rejected', ''.join(call.args[0] for call in stderr.write.call_args_list))
        self.assertNotIn('input', [event['event'] for event in self.events()])
        self.assertEqual(requests[-1], ('DELETE', '/v3/console/terminal/sessions/' + SESSION_ID, {
            key: self.grant[key] for key in ('request_id', 'owner_generation', 'owner_token')}))
        self.assertIsNotNone(self.children[-1].poll())


class TerminalWrapperTests(unittest.TestCase):
    def test_nominal_actions_never_read_local_inventory_when_session_is_missing(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-wrapper-') as temporary:
            root = pathlib.Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            invocation = root / 'python-arguments'
            shims = {
                'getent': '#!/bin/sh\nprintf "fixture:x:1:1::%s:/bin/sh\\n" "$CAUCE_TEST_HOME"\n',
                'python3': '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAUCE_TEST_INVOCATION"\nexit 37\n',
            }
            for name, contents in shims.items():
                script = binary / name
                script.write_text(contents)
                script.chmod(0o700)
            environment = {
                **os.environ, 'HOME': str(root), 'CAUCE_TEST_HOME': str(root),
                'CAUCE_CONSOLE_SESSION_FILE': str(root / 'missing-session.json'),
                'CAUCE_FLEET_RUNTIME_STATE': str(root / 'missing-inventory'),
                'CAUCE_TEST_INVOCATION': str(invocation),
                'PATH': str(binary) + os.pathsep + os.environ['PATH'],
            }
            for action in ([], ['ver'], ['estado'], ['sesiones'], ['on'], ['off']):
                with self.subTest(action=action):
                    result = subprocess.run(['bash', str(ROOT / 'ops/cli/cauce'), 'zz-canary-terminal', *action],
                                            env=environment, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 37, result.stderr)
                    arguments = invocation.read_text().splitlines()
                    self.assertEqual(arguments[-(len(action) + 2):], ['--terminal', 'zz-canary-terminal', *action])
                    self.assertFalse(any('container-alias-query' in argument for argument in arguments))
            for name in ('CAUCE_CONSOLE_SESSION_FILE', 'CAUCE_FLEET_RUNTIME_STATE', 'CAUCE_GATEWAY_URL'):
                environment.pop(name, None)
            environment['XDG_STATE_HOME'] = str(root / 'state')
            for action in ('sesiones', 'on', 'off'):
                for option, value in (('--tenant', 'Steven'), ('--gateway', 'https://console.example'),
                                      ('--session-file', str(root / 'missing-session.json')),
                                      ('--ca-file', str(root / 'ca.pem'))):
                    for suffix in ([action, option, value], [option, value, action]):
                        with self.subTest(suffix=suffix):
                            result = subprocess.run(['bash', str(ROOT / 'ops/cli/cauce'), 'zz-canary-terminal', *suffix],
                                                    env=environment, capture_output=True, text=True, timeout=10)
                            self.assertEqual(result.returncode, 37, result.stderr)
                            arguments = invocation.read_text().splitlines()
                            self.assertEqual(arguments[-5:], ['--terminal', 'zz-canary-terminal', *suffix])
                            self.assertFalse(any('container-alias-query' in argument for argument in arguments))

    def test_lifecycle_actions_keep_local_inventory_and_use_gateway_for_unknown_aliases(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-wrapper-') as temporary:
            root = pathlib.Path(temporary)
            binaries = root / 'bin'
            binaries.mkdir()
            invocation = root / 'python-arguments'
            seen = root / 'inventory-probed'
            shims = {
                'getent': '#!/bin/sh\nprintf "fixture:x:1:1::%s:/bin/sh\\n" "$HOME"\n',
                'python3': '''#!/bin/sh
if [ "$1" = -I ]; then printf "nominal\\n"; exit 0; fi
printf "%s\\n" "$*" >> "$CAUCE_TEST_INVOCATION"
if [ "$CAUCE_TEST_LOCAL" = 0 ]; then printf "private inventory error\\n" >&2; exit 2; fi
if [ -e "$CAUCE_TEST_PROBE" ]; then exit 47; fi
touch "$CAUCE_TEST_PROBE"
printf "legacy-key\\n"
''',
            }
            for name, contents in shims.items():
                script = binaries / name
                script.write_text(contents)
                script.chmod(0o700)
            environment = {
                'HOME': str(root), 'PATH': str(binaries) + os.pathsep + os.defpath,
                'CAUCE_CONSOLE_SESSION_FILE': str(root / 'nominal.json'),
                'CAUCE_TEST_INVOCATION': str(invocation), 'CAUCE_TEST_PROBE': str(seen),
            }
            for local in (True, False):
                for action in ('on', 'off'):
                    with self.subTest(action=action, local=local):
                        invocation.unlink(missing_ok=True)
                        seen.unlink(missing_ok=True)
                        result = subprocess.run(['bash', str(ROOT / 'ops/cli/cauce'), 'zz-canary-local', action],
                                                env={**environment, 'CAUCE_TEST_LOCAL': str(int(local))},
                                                capture_output=True, text=True, timeout=10)
                        expected = (47, '') if local else (0, 'nominal\n')
                        self.assertEqual((result.returncode, result.stdout), expected, result.stderr)
                        self.assertEqual(result.stderr, '')
                        calls = invocation.read_text().splitlines()
                        self.assertEqual(len(calls), 2 if local else 1)
                        self.assertTrue(all('container-alias-query.py zz-canary-local --runtime-key' in call
                                            for call in calls))


if __name__ == '__main__':
    unittest.main()
