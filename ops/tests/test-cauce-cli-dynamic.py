from __future__ import annotations

import json
import os
import pathlib
import pwd
import shlex
import subprocess
import sys
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'scripts'))
sys.path.insert(0, str(OPS / 'tests'))
from fleet_runtime_materialization import materialize  # noqa: E402
from test_fleet_runtime_materialization import dynamic_source  # noqa: E402


class DynamicCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-cli-dynamic-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.home = self.root / 'home'
        self.bin = self.home / '.local/bin'
        self.bin.mkdir(parents=True)
        link = self.home / '.local/share/cauce-v3/ops'
        link.parent.mkdir(parents=True)
        link.symlink_to(OPS)
        for name, folder in [('cauce-panel', 'cli'), ('cauce-sesiones', 'guardias'), ('cauce-estado', 'guardias')]:
            (self.bin / name).symlink_to(OPS / folder / name)
        self.log = self.root / 'calls.jsonl'
        self.environment = {**os.environ, 'HOME': str(self.home), 'CAUCE_TEST_HOME': str(self.home),
                            'PATH': str(self.bin) + ':' + os.environ['PATH'], 'PYTHONDONTWRITEBYTECODE': '1',
                            'CAUCE_FLEET_RUNTIME_STATE': str(self.root / 'inventory'),
                            'CAUCE_TEST_LOG': str(self.log)}
        self.script('getent', '#!/bin/sh\nprintf "fixture:x:1000:1000::%s:/bin/sh\\n" "$CAUCE_TEST_HOME"\n')
        for name in ('ssh', 'tmux', 'docker', 'systemctl'):
            self.script(name, '''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CAUCE_TEST_LOG'], 'a') as stream:
    stream.write(json.dumps({'command': os.path.basename(sys.argv[0]), 'argv': sys.argv[1:],
                             'home': os.environ.get('HOME'), 'runtime': os.environ.get('XDG_RUNTIME_DIR')}) + '\\n')
if 'capture-pane' in ' '.join(sys.argv):
    print('existing pane')
elif os.path.basename(sys.argv[0]) == 'ssh':
    print('{"error":null,"sesiones":[],"otros":{}}')
sys.exit(int(os.environ.get('CAUCE_TEST_EXIT', '0')))
''')
        self.publish()

    def script(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o700)

    def publish(self, *, native=True, host='fixture-host', user='dev', harness='codex'):
        source = dynamic_source()
        source['agents'][0].update(runtime_mode='native' if native else 'container', host_id=host,
                                    container_name='host:' + host if native else 'fixture-box', runtime_user=user,
                                    state_directory=('/var/lib/cauce-v3/aliases/physical-one' if native else
                                                     '/home/fixture-runtime/.local/state/cauce-v3/physical-one'),
                                    systemd_user='manager', home_directory='/home/fixture-runtime', harness_id=harness)
        receipt = materialize(source, {}, self.root / 'inventory')
        (self.root / 'inventory/applied-fleet.json').write_text(json.dumps(receipt))
        return receipt

    def run_cli(self, *arguments, **extra):
        return subprocess.run(['bash', str(OPS / 'cli/cauce'), *arguments], capture_output=True,
                              text=True, input='keep stdin\n', env={**self.environment, **extra}, timeout=20)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_remote_native_attach_uses_runtime_user_and_existing_physical_session(self):
        result = self.run_cli('Equipo_42/shared_alias')
        self.assertEqual(result.returncode, 0, result.stderr)
        call, = self.calls()
        self.assertEqual(call['argv'][:1], ['-n'])
        self.assertEqual(call['argv'][call['argv'].index('-l') + 1:-1], ['dev', 'fixture-host'])
        script = shlex.split(call['argv'][-1])[-1]
        self.assertIn("HOME=/home/fixture-runtime", script)
        self.assertIn('tmux -L cauce attach-session -t cauce-physical-one:agente', script)
        for forbidden in ('ensure', 'systemctl', 'docker', 'resume', 'sudo'):
            self.assertNotIn(forbidden, script)

    def test_container_attach_uses_host_manager_and_published_container_user(self):
        self.publish(native=False)
        result = self.run_cli('shared_alias')
        self.assertEqual(result.returncode, 0, result.stderr)
        call, = self.calls()
        self.assertEqual(call['argv'][call['argv'].index('-l') + 1], 'manager')
        script = shlex.split(call['argv'][-1])[-1]
        self.assertIn('docker exec -i --user dev', script)
        self.assertIn("--env HOME=/home/fixture-runtime fixture-box tmux", script)

    def test_interactive_attach_allocates_remote_tty(self):
        result = subprocess.run(['script', '-qefc', shlex.join(['bash', str(OPS / 'cli/cauce'), 'shared_alias']),
                                 '/dev/null'], capture_output=True, text=True, env=self.environment, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0]['argv'][0], '-t')

    def test_local_native_attach_preserves_published_home_and_current_uid(self):
        user = pwd.getpwuid(os.geteuid()).pw_name
        self.publish(host='local', user=user)
        result = self.run_cli('shared_alias')
        self.assertEqual(result.returncode, 0, result.stderr)
        call, = self.calls()
        self.assertEqual(call['command'], 'tmux')
        self.assertEqual(call['home'], '/home/fixture-runtime')
        self.assertEqual(call['runtime'], '/run/user/' + str(os.geteuid()))

    def test_read_commands_keep_published_host_and_user(self):
        for verb in ('ver', 'sesiones'):
            result = self.run_cli('shared_alias', verb)
            self.assertEqual(result.returncode, 0, result.stderr)
        for call in self.calls():
            self.assertEqual(call['command'], 'ssh')
            self.assertEqual(call['argv'][call['argv'].index('-l') + 1:-1], ['dev', 'fixture-host'])
        self.assertIn('capture-pane', self.calls()[0]['argv'][-1])

    def test_mutations_reject_before_any_runtime_effect(self):
        for verb in ('on', 'off', 'retirar', 'auth', 'aprovisionar'):
            result = self.run_cli('shared_alias', verb)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('consola', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_status_reads_manager_and_runtime_accounts_on_applied_host(self):
        result = self.run_cli('shared_alias', 'estado')
        self.assertEqual(result.returncode, 0, result.stderr)
        users = set()
        for call in self.calls():
            self.assertEqual(call['command'], 'ssh')
            user, host = call['argv'][call['argv'].index('-l') + 1:-1]
            self.assertEqual(host, 'fixture-host')
            users.add(user)
        self.assertEqual(users, {'dev', 'manager'})

    def test_openclaw_without_tmux_points_to_console_without_runtime_effect(self):
        self.publish(harness='openclaw')
        result = self.run_cli('shared_alias')
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('consola', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_unverified_inventory_fails_before_terminal_or_runtime_command(self):
        receipt = self.publish()
        path = self.root / 'inventory/generations' / receipt['generation'] / 'flota.json'
        path.write_text('{}')
        result = self.run_cli('shared_alias')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_attach_propagates_remote_failure(self):
        result = self.run_cli('shared_alias', CAUCE_TEST_EXIT='37')
        self.assertEqual(result.returncode, 37, result.stderr)

    def test_subcommands_take_precedence_over_alias_resolution(self):
        for command in ('login', 'spaces'):
            result = self.run_cli(command, '--help', CAUCE_FLEET_RUNTIME_STATE='')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('usage:', result.stdout)
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
