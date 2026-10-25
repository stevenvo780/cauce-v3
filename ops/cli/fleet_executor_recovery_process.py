from __future__ import annotations

import ctypes
import json
import os
import selectors
import signal
import subprocess
import sys
import time


def cleanup(child: subprocess.Popen) -> bool:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=1)
    until = time.monotonic() + 1
    while time.monotonic() < until:
        try:
            while os.waitpid(-child.pid, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.01)
    return False


def supervise(payload: dict) -> dict:
    if set(payload) != {'command', 'environment', 'expires_at'} \
            or not isinstance(payload['command'], list) or not 1 <= len(payload['command']) <= 128 \
            or any(not isinstance(value, str) or '\0' in value for value in payload['command']) \
            or not isinstance(payload['environment'], dict) \
            or any(not isinstance(key, str) or not isinstance(value, str) or '\0' in key + value
                   for key, value in payload['environment'].items()) \
            or type(payload['expires_at']) is not int:
        raise ValueError('invalid recovery supervisor request')
    remaining = payload['expires_at'] / 1000 - time.time()
    if not 0 < remaining <= 8000 / 1000:
        return {'result': None, 'exit_code': None, 'stopped_verified': True}
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise ValueError('recovery supervisor cannot observe descendant cleanup')
    child = None
    def interrupted(_signal, _frame):
        raise InterruptedError('recovery supervisor interrupted')
    for termination in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(termination, interrupted)
    raw, code = bytearray(), None
    stopped = True
    try:
        if time.time() * 1000 >= payload['expires_at']:
            return {'result': None, 'exit_code': None, 'stopped_verified': True}
        child = subprocess.Popen(payload['command'], env=payload['environment'], cwd='/',
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = payload['expires_at'] / 1000 - time.time()
                if remaining <= 0:
                    raise TimeoutError('recovery helper expired')
                for key, _events in selector.select(remaining):
                    part = os.read(key.fd, 16385 - len(raw))
                    if not part:
                        selector.unregister(key.fd)
                    raw.extend(part)
                    if len(raw) > 16384:
                        raise TimeoutError('recovery helper output exceeds its bound')
        # WNOWAIT retains the leader identity until cleanup has signalled its process group.
        while time.time() * 1000 < payload['expires_at']:
            status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            if status is not None:
                code = status.si_status if status.si_code == os.CLD_EXITED else -status.si_status
                break
            time.sleep(0.01)
    except (TimeoutError, InterruptedError):
        pass
    finally:
        if child is not None:
            stopped = cleanup(child)
            child.stdout.close()
    result = json.loads(raw) if raw and len(raw) <= 16384 else None
    return {'result': result, 'exit_code': code, 'stopped_verified': stopped}


if __name__ == '__main__':
    try:
        encoded = sys.stdin.buffer.read(262145)
        if len(encoded) > 262144:
            raise ValueError('recovery supervisor request exceeds its bound')
        print(json.dumps(supervise(json.loads(encoded)), separators=(',', ':')))
    except Exception:
        print(json.dumps({'result': None, 'exit_code': None, 'stopped_verified': False}, separators=(',', ':')))
        raise SystemExit(2) from None
