import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import types

stage = 'input'
allowed_codes = set()
permanent_error = None


def source_module(name, expected):
    global stage
    stage = 'source_pin'
    path = pathlib.Path('/cauce/lifecycle') / (name + '.py')
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 262144 or before.st_mode & 0o022:
            raise ValueError('invalid guard source')
        raw = os.read(descriptor, 262145)
        after = os.fstat(descriptor)
        if len(raw) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) \
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('guard source changed during observation')
    finally:
        os.close(descriptor)
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('guard source pin differs')
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module, raw.decode()


def pane_clients(pane):
    rows = pane.run('list-panes', '-t', pane.target, '-F', '#{session_attached}').splitlines()
    if len(rows) != 1 or re.fullmatch(r'[0-9]+', rows[0]) is None:
        raise ValueError('the shared pane client count is ambiguous')
    return int(rows[0])


def main():
    global stage, allowed_codes, permanent_error
    packet = json.loads(sys.stdin.buffer.read(65537))
    if set(packet) != {'expected', 'sources'}:
        raise ValueError('invalid observer packet')
    names = ('cauce_container_base', 'cauce_container_proc', 'cauce_container_restart')
    if set(packet['sources']) != set(names):
        raise ValueError('invalid observer sources')
    loaded = {name: source_module(name, packet['sources'][name]) for name in names}
    base, proc, guard = (loaded[name][0] for name in names)
    permanent_error = base.PermanentError
    allowed_codes = {'RESTART_HOLD_' + value for value in re.findall(r'\bhold\("([A-Z][A-Z0-9_]*)"\)', loaded[names[2]][1])}
    expected = packet['expected']
    stage = 'metadata_before'
    control = base.open_control_directory(expected['controlDirectory'])
    try:
        document, raw = proc.read_metadata(control)
        if document is None or any(document.get(name) != value for name, value in expected.items()):
            raise ValueError('runtime metadata differs')
        proc.require_current_generation(document, expected['containerId'], expected['containerGeneration'])
        proc.verify_adapter(document, expected['alias'], expected['stateDirectory'])
        proc.verify_controller(document)
        stage = 'composer'
        pane = guard.shared_pane(document)
        if pane is None:
            raise ValueError('the canonical shared pane is absent')
        fields = pane.fields()
        clients = pane_clients(pane)
        if clients != 0:
            raise ValueError('the shared pane still has clients')
        snapshot = pane.run('capture-pane', '-p', '-e', '-t', fields[0])
        lines = snapshot.splitlines()
        cursor_x, cursor_y = int(fields[4]), int(fields[5])
        plain = [guard.strip_style(line) for line in lines]
        prompt = guard.PROMPT.match(plain[cursor_y]) if 0 <= cursor_y < len(plain) else None
        content = plain[cursor_y][prompt.end():].strip(' │') if prompt else ''
        composer = {'prompt_known': prompt is not None, 'previous_line_blank': cursor_y == 0 or not plain[cursor_y - 1].strip(),
                    'dim_placeholder': bool(prompt and content and guard.dim_text(lines[cursor_y], lines[cursor_y].find(prompt.group(1)) + 1)),
                    'cursor_at_start': bool(prompt and cursor_x == len(plain[cursor_y][:prompt.end()].rstrip()) + 1)}
        stage = 'canonical_guard'
        accepted, code = True, None
        try:
            guard.assert_restart_safe(document)
        except base.PermanentError as error:
            accepted = False
            if str(error) not in allowed_codes:
                raise ValueError('the guard returned an unknown code') from None
            code = str(error)
        stage = 'metadata_after'
        proc.verify_adapter(document, expected['alias'], expected['stateDirectory'])
        proc.verify_controller(document)
        if proc.read_metadata(control) != (document, raw):
            raise ValueError('runtime metadata changed during observation')
        pane.fields()
        if pane_clients(pane) != 0:
            raise ValueError('the shared pane acquired a client during observation')
        print(json.dumps({'canonical_guard_accepted': accepted, 'guard_code': code, 'composer': composer,
                          'metadata_stable': True, 'clients_before': clients, 'clients_after': 0,
                          'source_pins': packet['sources']}))
    finally:
        os.close(control)


try:
    main()
except Exception as error:
    code = str(error) if permanent_error is not None and isinstance(error, permanent_error) and str(error) in allowed_codes else None
    print(json.dumps({'observation_error': {'stage': stage, 'type': type(error).__name__, 'errno': getattr(error, 'errno', None), 'guard_code': code}}))
    raise SystemExit(1) from None
