from __future__ import annotations

import argparse
import ipaddress
import json
import os
import pathlib
import re
import runpy
import select
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

PATH = re.compile(r'(?:context|directives)/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)\Z')
IDENTITY = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')
SENSITIVE = re.compile(r'(?:auth|credential|secret|token|session|key|password)', re.I)


class ContextFailure(ValueError):
    pass


class ContextArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        self.print_usage(sys.stderr)
        self.exit(2, 'Argumentos inválidos; usa --help para consultar la operación de contexto o terminal.\n')


def console_failure_message(error: ContextFailure) -> str:
    message = str(error)
    status = re.fullmatch(r'(?:console|context) request rejected with HTTP (\d{3})(?:; redirects are disabled)?', message)
    if status:
        code = int(status[1])
        if code == 401:
            return 'La sesión o las credenciales fueron rechazadas (HTTP 401); vuelve a iniciar sesión con cauce login.'
        if code == 403:
            return 'La consola rechazó el acceso (HTTP 403); revisa los permisos y la empresa activa en la consola.'
        if code == 409:
            return 'Hay un conflicto de versión o estado (HTTP 409); vuelve a consultar antes de reintentar el cambio.'
        if 300 <= code < 400:
            return f'El gateway respondió con una redirección (HTTP {code}); comprueba --gateway. No se envió la sesión a otro destino.'
        return f'La consola rechazó la solicitud (HTTP {code}); revisa el estado en la consola antes de reintentar.'
    return {
        'console gateway is unavailable': 'No se pudo conectar con la consola; comprueba --gateway, la red y los certificados.',
        'context gateway is unavailable': 'No se pudo conectar con la consola; comprueba --gateway, la red y los certificados.',
        'context target is unavailable': 'El destino del contexto no es válido; comprueba --tenant y --alias.',
        'context path is unavailable': 'La ruta del contexto no está permitida; usa archivos de context/ o directives/ sin datos sensibles.',
        'context file exceeds its safe boundary': 'El archivo supera el límite permitido o no es un archivo regular.',
        'context file changed during its read': 'El archivo cambió durante la lectura; vuelve a intentar la operación.',
        'context export root must be a real directory': 'El destino de exportación debe ser un directorio real y vacío.',
        'console response exceeds limit': 'La respuesta de la consola supera el límite permitido.',
        'console request path must stay on its gateway': 'La solicitud debe permanecer en el gateway elegido.',
        'gateway and origin must use HTTPS or loopback HTTP without credentials or paths':
            'Indica --gateway y --origin con HTTPS, sin credenciales ni rutas; HTTP solo se admite en localhost.',
        'console session file must be private and owned by this user':
            'La sesión debe ser un archivo privado de tu usuario; revisa sus permisos o inicia sesión con cauce login.',
        'console session file is unavailable': 'La sesión guardada no es válida; vuelve a iniciar sesión con cauce login.',
        'console session is bound to a different gateway or origin; log in again':
            'La sesión pertenece a otro gateway u origen; inicia sesión con cauce login para el destino elegido.',
        'console session requires a valid csrf_token for mutations':
            'La sesión no permite cambios; vuelve a iniciar sesión con cauce login.',
        'console session file requires a valid csrf_token for mutations':
            'La sesión no permite cambios; vuelve a iniciar sesión con cauce login.',
    }.get(message, message)


def valid_path(value: str) -> str:
    if not PATH.fullmatch(value) or any(SENSITIVE.search(part) for part in value.split('/')):
        raise ContextFailure('context path is unavailable')
    return value


def read_scoped(root: pathlib.Path, relative: str, limit: int = 262144) -> bytes:
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.absolute().parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        for part in pathlib.PurePosixPath(relative).parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        file_fd = os.open(pathlib.PurePosixPath(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
                raise ContextFailure('context file exceeds its safe boundary')
            with os.fdopen(file_fd, 'rb', closefd=False) as stream:
                content = stream.read(limit + 1)
            after = os.fstat(file_fd)
            if len(content) > limit or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ContextFailure('context file changed during its read')
            return content
        finally:
            os.close(file_fd)
    finally:
        os.close(descriptor)


def private_session(location: str) -> dict:
    path = pathlib.Path(location).absolute()
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise ContextFailure('No hay una sesión de consola guardada; ejecuta cauce login --gateway <URL> en una terminal privada.') from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ContextFailure('console session file must be private and owned by this user')
    raw = json.loads(read_scoped(path.parent, path.name, 16384))
    cookie = raw.get('cookie') if isinstance(raw, dict) else None
    if not isinstance(cookie, str) or not cookie or len(cookie) > 12000 or any(ord(char) < 32 for char in cookie):
        raise ContextFailure('console session file is unavailable')
    if not raw.get('gateway') or not raw.get('origin'):
        raise ContextFailure('vuelve a iniciar sesión con cauce login')
    return raw


def private_cookie(location: str) -> str:
    return private_session(location)['cookie']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, stream, code, message, headers, new_url):
        return None


def loopback_host(host: str | None) -> bool:
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def trusted_origin(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment \
                or parsed.path not in ('', '/') or any(ord(char) < 33 or ord(char) == 127 for char in value) \
                or parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback_host(parsed.hostname)):
            raise ValueError()
        host = parsed.hostname.lower()
        if ':' in host:
            host = '[' + host + ']'
        default_port = 443 if parsed.scheme == 'https' else 80
        return parsed.scheme + '://' + host + (':' + str(port) if port is not None and port != default_port else '')
    except (ValueError, AttributeError, TypeError):
        raise ContextFailure('gateway and origin must use HTTPS or loopback HTTP without credentials or paths') from None


def request_json(gateway: str, origin: str, ca_file: str | None, method: str, path: str, body=None, headers=None,
                 timeout: int = 30, rejected: str = 'console request rejected', unavailable: str = 'console gateway is unavailable',
                 accepted_error_statuses: tuple[int, ...] = ()):
    gateway = trusted_origin(gateway)
    parsed = urllib.parse.urlsplit(path)
    if not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc or parsed.fragment \
            or '\\' in path or any(ord(char) < 32 or ord(char) == 127 for char in path):
        raise ContextFailure('console request path must stay on its gateway')
    payload = None if body is None else json.dumps(body, separators=(',', ':')).encode()
    request = urllib.request.Request(gateway + path, method=method, data=payload,
        headers={'Origin': origin, 'Accept': 'application/json', 'Content-Type': 'application/json', **(headers or {})})
    proxies = {} if loopback_host(urllib.parse.urlsplit(gateway).hostname) else {
        scheme: proxy for scheme, proxy in urllib.request.getproxies().items() if scheme == 'https'
    }
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(2097153)
            if len(raw) > 2097152:
                raise ContextFailure('console response exceeds limit')
            result = json.loads(raw) if raw else None
            return result, response.headers.get_all('Set-Cookie', [])
    except urllib.error.HTTPError as error:
        code = error.code
        try:
            if code in accepted_error_statuses:
                raw = error.read(2097153)
                if len(raw) > 2097152:
                    raise ContextFailure('console response exceeds limit')
                return json.loads(raw) if raw else None, []
        finally:
            error.close()
        raise ContextFailure(rejected + ' with HTTP ' + str(code) + '; redirects are disabled') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ContextFailure(unavailable) from None


class ConsoleSessionClient:
    def __init__(self, session_file: str, gateway: str | None = None, origin: str | None = None, ca_file: str | None = None):
        self.session = private_session(session_file)
        stored_gateway = trusted_origin(self.session.get('gateway'))
        stored_origin = trusted_origin(self.session.get('origin'))
        self.gateway = trusted_origin(gateway) if gateway is not None else stored_gateway
        self.origin = trusted_origin(origin) if origin is not None else stored_origin
        if self.gateway != stored_gateway or self.origin != stored_origin:
            raise ContextFailure('console session is bound to a different gateway or origin; log in again')
        self.cookie = self.session['cookie']
        self.csrf = self.session.get('csrf_token')
        self.ca_file = ca_file

    def request(self, method: str, path: str, body=None):
        method = method.upper()
        headers = {'Cookie': self.cookie}
        if method not in ('GET', 'HEAD'):
            if not isinstance(self.csrf, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', self.csrf):
                raise ContextFailure('console session requires a valid csrf_token for mutations')
            headers['X-CSRF-Token'] = self.csrf
        return request_json(self.gateway, self.origin, self.ca_file, method, path, body, headers)[0]


class ContextClient:
    def __init__(self, gateway: str, origin: str, session_file: str, ca_file: str | None = None):
        session = ConsoleSessionClient(session_file, gateway, origin, ca_file)
        self.gateway = session.gateway
        self.origin = session.origin
        self.cookie = session.cookie
        self.csrf = session.csrf
        self.ca_file = ca_file
        self.tls = ssl.create_default_context(cafile=ca_file)

    def request(self, method: str, tenant: str, alias: str, suffix: str = '', body=None):
        if not IDENTITY.fullmatch(tenant) or not IDENTITY.fullmatch(alias):
            raise ContextFailure('context target is unavailable')
        base = '/v3/console/context/agents/' + urllib.parse.quote(tenant, safe='') + '/' + urllib.parse.quote(alias, safe='')
        headers = {'Cookie': self.cookie}
        if method not in ('GET', 'HEAD'):
            if not isinstance(self.csrf, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', self.csrf):
                raise ContextFailure('console session file requires a valid csrf_token for mutations')
            headers['X-CSRF-Token'] = self.csrf
        try:
            return request_json(self.gateway, self.origin, self.ca_file, method, base + suffix, body, headers, timeout=65,
                                rejected='context request rejected', unavailable='context gateway is unavailable')[0]
        except ContextFailure as error:
            message = str(error)
            marker = '; redirects are disabled'
            if message.endswith(marker) and message.startswith('context request rejected'):
                raise ContextFailure(message[:-len(marker)]) from None
            raise


def arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--gateway', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--session-file', required=True)
    parser.add_argument('--ca-file')
    parser.add_argument('--tenant', required=True)
    parser.add_argument('--alias', required=True)


def export_context(snapshot: dict, directory: str) -> dict:
    root = pathlib.Path(directory).absolute()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    if root.resolve() != root:
        raise ContextFailure('context export root must be a real directory')
    for file in snapshot['files']:
        relative = valid_path(file['path'])
        path = root / relative
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(file['content'])
    metadata = {key: snapshot[key] for key in ('company_id', 'tenant_id', 'alias', 'version', 'digest')}
    descriptor = os.open(root / 'context-manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(metadata, stream)
    return {'state': 'exported', 'directory': str(root), **metadata}


def main() -> int:
    parser = ContextArgumentParser(description='Contextos versionados con sesión humana de la consola')
    arguments(parser)
    commands = parser.add_subparsers(dest='operation', required=True)
    for name in ('read', 'status', 'history', 'retry', 'apply'):
        command = commands.add_parser(name)
        if name == 'history':
            command.add_argument('--before', type=int)
    edit = commands.add_parser('edit')
    edit.add_argument('--expected-version', type=int, required=True)
    edit.add_argument('--input', required=True)
    restore = commands.add_parser('restore')
    restore.add_argument('--expected-version', type=int, required=True)
    restore.add_argument('--version', type=int, required=True)
    diff = commands.add_parser('diff')
    diff.add_argument('--from-version', type=int, required=True)
    diff.add_argument('--to-version', type=int, required=True)
    export = commands.add_parser('export')
    export.add_argument('--directory', required=True)
    args = parser.parse_args()
    try:
        client = ContextClient(args.gateway, args.origin, args.session_file, args.ca_file)
        body = None
        method = 'GET'
        suffix = '' if args.operation in ('read', 'export', 'edit') else '/' + args.operation
        if args.operation == 'edit':
            path = pathlib.Path(args.input).absolute()
            files = json.loads(read_scoped(path.parent, path.name, 1048576))
            body = {'expected_version': args.expected_version, 'source': 'cli', 'files': files}
            method = 'PUT'
        if args.operation in ('retry', 'apply', 'restore'):
            method = 'POST'
            body = {'expected_version': args.expected_version, 'version': args.version} if args.operation == 'restore' else {}
            if args.operation == 'retry':
                suffix = '/sync/retry'
        if args.operation == 'history' and args.before is not None:
            suffix += '?before=' + str(args.before)
        if args.operation == 'diff':
            suffix += '?from=' + str(args.from_version) + '&to=' + str(args.to_version)
        result = client.request(method, args.tenant, args.alias, suffix, body)
        if args.operation == 'export':
            result = export_context(result, args.directory)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ContextFailure as error:
        print(console_failure_message(error), file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print('La operación de contexto no pudo completarse; revisa sesión, destino, CAS y rutas permitidas.', file=sys.stderr)
        return 1


TERMINAL_WIRE = r'''
import { closeSync, createReadStream, existsSync, readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(readFileSync(Number(process.argv[1]), 'utf8'));
let WebSocket, limits;
for (const manifest of config.roots.flatMap((root) => [
  join(root, 'services/terminal-relay/package.json'), join(root, 'package.json'),
])) {
  try { WebSocket = createRequire(manifest)('ws'); break; } catch {}
}
for (const root of config.roots) {
  const source = join(root, 'services/terminal-relay/src/session-limits.ts');
  try {
    if (existsSync(source)) {
      const { tsImport } = createRequire(join(root, 'package.json'))('tsx/esm/api');
      limits = await tsImport(source, import.meta.url); break;
    }
  } catch {}
  for (const compiled of ['services/terminal-relay/dist/session-limits.js', 'dist/services/terminal-relay/src/session-limits.js']) {
    try { limits = await import(pathToFileURL(join(root, compiled))); break; } catch {}
  }
  if (limits) break;
}
if (!WebSocket || !limits) {
  process.stderr.write('Falta el runtime Cauce compilado; configura CAUCE_PROJECT_ROOT o instala el runtime.\n');
  process.exit(1);
}
const socket = new WebSocket(config.url, {
  origin: config.origin, headers: { Cookie: config.cookie },
  ...(config.ca_file ? { ca: readFileSync(config.ca_file) } : {}),
  rejectUnauthorized: true, handshakeTimeout: 15000, closeTimeout: 2000, followRedirects: false, maxPayload: 1048576,
});
let ready = false, detached = false, exitCode = 0, heartbeat;
const wasRaw = process.stdin.isRaw ?? false;
const send = (value) => {
  const encoded = JSON.stringify(value);
  if (value.type !== 'attach' && !limits.parseClientMessage(Buffer.from(encoded), false)) {
    fail('Entrada de terminal fuera del contrato del relay.'); return;
  }
  if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
};
const restore = () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
  process.stdin.pause();
};
const close = () => { detached = true; socket.close(1000); };
const fail = (message) => { process.stderr.write(message + '\n'); exitCode = 1; socket.terminate(); };
const timer = setTimeout(() => fail('El relay no confirmó la conexión al terminal.'), 20000);
socket.on('open', () => send({ type: 'attach', ...config.attach }));
socket.on('message', (data, binary) => {
  if (binary) {
    if (!process.stdout.write(data)) socket.pause();
    return;
  }
  let frame;
  try { frame = JSON.parse(data.toString()); } catch { fail('Control de terminal inválido.'); return; }
  if (frame.type === 'ready') {
    if (ready || frame.session_id !== config.attach.session_id || frame.mode !== config.mode) {
      fail('El relay devolvió una sesión distinta.'); return;
    }
    ready = true;
    writeSync(Number(process.argv[2]), 'ready');
    closeSync(Number(process.argv[2]));
    const authorization = createReadStream('', { fd: Number(process.argv[3]), autoClose: true });
    let authorized = false;
    authorization.on('end', () => { if (!authorized) fail('No se acreditó el control del terminal.'); });
    authorization.once('data', (value) => {
      if (value.toString() !== '1') { fail('No se acreditó el control del terminal.'); return; }
      authorized = true;
      clearTimeout(timer);
      if (config.mode === 'harness') heartbeat = setInterval(() => send({ type: 'ping' }), 30000);
      process.stderr.write('Terminal conectado; salir sin cerrar el agente: Ctrl-].\n');
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        const detachAt = chunk.indexOf('\x1d');
        const input = detachAt < 0 ? chunk : chunk.slice(0, detachAt);
        if (config.mode !== 'shell' && limits.isTerminalEmulatorResponse(input)) {
          send({ type: 'terminal_response', data: input });
        } else if (config.mode !== 'harness') {
          let batch = '';
          for (const character of input) {
            if (Buffer.byteLength(batch + character) > limits.MAX_INPUT_MESSAGE_BYTES) { send({ type: 'input', data: batch }); batch = ''; }
            batch += character;
          }
          if (batch) send({ type: 'input', data: batch });
        }
        if (detachAt >= 0) close();
      });
      process.stdin.on('end', () => {
        if (config.mode === 'shell') send({ type: 'input', data: '\x04' });
        else close();
      });
      process.stdin.resume();
    });
    return;
  }
  if (frame.type === 'input_refused') fail('El servidor rechazó la entrada; revisa el control y los permisos del agente.');
  if (frame.type === 'closed' && Number.isInteger(frame.exit_code)) exitCode = frame.exit_code === 0 ? 0 : 1;
});
process.stdout.on('drain', () => socket.resume());
process.stdout.on('resize', () => send({ type: 'resize',
  cols: Math.max(20, Math.min(500, process.stdout.columns || 100)),
  rows: Math.max(5, Math.min(200, process.stdout.rows || 30)),
}));
process.stdout.on('error', () => { exitCode = 1; close(); });
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, close);
socket.on('error', () => fail('No se pudo abrir el WebSocket; revisa el gateway, TLS y la sesión.'));
socket.on('close', (code) => {
  clearTimeout(timer);
  clearInterval(heartbeat);
  restore();
  if (!detached && code !== 1000) {
    process.stderr.write('Terminal cerrado por el servidor (código ' + code + ').\n');
    exitCode = 1;
  }
  process.exitCode = exitCode;
});
process.on('exit', restore);
'''


def terminal_target(snapshot: object, alias: str, tenant: str | None, mode: str | None) -> tuple[dict, str]:
    if '/' in alias:
        qualified_tenant, alias = alias.split('/', 1)
        if tenant is not None and tenant != qualified_tenant:
            raise ContextFailure('El tenant no coincide con el alias elegido.')
        tenant = qualified_tenant
    if not IDENTITY.fullmatch(alias) or tenant is not None and not IDENTITY.fullmatch(tenant):
        raise ContextFailure('Indica un alias válido y, si se repite, --tenant o tenant/alias.')
    items = snapshot.get('items') if isinstance(snapshot, dict) else None
    if not isinstance(items, list):
        raise ContextFailure('El gateway no publica el inventario de terminales.')
    matches = [item for item in items if isinstance(item, dict) and item.get('alias') == alias
               and (tenant is None or item.get('tenant_id') == tenant)]
    if len(matches) != 1:
        raise ContextFailure('Destino inexistente, no autorizado o ambiguo; comprueba --tenant y los permisos.')
    target = matches[0]
    if target.get('authorized') is not True:
        raise ContextFailure('El servidor no autoriza esta terminal; revisa tus permisos y la empresa activa en la consola.')
    if target.get('pty_state') != 'online':
        raise ContextFailure('La terminal del agente no está conectada; revisa su estado y la autenticación del proveedor en la consola.')
    if not isinstance(target.get('tenant_id'), str) or not IDENTITY.fullmatch(target['tenant_id']):
        raise ContextFailure('La identidad del destino es inválida.')
    modes = target.get('modes')
    writable = target.get('writable_modes')
    if not isinstance(modes, list) or not isinstance(writable, list):
        raise ContextFailure('El gateway no acredita los modos de terminal disponibles.')
    selected = mode or next((item for item in ('harness_rw', 'shell', 'harness') if item in modes), None)
    if selected not in modes or selected not in ('shell', 'harness', 'harness_rw') \
            or selected != 'harness' and selected not in writable:
        raise ContextFailure('El servidor no autoriza el modo de terminal solicitado.')
    return target, selected


def terminal_websocket(gateway: str, path: object) -> str:
    if not isinstance(path, str) or not re.fullmatch(r'/v3/(?:console/terminal|ws/terminal)(?:/[A-Za-z0-9_-]+)*', path):
        raise ContextFailure('El endpoint WebSocket debe permanecer en las rutas de terminal del gateway, sin query.')
    return ('wss' if gateway.startswith('https:') else 'ws') + gateway[gateway.index(':'):] + path


def terminal_transport(client: ConsoleSessionClient, grant: dict, mode: str, cols: int, rows: int) -> int:
    roots = [os.environ.get('CAUCE_PROJECT_ROOT'), str(pathlib.Path(__file__).resolve().parents[2]),
             str(pathlib.Path.home() / '.local/share/cauce-v3')]
    config = {'url': terminal_websocket(client.gateway, grant.get('websocket_path')),
              'origin': client.origin, 'cookie': client.cookie, 'ca_file': client.ca_file, 'mode': mode,
              'roots': [str(pathlib.Path(root).absolute()) for root in roots if root],
              'attach': {key: grant[key] for key in ('session_id', 'ticket', 'authority_proof')}}
    config['attach'].update(cols=cols, rows=rows)
    reader, writer = os.pipe()
    ready_reader, ready_writer = os.pipe()
    start_reader, start_writer = os.pipe()
    descriptors = {reader, writer, ready_reader, ready_writer, start_reader, start_writer}
    process = None
    previous_signals = {}
    try:
        process = subprocess.Popen(['node', '--input-type=module', '--eval', TERMINAL_WIRE,
                                    str(reader), str(ready_writer), str(start_reader)],
                                   pass_fds=(reader, ready_writer, start_reader))
        for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            previous_signals[number] = signal.signal(number, lambda number, _frame: process.send_signal(number))
        for descriptor in (reader, ready_writer, start_reader):
            os.close(descriptor)
            descriptors.remove(descriptor)
        with os.fdopen(writer, 'w') as stream:
            descriptors.remove(writer)
            json.dump(config, stream)
        if not select.select([ready_reader], [], [], 25)[0] or os.read(ready_reader, 16) != b'ready':
            raise ContextFailure('El relay no acreditó la conexión del terminal.')
        if mode == 'harness_rw':
            owner = {key: grant[key] for key in ('request_id', 'owner_generation', 'owner_token', 'authority_proof')}
            receipt = client.request('POST', '/v3/console/terminal/sessions/' + grant['session_id'] + '/control',
                                     {'action': 'take', **owner})
            if not isinstance(receipt, dict) or receipt.get('session_id') != grant['session_id'] \
                    or not isinstance(receipt.get('hold_id'), str) or not receipt['hold_id']:
                raise ContextFailure('El gateway no acreditó el control de la TUI.')
        os.write(start_writer, b'1')
        os.close(start_writer)
        descriptors.remove(start_writer)
        return process.wait()
    finally:
        for descriptor in descriptors:
            os.close(descriptor)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for number, handler in previous_signals.items():
            signal.signal(number, handler)


def terminal_main() -> int:
    parser = ContextArgumentParser(prog='cauce <alias>', allow_abbrev=False,
                                    description='Terminal remoto con la sesión nominal de cauce login')
    parser.add_argument('alias')
    parser.add_argument('action', nargs='?', choices=('ver',), help='ver la TUI sin tomar el control')
    parser.add_argument('--tenant')
    parser.add_argument('--gateway', default=os.environ.get('CAUCE_GATEWAY_URL'))
    parser.add_argument('--origin')
    parser.add_argument('--session-file')
    parser.add_argument('--ca-file')
    parser.add_argument('--mode', choices=('shell', 'harness', 'harness_rw'))
    args = parser.parse_args(sys.argv[2:])
    try:
        if args.action == 'ver' and args.mode not in (None, 'harness'):
            raise ContextFailure('Para ver sin tomar el control usa --mode harness o elimina --mode.')
        module = runpy.run_path(str(pathlib.Path(__file__).resolve().with_name('cauce-login')),
                                run_name='cauce_console_session')
        client = ConsoleSessionClient(args.session_file or module['default_session_file'](),
                                      args.gateway, args.origin, args.ca_file)
        target, mode = terminal_target(client.request('GET', '/v3/console/terminal/targets'),
                                       args.alias, args.tenant, 'harness' if args.action == 'ver' else args.mode)
        if shutil.which('node') is None:
            raise ContextFailure('Instala Node.js y el runtime Cauce para abrir el terminal.')
        size = shutil.get_terminal_size((100, 30))
        cols, rows = max(20, min(500, size.columns)), max(5, min(200, size.lines))
        request = {key: target[key] for key in ('tenant_id', 'alias')}
        request.update(mode=mode, cols=cols, rows=rows, request_id=str(uuid.uuid4()), owner_token=str(uuid.uuid4()))
        grant = client.request('POST', '/v3/console/terminal/sessions', request)
        if not isinstance(grant, dict) or not isinstance(grant.get('session_id'), str) \
                or not re.fullmatch(r'[0-9a-f-]{36}', grant['session_id']) \
                or grant.get('request_id') != request['request_id'] \
                or not isinstance(grant.get('owner_generation'), str) or not grant['owner_generation'].isdigit():
            raise ContextFailure('El gateway no acreditó la sesión solicitada.')
        grant['owner_token'] = request['owner_token']
        owner = {key: grant[key] for key in ('request_id', 'owner_generation', 'owner_token')}
        try:
            if not isinstance(grant.get('ticket'), str) or not grant['ticket'] \
                    or not isinstance(grant.get('authority_proof'), str) or not grant['authority_proof'].startswith('ac2.') \
                    or not isinstance(grant.get('target'), dict) \
                    or any(grant['target'].get(key) != request[key] for key in ('tenant_id', 'alias', 'mode')):
                raise ContextFailure('El gateway devolvió otro destino o una autorización inválida.')
            terminal_websocket(client.gateway, grant.get('websocket_path'))
            return terminal_transport(client, grant, mode, cols, rows)
        finally:
            client.request('DELETE', '/v3/console/terminal/sessions/' + grant['session_id'], owner)
    except ContextFailure as error:
        print(console_failure_message(error), file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError):
        print('No se pudo abrir el terminal; inicia sesión con cauce login y revisa destino y permisos.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(terminal_main() if sys.argv[1:2] == ['--terminal'] else main())
