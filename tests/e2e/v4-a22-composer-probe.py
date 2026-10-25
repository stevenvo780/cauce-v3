from __future__ import annotations

import hashlib
import importlib
import json
import pathlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Probe:
    def __init__(self, manifest: dict):
        self.manifest = manifest
        self.directory = pathlib.Path(manifest['directory'])
        self.socket = 'zz-canary-a22-' + str(uuid.uuid4())
        self.socket_root = pathlib.Path(tempfile.mkdtemp(prefix='zz-canary-a22-'))
        self.environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(self.directory),
                            'TERM': 'xterm-256color', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                            'TMUX_TMPDIR': str(self.socket_root)}
        self.session = ''
        self.last_snapshot = None
        sys.path.insert(0, str(pathlib.Path(manifest['root']) / 'ops/container-runtime'))
        self.guard = importlib.import_module('cauce_container_restart')
        self.permanent_error = importlib.import_module('cauce_container_base').PermanentError

    def tmux(self, *args: str, payload: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(['tmux', '-f', '/dev/null', '-L', self.socket, *args], input=payload,
                              env=self.environment, text=True, capture_output=True, check=check, timeout=10)

    def snapshot(self) -> dict:
        fields = '#{pane_id}|#{pane_pid}|#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{pane_dead}'
        before = self.tmux('display-message', '-p', '-t', '=' + self.session + ':agente', fields).stdout.strip().split('|')
        pane = self.tmux('capture-pane', '-p', '-e', '-t', before[0]).stdout
        after = self.tmux('display-message', '-p', '-t', before[0], fields).stdout.strip().split('|')
        if before != after:
            raise RuntimeError('PANE_CHANGED_DURING_CAPTURE')
        if before[6] != '0':
            raise RuntimeError('PROVIDER_EXITED')
        pid = int(before[1])
        starttime = pathlib.Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
        self.last_snapshot = {'pane': pane, 'pane_id': before[0], 'pid': pid, 'starttime': starttime,
                              'cursor_x': int(before[2]), 'cursor_y': int(before[3]),
                              'width': int(before[4]), 'height': int(before[5])}
        return self.last_snapshot

    def stable(self, condition, timeout: float = 8) -> dict:
        deadline, previous, consecutive = time.monotonic() + timeout, None, 0
        while time.monotonic() < deadline:
            try:
                current = self.snapshot()
            except RuntimeError as error:
                if str(error) != 'PANE_CHANGED_DURING_CAPTURE':
                    raise
                time.sleep(0.03)
                continue
            consecutive = consecutive + 1 if current == previous else 0
            if condition(current) and consecutive >= 2:
                return current
            previous = current
            time.sleep(0.05)
        raise RuntimeError('PROVIDER_CONDITION_TIMEOUT')

    def send(self, text: str, pane: str) -> None:
        name = 'zz-canary-input-' + uuid.uuid4().hex
        self.tmux('load-buffer', '-b', name, '-', payload=text)
        self.tmux('paste-buffer', '-d', '-r', '-b', name, '-t', pane)

    @staticmethod
    def witness(directory: pathlib.Path) -> tuple[dict, dict]:
        transcripts, counters = {}, {}
        for path in directory.rglob('*'):
            if not path.is_file() or path.name in {'double-input.jsonl', 'double-normalization.jsonl', 'tui-debug.log'}:
                continue
            if path.suffix == '.jsonl' or path.name == 'submitted.json':
                transcripts[str(path.relative_to(directory))] = digest(path.read_bytes())
            if path.name in {'controlled-tui-state.json', 'tui-state.json'}:
                try:
                    counters[str(path.relative_to(directory))] = json.loads(path.read_text()).get('submits')
                except (OSError, ValueError):
                    counters[str(path.relative_to(directory))] = 'unreadable'
        return transcripts, counters

    def response_seen(self, directory: pathlib.Path, snapshot: dict) -> bool:
        if self.manifest['expected'] in snapshot['pane']:
            return True
        for path in directory.rglob('*.jsonl'):
            if path.name not in {'double-input.jsonl', 'double-normalization.jsonl'} \
                    and self.manifest['expected'].encode() in path.read_bytes():
                return True
        return False

    @staticmethod
    def turns(directory: pathlib.Path, marker: str = '') -> tuple[int, bool]:
        count, marker_submitted = 0, False
        for path in directory.rglob('*.jsonl'):
            if path.name in {'double-input.jsonl', 'double-normalization.jsonl'}:
                continue
            for line in path.read_text().splitlines():
                packet = json.loads(line)
                payload = packet.get('payload', {})
                user = packet.get('type') == 'user' or packet.get('payload_type') == 'runtime.user_intent.accepted' \
                    or (packet.get('type') == 'response_item' and payload.get('role') == 'user')
                if user:
                    count += 1
                    marker_submitted = marker_submitted or bool(marker and marker in line)
        return count, marker_submitted

    def judge(self, snapshot: dict) -> dict:
        try:
            self.guard.assert_empty_composer(snapshot['pane'], snapshot['cursor_x'], snapshot['cursor_y'],
                                             self.manifest['harness'])
            code = 'PASS'
        except self.permanent_error as error:
            code = str(error)
        return {'code': code, 'cursor_x': snapshot['cursor_x'], 'cursor_y': snapshot['cursor_y'],
                'width': snapshot['width'], 'height': snapshot['height'], 'pid': snapshot['pid'],
                'pane_id': snapshot['pane_id'], 'process_starttime': snapshot['starttime'],
                'pane_sha256': digest(snapshot['pane'].encode())}

    def run_case(self, case: dict) -> dict:
        variant = case['variant']
        directory = pathlib.Path(case['directory'])
        self.session = 'zz-canary-' + variant.replace('_', '-')
        self.last_snapshot = None
        environment = {**self.environment, **case['environment']}
        command = ['env', '-i', *(f'{key}={value}' for key, value in environment.items()), *case['command']]
        result = {'case': variant, 'source_sha256': case['sourceSha256'], 'script_sha256': case['scriptSha256']}
        try:
            self.tmux('new-session', '-d', '-s', self.session, '-n', 'agente', '-x', '160', '-y', '40',
                      '-c', str(directory / 'workspace'), 'exec ' + shlex.join(command))
            self.tmux('set-option', '-s', 'exit-empty', 'off')
            self.tmux('set-option', '-g', 'status', 'off')
            self.tmux('set-option', '-w', '-t', '=' + self.session + ':agente', 'remain-on-exit', 'on')
            initial = self.stable(lambda snapshot: self.manifest['ready'] in snapshot['pane'])
            if initial['width'] < 160 or initial['height'] < 40:
                raise RuntimeError('PANE_DIMENSIONS_BELOW_MINIMUM')
            result['initial'] = self.judge(initial)
            if variant == 'idle_start':
                result['passed'] = result['initial']['code'] == 'PASS'
                return result
            if variant.startswith('two_turns_crlf'):
                result['turns'] = []
                fragmented = variant.endswith('_fragmented')
                for number in (1, 2):
                    ending = '\r' if fragmented else '\r\n'
                    self.send('\x1b[200~' + self.manifest['input'] + '\x1b[201~' + ending, initial['pane_id'])
                    completed = self.stable(lambda snapshot, count=number:
                                            self.response_seen(directory, snapshot) and self.turns(directory)[0] == count)
                    if fragmented:
                        self.send('\n', initial['pane_id'])
                        completed = self.stable(lambda _: True)
                    result['turns'].append(self.judge(completed))
                result['completed_turn_count'] = self.turns(directory)[0]
                result['same_process_after_turns'] = all(
                    (turn['pid'], turn['process_starttime'], turn['pane_id'])
                    == (initial['pid'], initial['starttime'], initial['pane_id']) for turn in result['turns'])
                result['passed'] = result['completed_turn_count'] == 2 \
                    and all(turn['code'] == 'PASS' for turn in result['turns']) and result['same_process_after_turns']
                return result
            before_turn = self.witness(directory)
            self.send('\x1b[200~' + self.manifest['input'] + '\x1b[201~\r', initial['pane_id'])
            history = self.stable(lambda snapshot: self.response_seen(directory, snapshot))
            result['history'] = self.judge(history)
            result['response_observed'] = self.response_seen(directory, history)
            result['turn_evidence_changed'] = before_turn != self.witness(directory)
            result['same_process_after_turn'] = (history['pid'], history['starttime'], history['pane_id']) \
                == (initial['pid'], initial['starttime'], initial['pane_id'])
            if variant == 'idle_history':
                result['passed'] = result['history']['code'] == 'PASS' and result['turn_evidence_changed'] \
                    and result['same_process_after_turn']
                return result
            marker = ('NEXT-OWNED-DRAFT-' if variant == 'completed_turn_with_next_draft' else 'A22_DRAFT_') \
                + uuid.uuid4().hex[:10]
            second = 'A22_SECOND_' + uuid.uuid4().hex[:10]
            payloads = {'plain_draft': marker, 'placeholder_draft': self.manifest['placeholder'],
                        'open_paste': '\x1b[200~' + marker,
                        'multiline_open_paste': '\x1b[200~' + marker + '\n' + second,
                        'multiline_closed_no_enter': '\x1b[200~' + marker + '\n' + second + '\x1b[201~',
                        'completed_turn_with_next_draft': '\x1b[200~' + self.manifest['input']
                        + '\x1b[201~\r\x1b[200~' + marker}
            expected = [self.manifest['placeholder']] if variant == 'placeholder_draft' else [marker]
            if variant.startswith('multiline_'):
                expected.append(second)
            before_draft = self.witness(directory)
            turns_before, _ = self.turns(directory)
            self.send(payloads[variant], history['pane_id'])
            draft = self.stable(lambda _: True)
            unchanged = before_draft == self.witness(directory)
            combined = variant == 'completed_turn_with_next_draft'
            observation = 2.5 if combined else 0.75
            deadline = time.monotonic() + observation
            while time.monotonic() < deadline:
                unchanged = unchanged and before_draft == self.witness(directory)
                draft = self.stable(lambda _: True, timeout=2)
            result['draft'] = self.judge(draft)
            after_guard = self.snapshot()
            result['text_preserved'] = all(text in self.guard.strip_style(draft['pane']) for text in expected) \
                and all(text in self.guard.strip_style(after_guard['pane']) for text in expected)
            result['turn_evidence_preserved'] = unchanged and before_draft == self.witness(directory)
            turns_after, marker_submitted = self.turns(directory, marker)
            delta = turns_after - turns_before
            result['submitted_turn_delta'] = delta
            result['next_turn_not_submitted'] = not marker_submitted and 0 <= delta <= 1
            result['next_draft_preserved'] = result['text_preserved'] and not marker_submitted
            if combined:
                result['first_turn_state'] = 'safe_hold_first_turn_deferred' if delta == 0 else 'first_turn_submitted'
            result['single_submission'] = True
            result['same_process_with_draft'] = (after_guard['pid'], after_guard['starttime'], after_guard['pane_id']) \
                == (history['pid'], history['starttime'], history['pane_id'])
            result['guard_did_not_change_pane'] = draft == after_guard
            result['observation_ms'] = int(observation * 1000)
            result['passed'] = result['draft']['code'].startswith('RESTART_HOLD_') and result['text_preserved'] \
                and (result['next_turn_not_submitted'] if combined else result['turn_evidence_preserved']) \
                and result['same_process_with_draft'] \
                and result['guard_did_not_change_pane']
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            result['error'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            if isinstance(error, subprocess.CalledProcessError):
                result['tmux_error'] = {'operation': error.cmd[5], 'exit_code': error.returncode,
                                        'stderr': error.stderr.strip()}
            result['passed'] = False
            if self.last_snapshot:
                result['last_snapshot'] = self.judge(self.last_snapshot)
        finally:
            self.tmux('kill-session', '-t', '=' + self.session, check=False)
        return result

    def run(self) -> dict:
        guard_path = pathlib.Path(self.guard.__file__)
        result = {'provider': self.manifest['id'], 'source': self.manifest['source'],
                  'harness': self.manifest['harness'], 'guard_sha256': digest(guard_path.read_bytes()),
                  'probe_sha256': digest(pathlib.Path(__file__).read_bytes()),
                  'guard_module_matches_source': guard_path.resolve()
                  == (pathlib.Path(self.manifest['root']) / 'ops/container-runtime/cauce_container_restart.py').resolve(),
                  'cases': []}
        try:
            result['cases'] = [self.run_case(case) for case in self.manifest['cases']]
        finally:
            self.tmux('kill-server', check=False)
            remaining = self.tmux('list-sessions', check=False)
            error = remaining.stderr.strip()
            absent = remaining.returncode != 0 and not remaining.stdout.strip() and (
                error.startswith('no server running on ') or (
                    error.startswith('error connecting to ') and error.endswith('(No such file or directory)')))
            result['cleanup'] = {'owned_tmux_absent': absent, 'socket_prefix': 'zz-canary-a22-',
                                 'absence_known': absent, 'list_sessions_exit_code': remaining.returncode}
            if absent:
                shutil.rmtree(self.socket_root)
            result['cleanup']['owned_socket_directory_removed'] = not self.socket_root.exists()
        result['passed'] = all(case['passed'] for case in result['cases']) and result['cleanup']['owned_tmux_absent'] \
            and result['cleanup']['owned_socket_directory_removed'] and result['guard_module_matches_source']
        return result


def main() -> None:
    manifest, receipt = (pathlib.Path(value) for value in sys.argv[1:3])
    result = Probe(json.loads(manifest.read_text())).run()
    receipt.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
