from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import ssl
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cauce_pty_agent.framing import PermanentError
from cauce_pty_agent.runtime_facts import BUNDLE_KEYS, validate_bundle

STATE = Path('/state')
HOME = STATE / 'home'
PROOF = HOME / 'move-proof.txt'
BUNDLE = STATE / 'agent-bundle.json'
MAX_BODY = 64 * 1024
CONTAINER = os.environ['CAUCE_DESTINATION_CONTAINER']
RELAY_HOST = os.environ['CAUCE_SOURCE_RELAY_HOST']
PORT = int(os.environ['CAUCE_MANAGER_PORT'])
LOCK = threading.Lock()
CHILD: subprocess.Popen | None = None
STARTED = False


def status() -> dict:
    marker = None
    try:
        descriptor = os.open(PROOF, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_size <= 512:
                marker = hashlib.sha256(os.read(descriptor, 513)).hexdigest()
        finally:
            os.close(descriptor)
    except OSError:
        pass
    return {'process_alive': CHILD is not None and CHILD.poll() is None,
            'marker_sha256': marker, 'pid': None if CHILD is None else CHILD.pid,
            'container': CONTAINER, 'home': str(HOME)}


def prepare(document: object) -> tuple[dict, bytes]:
    if not isinstance(document, dict) or set(document) != {'bundle', 'marker'}:
        raise ValueError('invalid request')
    supplied, marker = document['bundle'], document['marker']
    if not isinstance(supplied, dict) or set(supplied) != set(BUNDLE_KEYS) | {'relay_server_name'}:
        raise ValueError('invalid bundle fields')
    if not isinstance(marker, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}\n?', marker):
        raise ValueError('invalid marker')
    if not isinstance(supplied.get('alias'), str) or not re.fullmatch(r'zz-canary-[a-z0-9_-]{1,54}', supplied['alias']):
        raise ValueError('invalid alias')
    if (supplied.get('container_id') != CONTAINER or supplied.get('relay_host') != RELAY_HOST
            or supplied.get('relay_server_name') != 'localhost' or supplied.get('harness') != 'shell'
            or supplied.get('runtime_uid') != 1000 or supplied.get('runtime_gid') != 1000):
        raise ValueError('invalid runtime identity')
    if supplied.get('shell_candidates') not in (['/bin/sh'], [['/bin/sh']]):
        raise ValueError('invalid shell')
    bundle = {**supplied, 'home': str(HOME), 'shell_candidates': ['/bin/sh']}
    validate_bundle(bundle)
    return bundle, marker.encode('utf-8')


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args) -> None:
        pass

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def respond(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self) -> None:
        if self.path != '/status':
            self.respond(404, {'error': 'unknown_operation'})
            return
        with LOCK:
            self.respond(200, status())

    def do_POST(self) -> None:
        global CHILD, STARTED
        if self.path != '/start':
            self.respond(404, {'error': 'unknown_operation'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if (not 1 <= length <= MAX_BODY or self.headers.get('Transfer-Encoding') is not None
                    or self.headers.get_content_type() != 'application/json'):
                raise ValueError('invalid framing')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('truncated request')
            bundle, marker = prepare(json.loads(raw))
        except (OSError, ValueError, TypeError, PermanentError):
            self.respond(400, {'error': 'invalid_request'})
            return
        with LOCK:
            if STARTED:
                self.respond(409, {'error': 'already_started'})
                return
            try:
                for path, content in ((PROOF, marker), (BUNDLE, json.dumps(bundle).encode('utf-8'))):
                    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(descriptor, 'wb') as stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                os.chmod(BUNDLE, 0o400)
                bootstrap = "import runpy,sys; sys.path.insert(0,'/app'); runpy.run_module('cauce_pty_agent',run_name='__main__')"
                CHILD = subprocess.Popen([sys.executable, '-I', '-B', '-c', bootstrap, '--bundle', str(BUNDLE)],
                                         cwd='/app', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(HOME),
                                                          'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'},
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
                STARTED = True
            except OSError:
                self.respond(500, {'error': 'start_failed'})
                return
            self.respond(200, status())


def main() -> None:
    if os.geteuid() != 1000 or os.getegid() != 1000:
        raise SystemExit('manager requires the owned non-root identity')
    os.umask(0o077)
    HOME.mkdir(mode=0o700)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain('/tls/test.crt', '/tls/test.key')
    context.load_verify_locations('/tls/test.crt')
    context.verify_mode = ssl.CERT_REQUIRED
    if not 1024 <= PORT <= 65535:
        raise SystemExit('manager port is invalid')
    server = Server(('0.0.0.0', PORT), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)

    def stop(_number, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        if CHILD is not None and CHILD.poll() is None:
            os.killpg(CHILD.pid, signal.SIGTERM)
            try:
                CHILD.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(CHILD.pid, signal.SIGKILL)
                CHILD.wait(timeout=5)


if __name__ == '__main__':
    main()
