from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import secrets
import shlex
import socket
import stat
import struct
import subprocess
import sys
import time
from contextlib import ExitStack

from cauce_container_proc import open_pidfd, pidfd_matches_starttime, proc_stat, process_credentials
from cauce_container_tree import PinnedLeaderTree, signal_known_tree
from fleet_policy_paths import SafeFailure
from secure_path import open_absolute_directory

FIELDS = ('session_id', 'session_name', 'window_id', 'window_name', 'pane_id', 'pane_pid',
          'pane_dead', 'session_windows', 'window_panes', '@cauce_alias', '@cauce_harness',
          'pane_current_path', 'pane_start_path', 'pane_start_command')
FORMAT = '\t'.join('#{' + field + '}' for field in FIELDS)
IDENTIFIER = re.compile(r'[a-z][a-z0-9-]{0,63}')


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def invocation(command: str, depth: int = 0) -> list[str]:
    if depth > 2:
        raise SafeFailure('canonical TUI command nesting is ambiguous')
    lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|<>')
    lexer.whitespace_split, lexer.commenters = True, ''
    words = list(lexer)
    if any(word in {';', '&', '|', '&&', '||', '<', '>', '>>'} or '$' in word or '`' in word for word in words):
        raise SafeFailure('canonical TUI command is not a static invocation')
    if words[:1] == ['exec']:
        words = words[1:]
    if words[:1] and words[0] in {'env', '/usr/bin/env', '/bin/env'}:
        words = words[1:]
        while words[:1] == ['-u'] and len(words) >= 2:
            words = words[2:]
        if words[:1] == ['--']:
            words = words[1:]
        while words and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', words[0]):
            words = words[1:]
    if len(words) == 3 and words[0] in {'bash', 'sh', '/bin/bash', '/bin/sh'} and words[1] in {'-c', '-lc'}:
        return invocation(words[2], depth + 1)
    if not words:
        raise SafeFailure('canonical TUI command is unavailable')
    return words


class CanonicalTmux:
    def __init__(self, request: dict):
        self.request = request
        self.uid, self.gid = request['uid'], request['gid']
        self.state = pathlib.Path(request['state_directory'])
        self.directory = self.state / ('tmux-' + str(self.uid))
        self.path = self.directory / 'cauce'
        self.stack = ExitStack()
        self.fd = None
        self.peer = None
        self.server = None
        self.socket_identity = None
        self.directories = []

    def __enter__(self):
        if (self.uid, self.gid) != (os.geteuid(), os.getegid()) or self.uid == 0 or self.gid == 0:
            raise SafeFailure('canonical TUI runtime credentials differ')
        try:
            for path in (self.state, self.directory):
                descriptor = open_absolute_directory(path)
                self.stack.callback(os.close, descriptor)
                details = os.fstat(descriptor)
                if details.st_uid != self.uid or stat.S_IMODE(details.st_mode) != 0o700:
                    raise SafeFailure('canonical TUI directory ownership or mode differs')
                self.directories.append([details.st_dev, details.st_ino])
            self.fd = os.open('cauce', os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            self.stack.callback(os.close, self.fd)
            details = os.fstat(self.fd)
            if not stat.S_ISSOCK(details.st_mode) or (details.st_uid, details.st_gid) != (self.uid, self.gid) \
                    or stat.S_IMODE(details.st_mode) not in {0o600, 0o660}:
                raise SafeFailure('canonical TUI socket ownership or mode differs')
            self.socket_identity = [details.st_dev, details.st_ino]
            self.peer = self.stack.enter_context(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
            self.peer.settimeout(1)
            try:
                self.peer.connect('/proc/self/fd/' + str(self.fd))
            except ConnectionRefusedError:
                return self
            pid, uid, gid = struct.unpack('3i', self.peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if (uid, gid) != (self.uid, self.gid) or pid <= 1:
                raise SafeFailure('canonical TUI server credentials differ')
            server_fd = open_pidfd(pid)
            self.stack.callback(os.close, server_fd)
            starttime = proc_stat(pid)['starttime']
            if not pidfd_matches_starttime(pid, server_fd, starttime):
                raise SafeFailure('canonical TUI server changed during observation')
            self.server = {'pid': pid, 'starttime': starttime}
            self.server_fd = server_fd
            self.check_socket()
            return self
        except FileNotFoundError:
            return self
        except BaseException:
            self.stack.close()
            raise

    def __exit__(self, *_):
        self.stack.close()

    def check_socket(self):
        details = os.stat(self.path, follow_symlinks=False)
        if not stat.S_ISSOCK(details.st_mode) or [details.st_dev, details.st_ino] != self.socket_identity \
                or (details.st_uid, details.st_gid) != (self.uid, self.gid) \
                or stat.S_IMODE(details.st_mode) not in {0o600, 0o660}:
            raise SafeFailure('canonical TUI socket changed')
        if not pidfd_matches_starttime(self.server['pid'], self.server_fd, self.server['starttime']):
            raise SafeFailure('canonical TUI server generation changed')
        for index, path in enumerate((self.state, self.directory)):
            descriptor = open_absolute_directory(path)
            try:
                details = os.fstat(descriptor)
                if details.st_uid != self.uid or stat.S_IMODE(details.st_mode) != 0o700 \
                        or [details.st_dev, details.st_ino] != self.directories[index]:
                    raise SafeFailure('canonical TUI directory changed')
            finally:
                os.close(descriptor)

    def command(self, arguments: list[str]) -> list[str]:
        return ['/usr/bin/tmux', '-N', '-u', '-S', '/proc/self/fd/' + str(self.fd), *arguments]

    def run(self, arguments: list[str]):
        result = subprocess.run(self.command(arguments), pass_fds=(self.fd,), capture_output=True,
            text=True, timeout=1, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        if len(result.stdout) + len(result.stderr) > 65536:
            raise SafeFailure('canonical TUI response exceeds its bound')
        return result

    def empty_hooks(self, arguments: list[str]) -> bool:
        result = self.run(['show-hooks', *arguments])
        return result.returncode == 0 and all(re.fullmatch(r'[a-z][a-z0-9-]*', row)
            for row in result.stdout.splitlines())

    def observe(self) -> dict:
        if self.server is None:
            return {'socket': None, 'directories': None, 'server': None, 'pane': None}
        self.check_socket()
        if not self.empty_hooks(['-g']):
            raise SafeFailure('canonical TUI server has unapproved hooks')
        listed = self.run(['list-sessions', '-F', '#{session_id}\t#{session_name}'])
        if listed.returncode:
            raise SafeFailure('canonical TUI sessions could not be read')
        matches = [row.split('\t')[0] for row in listed.stdout.splitlines()
                   if row.split('\t')[1:] == ['cauce-' + self.request['runtime_key']]]
        witness = {'socket': self.socket_identity, 'directories': self.directories, 'server': self.server, 'pane': None}
        if not matches:
            self.check_socket()
            return witness
        if len(matches) != 1 or not re.fullmatch(r'\$[0-9]+', matches[0]):
            raise SafeFailure('canonical TUI session is ambiguous')
        listed = self.run(['list-panes', '-s', '-t', matches[0], '-F', FORMAT])
        rows = listed.stdout.splitlines()
        if listed.returncode or len(rows) != 1 or len(rows[0].split('\t')) != len(FIELDS):
            raise SafeFailure('canonical TUI pane is ambiguous')
        pane = dict(zip(FIELDS, rows[0].split('\t'), strict=True))
        expected = {'session_id': matches[0], 'session_name': 'cauce-' + self.request['runtime_key'],
            'window_name': 'agente', 'session_windows': '1', 'window_panes': '1',
            '@cauce_alias': self.request['runtime_key'], '@cauce_harness': self.request['harness_id']}
        if any(pane[key] != value for key, value in expected.items()) \
                or not re.fullmatch(r'@[0-9]+', pane['window_id']) or not re.fullmatch(r'%[0-9]+', pane['pane_id']) \
                or pane['pane_dead'] not in {'0', '1'}:
            raise SafeFailure('canonical TUI pane identity differs')
        for flags, target in (([], matches[0]), (['-w'], pane['window_id']), (['-p'], pane['pane_id'])):
            if not self.empty_hooks([*flags, '-t', target]):
                raise SafeFailure('canonical TUI pane has unapproved hooks')
        workspace = pane['pane_current_path'] if pane['pane_dead'] == '0' else pane['pane_start_path']
        if os.path.realpath(workspace) != self.request['workspace']:
            raise SafeFailure('canonical TUI workspace differs')
        if self.request['command'] is not None and invocation(pane['pane_start_command'])[0] != self.request['command']:
            raise SafeFailure('canonical TUI command differs from its approved provider')
        if self.request.get('command_sha256') is not None:
            with open(self.request['command'], 'rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != self.request['command_sha256']:
                    raise SafeFailure('canonical TUI approved command pin differs')
        pane['command_sha256'] = fingerprint(pane.pop('pane_start_command'))
        pane['starttime'] = None
        if pane['pane_dead'] == '0':
            if not re.fullmatch(r'[1-9][0-9]*', pane['pane_pid']):
                raise SafeFailure('canonical TUI process is unavailable')
            pid = int(pane['pane_pid'])
            if process_credentials(pid) != (self.uid, self.gid):
                raise SafeFailure('canonical TUI process credentials differ')
            pane['starttime'] = proc_stat(pid)['starttime']
        witness['pane'] = pane
        self.check_socket()
        return witness

    def cas(self, pane: dict, command: str) -> bool:
        values = {key: pane[key] for key in FIELDS[:11]}
        condition = ['#{==:#{' + key + '},' + value + '}' for key, value in values.items()]
        combined = condition[0]
        for value in condition[1:]:
            combined = '#{&&:' + combined + ',' + value + '}'
        token = 'cauce-tui-stop-' + secrets.token_hex(16)
        channels = [token + '-yes', token + '-no']
        waiters = []
        try:
            for name in channels:
                waiters.append(subprocess.Popen(self.command(['wait-for', name]), pass_fds=(self.fd,),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}))
            result = self.run(['if-shell', '-F', '-t', pane['pane_id'], combined,
                (command + ' ; ' if command else '') + 'wait-for -S ' + channels[0], 'wait-for -S ' + channels[1]])
            until = time.monotonic() + 0.3
            while time.monotonic() < until and all(child.poll() is None for child in waiters):
                time.sleep(0.01)
            return result.returncode == 0 and waiters[0].poll() == 0 and waiters[1].poll() is None
        finally:
            for child in waiters:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=1)


def original_alive(pane: dict | None) -> bool:
    if pane is None or pane['starttime'] is None:
        return False
    try:
        current = proc_stat(int(pane['pane_pid']))
        return current['starttime'] == pane['starttime'] and current['state'] not in {'Z', 'X'}
    except ProcessLookupError:
        return False


def original_dead_pane(current: dict, expected: dict) -> bool:
    pane, original = current['pane'], expected['pane']
    return pane is not None and original is not None and pane['pane_dead'] == '1' \
        and all(current[key] == expected[key] for key in ('socket', 'directories', 'server')) \
        and all(pane[key] == original[key] for key in (*FIELDS[:6], *FIELDS[7:11], 'pane_start_path', 'command_sha256'))


def close_session(tmux: CanonicalTmux, expected: dict) -> None:
    current = tmux.observe()
    pane = expected['pane']
    if pane is None:
        if current['pane'] is None:
            return
        raise SafeFailure('canonical TUI appeared after its absence witness')
    if current != expected:
        if not original_alive(pane) and (current['pane'] is None or current['pane']['pane_id'] != pane['pane_id']
                or current['server'] != expected['server']):
            return
        if not original_alive(pane) and original_dead_pane(current, expected):
            pane = current['pane']
        else:
            raise SafeFailure('canonical TUI generation changed before shutdown')
    if pane['pane_dead'] == '1':
        tmux.cas(pane, 'kill-pane -t ' + pane['pane_id'])
    else:
        tree = PinnedLeaderTree(int(pane['pane_pid']))
        try:
            if tree.leader_starttime != pane['starttime'] or tmux.observe() != expected or not tmux.cas(pane, ''):
                raise SafeFailure('canonical TUI changed after process pinning')
            signal_known_tree(tree, 2, 2, can_reap=False)
        finally:
            tree.close()
    if tmux.server is not None and not pidfd_matches_starttime(
            tmux.server['pid'], tmux.server_fd, tmux.server['starttime']):
        if original_alive(pane):
            raise SafeFailure('canonical TUI process outlived its server')
        return
    try:
        current = tmux.observe()
    except (FileNotFoundError, ConnectionRefusedError, ProcessLookupError):
        current = None
    if original_alive(pane):
        raise SafeFailure('canonical TUI original process survived shutdown')
    if current is not None and current['pane'] is not None:
        dead = current['pane']
        if not original_dead_pane(current, expected):
            raise SafeFailure('canonical TUI replacement was preserved during shutdown')
        tmux.cas(dead, 'kill-pane -t ' + dead['pane_id'])
        if not pidfd_matches_starttime(tmux.server['pid'], tmux.server_fd, tmux.server['starttime']):
            return
        try:
            if tmux.observe()['pane'] is not None:
                raise SafeFailure('canonical TUI session remains after shutdown')
        except (FileNotFoundError, ConnectionRefusedError, ProcessLookupError):
            pass


def perform(request: dict) -> dict:
    if not IDENTIFIER.fullmatch(request['runtime_key']) or request['harness_id'] not in {'codex', 'claude', 'grok', 'muse'}:
        raise SafeFailure('canonical TUI identity is invalid')
    with CanonicalTmux(request) as tmux:
        if request['action'] == 'observe':
            return tmux.observe()
        if request['action'] != 'close' or not isinstance(request.get('witness'), dict):
            raise SafeFailure('canonical TUI shutdown witness is required')
        close_session(tmux, request['witness'])
        return {'canonical_tui_stopped': True}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(262145)
        if len(raw) > 262144:
            raise SafeFailure('canonical TUI request exceeds its bound')
        print(json.dumps(perform(json.loads(raw)), separators=(',', ':')))
    except SafeFailure as error:
        sys.stderr.write(str(error) + '\n')
        raise SystemExit(2) from None
    except Exception:
        sys.stderr.write('canonical TUI identity or exact shutdown was not verified\n')
        raise SystemExit(2) from None
