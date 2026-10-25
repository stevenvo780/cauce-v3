from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OWNER = 'e2e-cli-cross-machine-1025'
CONFIG = ROOT / '.delegados/v4/runtime' / f'{OWNER}-cross-machine.json'
IMAGE = 'python:3.13-slim'
SOURCE_IP = '10.88.88.43'
CONTEXTS = {'lab': 'docker-lab', 'lab2': 'docker-lab-2'}


class LabError(Exception):
    pass


def execute(command: list[str], *, timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        detail = (result.stderr.strip() or result.stdout.strip())[:2048]
        raise LabError(f'{command[0]} failed with exit {result.returncode}: {detail}')
    return result


def docker(context: str, *args: str, timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess:
    if context not in CONTEXTS:
        raise LabError('only laboratory Docker contexts are allowed')
    return execute(['docker', '--context', context, *args], timeout=timeout, check=check)


def ssh(context: str, *args: str) -> str:
    if context not in CONTEXTS:
        raise LabError('only laboratory SSH aliases are allowed')
    import shlex
    return execute(['ssh', '-o', 'BatchMode=yes', CONTEXTS[context], shlex.join(args)]).stdout.strip()


def private_json(path: Path, document: dict) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(document, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def daemon_hash(context: str) -> str:
    identifier = docker(context, 'info', '--format', '{{.ID}}').stdout.strip()
    if not identifier:
        raise LabError('laboratory Docker identity is unavailable')
    return hashlib.sha256(identifier.encode()).hexdigest()


def machine_hash(context: str) -> str:
    value = ssh(context, 'sha256sum', '/etc/machine-id').split()[0]
    if len(value) != 64 or any(letter not in '0123456789abcdef' for letter in value):
        raise LabError('laboratory machine hash is invalid')
    return value


def addresses(context: str) -> set[str]:
    return {str(ipaddress.ip_address(value)) for value in ssh(context, 'hostname', '-I').split()}


def source_address(context: str, destination: str) -> str:
    routes = json.loads(ssh(context, 'ip', '-json', 'route', 'get', destination))
    value = routes[0].get('prefsrc') if routes else None
    if not isinstance(value, str) or value not in addresses(context):
        raise LabError('laboratory source route could not be verified')
    return str(ipaddress.ip_address(value))


def unused_port(context: str) -> int:
    script = "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
    value = int(ssh(context, 'python3', '-I', '-B', '-c', script))
    if not 1024 <= value <= 65535:
        raise LabError('laboratory port is invalid')
    return value


def management_address() -> tuple[str, int]:
    routes = json.loads(execute(['ip', '-json', 'route', 'get', SOURCE_IP]).stdout)
    value = routes[0].get('prefsrc') if routes else None
    if not isinstance(value, str) or not ipaddress.ip_address(value).is_private:
        raise LabError('the owned management bridge address is unavailable')
    with socket.socket() as listener:
        listener.bind((value, 0))
        return value, listener.getsockname()[1]


class ManagerConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, certificate: Path, key: Path):
        context = ssl.create_default_context(cafile=str(certificate))
        context.load_cert_chain(str(certificate), str(key))
        super().__init__(host, port, timeout=3, context=context)

    def connect(self) -> None:
        connection = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(connection, server_hostname='localhost')


def manager_status(host: str, port: int, certificate: Path, key: Path) -> dict:
    connection = ManagerConnection(host, port, certificate, key)
    try:
        connection.request('GET', '/status')
        response = connection.getresponse()
        payload = response.read(8193)
        if response.status != 200 or len(payload) > 8192:
            raise LabError('laboratory manager status is unavailable')
        return json.loads(payload)
    finally:
        connection.close()


def stage_code(scratch: Path) -> Path:
    payload = scratch / 'payload'
    package = payload / 'app/cauce_pty_agent'
    package.mkdir(parents=True, mode=0o700)
    source = ROOT / 'ops/pty-agent/cauce_pty_agent'
    files = sorted([*source.rglob('*.py'), source / 'contexto-de-gobierno.json'])
    if not files:
        raise LabError('real PTY package is unavailable')
    for path in files:
        relative = path.relative_to(source)
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != source.parent):
            raise LabError('PTY package must not contain symbolic links')
        target = package / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(path, target)
        target.chmod(0o400)
    shutil.copyfile(Path(__file__).with_name('v4-cli-cross-machine.manager.py'), payload / 'app/manager.py')
    (payload / 'app/manager.py').chmod(0o400)
    return payload


def remove_destination(identifier: str, run: str) -> bool:
    observed = docker('lab2', 'inspect', '--format', '{{json .Config.Labels}}', identifier, check=False)
    if observed.returncode:
        if 'no such' in observed.stderr.lower():
            return True
        raise LabError('destination ownership could not be rechecked')
    labels = json.loads(observed.stdout)
    if labels.get('cauce.e2e.owner') != OWNER or labels.get('cauce.e2e.run') != run:
        raise LabError('destination ownership changed; refusing removal')
    docker('lab2', 'rm', '--force', identifier)
    remaining = docker('lab2', 'ps', '-aq', '--filter', f'id={identifier}').stdout.strip()
    if remaining:
        raise LabError('owned destination survived removal')
    return True


def remove_volume(name: str, run: str) -> None:
    observed = docker('lab2', 'volume', 'inspect', '--format', '{{json .Labels}}', name, check=False)
    if observed.returncode:
        if 'no such' in observed.stderr.lower():
            return
        raise LabError('owned volume could not be rechecked')
    labels = json.loads(observed.stdout)
    if labels.get('cauce.e2e.owner') != OWNER or labels.get('cauce.e2e.run') != run:
        raise LabError('volume ownership changed; refusing removal')
    docker('lab2', 'volume', 'rm', name)
    if docker('lab2', 'volume', 'inspect', name, check=False).returncode == 0:
        raise LabError('owned volume survived removal')


def main() -> int:
    if len(sys.argv) != 1:
        raise LabError('this provisioner takes no arguments')
    if os.geteuid() != 1000 or os.getegid() != 1000:
        raise LabError('run this owned laboratory fixture as uid/gid 1000')
    if CONFIG.exists() or CONFIG.is_symlink():
        raise LabError('an existing cross-machine runtime configuration must not be replaced')
    os.umask(0o077)
    run = uuid.uuid4().hex[:12]
    receipts = ROOT / '.delegados/v4/recibos' / OWNER / 'cross-machine-lab' / run
    receipts.mkdir(parents=True, mode=0o700)
    scratch = Path(tempfile.mkdtemp(prefix=f'zz-canary-{OWNER}-cross-', dir='/datos'))
    destination = f'zz-canary-{OWNER}-destination-{run}'
    identifier = None
    copy_container = None
    volumes = []
    tunnel = None
    config_identity = None
    result = 1
    error = None
    cleanup_error = None
    try:
        for context, expected in CONTEXTS.items():
            endpoint = docker(context, 'context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}').stdout.strip()
            if endpoint != f'ssh://{expected}':
                raise LabError('laboratory context endpoint differs from its allowed SSH alias')
        source_daemon, destination_daemon = daemon_hash('lab'), daemon_hash('lab2')
        source_machine, destination_machine = machine_hash('lab'), machine_hash('lab2')
        if source_daemon == destination_daemon or source_machine == destination_machine:
            raise LabError('the two laboratory destinations are not independent')
        if SOURCE_IP not in addresses('lab'):
            raise LabError('the approved source relay address is unavailable')
        destination_ip = source_address('lab2', SOURCE_IP)
        if source_address('lab', destination_ip) != SOURCE_IP:
            raise LabError('the source relay address does not match the route to the destination')
        source_port, destination_port, manager_port = unused_port('lab'), unused_port('lab2'), unused_port('lab2')
        management_host, management_port = management_address()
        if destination_port == manager_port:
            raise LabError('destination ports must be distinct')
        payload = stage_code(scratch)
        tls = payload / 'tls'
        tls.mkdir(mode=0o700)
        certificate, key = tls / 'test.crt', tls / 'test.key'
        execute(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
                 '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                 '-addext', 'basicConstraints=critical,CA:TRUE',
                 '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
                 '-addext', 'extendedKeyUsage=serverAuth,clientAuth', '-keyout', str(key), '-out', str(certificate)])
        key.chmod(0o600)
        certificate.chmod(0o600)
        for suffix in ('app', 'tls'):
            name = f'{destination}-{suffix}'
            docker('lab2', 'volume', 'create', '--label', f'cauce.e2e.owner={OWNER}', '--label', f'cauce.e2e.run={run}', name)
            volumes.append(name)
        copy_container = docker('lab2', 'create', '--name', f'{destination}-copy',
                                '--label', f'cauce.e2e.owner={OWNER}', '--label', f'cauce.e2e.run={run}',
                                '--user', '1000:1000', '--network', 'none', '--cap-drop', 'ALL',
                                '--security-opt', 'no-new-privileges:true',
                                '--mount', f'type=volume,src={volumes[0]},dst=/app',
                                '--mount', f'type=volume,src={volumes[1]},dst=/tls', IMAGE, '/bin/true').stdout.strip()
        docker('lab2', 'cp', '--archive', f'{payload}/app/.', f'{copy_container}:/app')
        docker('lab2', 'cp', '--archive', f'{tls}/.', f'{copy_container}:/tls')
        remove_destination(copy_container, run)
        copy_container = None
        identifier = docker('lab2', 'create', '--name', destination,
                            '--label', f'cauce.e2e.owner={OWNER}', '--label', f'cauce.e2e.run={run}',
                            '--user', '1000:1000', '--init', '--read-only', '--cap-drop', 'ALL',
                            '--security-opt', 'no-new-privileges:true', '--network', 'host',
                            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
                            '--tmpfs', '/state:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700',
                            '--mount', f'type=volume,src={volumes[0]},dst=/app,readonly',
                            '--mount', f'type=volume,src={volumes[1]},dst=/tls,readonly',
                            '--workdir', '/app', '--env', f'CAUCE_DESTINATION_CONTAINER={destination}',
                            '--env', 'CAUCE_SOURCE_RELAY_HOST=127.0.0.1', '--env', f'CAUCE_MANAGER_PORT={manager_port}',
                            '--env', 'PYTHONDONTWRITEBYTECODE=1',
                            IMAGE, 'python3', '-B', '/app/manager.py', timeout=90).stdout.strip()
        docker('lab2', 'start', identifier)
        tunnel = subprocess.Popen(['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
                                   '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ServerAliveInterval=15',
                                   '-o', 'ServerAliveCountMax=2', '-R', f'127.0.0.1:{destination_port}:{SOURCE_IP}:{source_port}',
                                   '-L', f'{management_host}:{management_port}:127.0.0.1:{manager_port}',
                                   CONTEXTS['lab2']], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 30
        while True:
            try:
                if tunnel.poll() is not None:
                    raise LabError('the owned SSH relay transport did not remain active')
                initial = manager_status(management_host, management_port, certificate, key)
                break
            except (OSError, http.client.HTTPException):
                observed = docker('lab2', 'inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', identifier).stdout.strip()
                if observed.startswith('exited '):
                    detail = docker('lab2', 'logs', identifier, check=False).stderr.strip()[:2048]
                    raise LabError(f'the destination manager exited before accepting requests: {observed}: {detail}') from None
                if time.monotonic() >= deadline:
                    raise LabError('the mTLS destination did not become reachable') from None
                time.sleep(0.2)
        if initial.get('process_alive') is not False or initial.get('home') != '/state/home':
            raise LabError('the destination manager initial state is invalid')
        configuration = {'endpoint': f'https://{management_host}:{management_port}', 'certFile': str(certificate), 'keyFile': str(key),
                         'relayHost': '127.0.0.1', 'sourceRelayPort': source_port, 'destinationRelayPort': destination_port,
                         'sourceDaemonHash': source_daemon, 'destinationDaemonHash': destination_daemon,
                         'sourceMachineHash': source_machine, 'destinationMachineHash': destination_machine,
                         'sourceHost': f'zz-canary-{OWNER}-source-{source_machine[:8]}',
                         'destinationHost': f'zz-canary-{OWNER}-destination-{destination_machine[:8]}',
                         'destinationContainer': destination, 'sourceContext': 'lab', 'destinationContext': 'lab2'}
        CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        private_json(CONFIG, configuration)
        config_info = CONFIG.stat()
        config_identity = (config_info.st_dev, config_info.st_ino)
        private_json(receipts / 'prepared.json', {'owner': OWNER, 'run': run, 'source_context': 'lab', 'destination_context': 'lab2',
                                                'source_machine_hash': source_machine, 'destination_machine_hash': destination_machine,
                                                'source_daemon_hash': source_daemon, 'destination_daemon_hash': destination_daemon,
                                                'destination_container': identifier, 'destination_name': destination,
                                                'manager_mtls_verified': True, 'initial_process_alive': False,
                                                'ssh_transport_pid': tunnel.pid, 'management_transport': 'owned_ssh_local_forward_mtls',
                                                'relay_transport': 'owned_ssh_reverse_forward_mtls'})
        print(f'cross-machine: destino lab2 preparado; recibos cross-machine-lab/{run}', flush=True)
        environment = {**os.environ, 'CAUCE_E2E_CONTEXT': 'lab'}
        with (receipts / 'e2e.log').open('w', encoding='utf-8') as log:
            tested = subprocess.run([str(ROOT / 'scripts/e2e-lab.sh'), OWNER, 'tests/e2e/v4-cli-cross-machine.test.ts', '--reporter=verbose'],
                                    cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=900, check=False)
        result = tested.returncode
        print(f'cross-machine: runner exit {result}; recibos cross-machine-lab/{run}/e2e.log', flush=True)
    except (LabError, OSError, ValueError, subprocess.TimeoutExpired) as problem:
        error = str(problem) if isinstance(problem, LabError) else type(problem).__name__
        print(f'cross-machine: {error}', file=sys.stderr)
    finally:
        removed = identifier is None
        try:
            if identifier:
                removed = remove_destination(identifier, run)
        except (LabError, OSError, subprocess.TimeoutExpired) as problem:
            cleanup_error = str(problem) if isinstance(problem, LabError) else type(problem).__name__
        try:
            if copy_container:
                remove_destination(copy_container, run)
            for name in volumes:
                remove_volume(name, run)
        except (LabError, OSError, subprocess.TimeoutExpired) as problem:
            cleanup_error = str(problem) if isinstance(problem, LabError) else type(problem).__name__
        tunnel_stopped = tunnel is None
        if tunnel is not None:
            if tunnel.poll() is None:
                os.killpg(tunnel.pid, signal.SIGTERM)
                try:
                    tunnel.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(tunnel.pid, signal.SIGKILL)
                    tunnel.wait(timeout=5)
            tunnel_stopped = tunnel.poll() is not None
        if config_identity is not None:
            try:
                observed = CONFIG.lstat()
                if (observed.st_dev, observed.st_ino) == config_identity:
                    CONFIG.unlink()
                else:
                    cleanup_error = 'runtime configuration identity changed; refusing removal'
            except FileNotFoundError:
                pass
        shutil.rmtree(scratch)
        private_json(receipts / 'cleanup.json', {'owner': OWNER, 'run': run, 'destination_container': identifier,
                                               'destination_absent': removed, 'scratch_absent': not scratch.exists(),
                                               'config_absent': not CONFIG.exists(), 'ssh_transport_stopped': tunnel_stopped,
                                               'owned_volumes': volumes, 'copy_container': copy_container,
                                               'runner_exit': result,
                                               'error': error, 'cleanup_error': cleanup_error})
        if cleanup_error:
            print(f'cross-machine: {cleanup_error}', file=sys.stderr)
            result = 1
    return result


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except LabError as problem:
        print(f'cross-machine: {problem}', file=sys.stderr)
        raise SystemExit(1) from None
