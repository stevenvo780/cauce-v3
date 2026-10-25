# cauce:timeout-ms 600000
from __future__ import annotations

import argparse
import json
import os
import pathlib
import pty
import pwd
import select
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import uuid
from fcntl import ioctl

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'scripts'))
sys.path.insert(0, str(OPS / 'tests'))
import disposable_docker  # noqa: E402
from fleet_runtime_materialization import materialize  # noqa: E402
from test_fleet_runtime_materialization import dynamic_source  # noqa: E402

DETACH = b'\x02d'


def attach_and_detach(argv: list[str], environment: dict, expect: bytes, keys: bytes = DETACH,
                      timeout: float = 45.0) -> tuple[int, bytes]:
    """Opens the terminal in a real pty, waits until the expected session is on screen, detaches and waits."""
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(argv[0], argv, environment)
    ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
    output, sent, deadline = b'', False, time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.25)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            if not sent and expect in output:
                time.sleep(0.3)
                os.write(master, keys)
                sent = True
        else:
            os.kill(pid, signal.SIGTERM)
        _, status = os.waitpid(pid, 0)
    finally:
        os.close(master)
    return (os.waitstatus_to_exitcode(status) if sent else -1), output


class FixtureHome(unittest.TestCase):
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
                            'XDG_STATE_HOME': str(self.root / 'state'),
                            'DOCKER_CONFIG': os.environ.get('DOCKER_CONFIG', str(pathlib.Path.home() / '.docker')),
                            'CAUCE_FLEET_RUNTIME_STATE': str(self.root / 'inventory'),
                            'CAUCE_TEST_LOG': str(self.log)}
        for name in ('CAUCE_GATEWAY_URL', 'CAUCE_CONSOLE_SESSION_FILE'):
            self.environment.pop(name, None)
        self.script('getent', '#!/bin/sh\nprintf "fixture:x:1000:1000::%s:/bin/sh\\n" "$CAUCE_TEST_HOME"\n')

    def script(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o700)

    def publish(self, *, native=True, host='fixture-host', user='dev', harness='codex', container='fixture-box',
                manager='manager', home='/home/fixture-runtime'):
        source = dynamic_source()
        source['agents'][0].update(runtime_mode='native' if native else 'container', host_id=host,
                                    container_name='host:' + host if native else container, runtime_user=user,
                                    state_directory=('/var/lib/cauce-v3/aliases/physical-one' if native else
                                                     home + '/.local/state/cauce-v3/physical-one'),
                                    systemd_user=manager, home_directory=home, harness_id=harness)
        receipt = materialize(source, {}, self.root / 'inventory')
        (self.root / 'inventory/applied-fleet.json').write_text(json.dumps(receipt))
        return receipt

    def run_cli(self, *arguments, **extra):
        return subprocess.run(['bash', str(OPS / 'cli/cauce'), *arguments], capture_output=True,
                              text=True, input='keep stdin\n', env={**self.environment, **extra}, timeout=20)


class DynamicCliTests(FixtureHome):
    def setUp(self):
        super().setUp()
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


class RealDisposableTerminalTests(FixtureHome):
    """Real walkthrough on the local host: real container, real tmux and real docker exec; nothing intercepted."""

    def setUp(self):
        super().setUp()
        reason = disposable_docker.unavailable_reason()
        if reason:
            if disposable_docker.required():
                self.fail(reason)
            self.skipTest(reason)
        self.docker = disposable_docker.Disposable('cli-terminal')
        packages = disposable_docker.PACKAGES
        try:
            disposable_docker.PACKAGES = (*packages, 'python3')
            self.docker.build()
        except (subprocess.SubprocessError, OSError) as error:
            self.docker.cleanup()
            if disposable_docker.required():
                raise
            self.skipTest(f'disposable image unavailable: {error}')
        finally:
            disposable_docker.PACKAGES = packages

    def in_container(self, *arguments, check=True):
        return disposable_docker.docker('exec', '--user', 'node', self.container, 'tmux', '-L', 'cauce', *arguments,
                                        check=check)

    def pane_pid(self):
        return self.in_container('list-panes', '-t', 'cauce-physical-one', '-F', '#{pane_pid}').stdout.strip()

    def host_processes_naming(self, needle: str) -> list[int]:
        found = []
        for entry in pathlib.Path('/proc').iterdir():
            try:
                if entry.name.isdigit() and needle.encode() in (entry / 'cmdline').read_bytes():
                    found.append(int(entry.name))
            except OSError:
                continue
        return found

    def read_legacy_sessions(self, receipt):
        local_ops = self.home / '.local/share/cauce-v3/ops'
        local_ops.unlink()
        (local_ops / 'scripts').mkdir(parents=True)
        generation = self.root / 'inventory/generations' / receipt['generation']
        for name in ('flota.json', 'container-aliases.json'):
            shutil.copy2(generation / name, local_ops / name)
        shutil.copy2(OPS / 'scripts/container-alias-query.py', local_ops / 'scripts/container-alias-query.py')
        for name in ('container_alias_lib.py', 'fleet_derive.py', 'fleet_runtime_inventory.py'):
            (local_ops / 'scripts' / name).symlink_to(OPS / 'scripts' / name)
        self.environment.pop('CAUCE_FLEET_RUNTIME_STATE')
        native_id = str(uuid.uuid4())
        sessions = {'sessions': {'codex:physical-one:synthetic': {'native_id': native_id, 'initialized': True}}}
        disposable_docker.docker('exec', '--user', 'node', self.container, 'node', '--eval',
                                  'const fs=require("node:fs"); const root="/home/node/.local/state/cauce-v3/physical-one"; '
                                  'fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(root+"/sessions.json",process.argv[1]);',
                                  json.dumps(sessions))
        result = self.run_cli('shared_alias', 'sesiones')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sesiones de physical-one (codex): 1 de este harness', result.stdout)
        self.assertIn(native_id[:8], result.stdout)
        self.assertNotIn('no pude leer', result.stdout)
        self.assertEqual(self.in_container('list-clients', '-t', 'cauce-physical-one').stdout.strip(), '')

    def walkthrough(self):
        self.container = self.docker.run('agent', '--user', 'node')
        nonce = 'cauce-recorrido-' + uuid.uuid4().hex[:12]
        self.in_container('new-session', '-d', '-s', 'cauce-physical-one', '-n', 'agente', '-x', '120', '-y', '30',
                          f'echo {nonce}; exec sleep 3600')
        deadline = time.monotonic() + 15
        while nonce not in self.in_container('capture-pane', '-p', '-t', 'cauce-physical-one:agente').stdout:
            self.assertLess(time.monotonic(), deadline, 'the nominal session never showed its marker')
            time.sleep(0.2)
        receipt = self.publish(native=False, host='local', user='node', container=self.container,
                               manager=pwd.getpwuid(os.geteuid()).pw_name, home='/home/node')
        before = self.pane_pid()

        seen = self.run_cli('shared_alias', 'ver')
        self.assertEqual(seen.returncode, 0, seen.stderr)
        self.assertIn(nonce, seen.stdout)

        status, screen = attach_and_detach(['bash', str(OPS / 'cli/cauce'), 'shared_alias'],
                                           {**self.environment, 'TERM': 'xterm-256color'}, nonce.encode())
        self.assertEqual(status, 0, screen[-2000:])
        self.assertIn(nonce.encode(), screen)
        self.assertIn(b'detached', screen)
        self.assertEqual(self.in_container('list-clients', '-t', 'cauce-physical-one').stdout.strip(), '')

        for verb in ('on', 'off'):
            refused = self.run_cli('shared_alias', verb)
            self.assertEqual(refused.returncode, 2, refused.stderr)
            self.assertIn('consola', refused.stderr)
        self.read_legacy_sessions(receipt)
        self.assertEqual(self.pane_pid(), before, 'the terminal walkthrough must not restart the runtime')
        self.assertEqual(self.host_processes_naming(self.container), [])

    def test_enter_see_nominal_session_and_leave_without_residue(self):
        try:
            self.walkthrough()
        finally:
            residue = self.docker.cleanup()
        self.assertEqual(residue, [], 'disposable containers or images survived the walkthrough')
        self.assertEqual(self.host_processes_naming(self.docker.owner), [])


def walkthrough_cli(arguments: list[str]) -> int:
    """`recorrido ALIAS`: the same enter, see and leave check against an installed CLI and a real agent."""
    parser = argparse.ArgumentParser(prog='test-cauce-cli-dynamic.py recorrido')
    parser.add_argument('alias')
    parser.add_argument('--cauce', default=shutil.which('cauce') or 'cauce')
    parser.add_argument('--espera', help='text that proves the expected session is on screen (default: cauce-ALIAS)')
    parser.add_argument('--segundos', type=float, default=45.0)
    options = parser.parse_args(arguments)
    expect = (options.espera or f'cauce-{options.alias}').encode()
    started = time.monotonic()
    status, screen = attach_and_detach([options.cauce, options.alias], {**os.environ, 'TERM': os.environ.get(
        'TERM', 'xterm-256color')}, expect, timeout=options.segundos)
    summary = {'alias': options.alias, 'exit': status, 'sawSession': expect in screen,
               'detached': b'detached' in screen, 'seconds': round(time.monotonic() - started, 1)}
    print(json.dumps(summary, sort_keys=True))
    return 0 if status == 0 and summary['sawSession'] and summary['detached'] else 1


if __name__ == '__main__':
    if sys.argv[1:2] == ['recorrido']:
        raise SystemExit(walkthrough_cli(sys.argv[2:]))
    unittest.main()
