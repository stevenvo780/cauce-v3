from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import platform
import re
import subprocess
import sys
import uuid

from host_channel_client import (
    HostChannel,
    HostFailure,
    ensure_key,
    gateway_url,
    post_json,
    private_directory,
    private_file,
    save_private,
    sign,
    stable_json,
)


def invitation_from_stdin() -> dict:
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise HostFailure('invitation exceeds its limit')
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError()
        uuid.UUID(value['enrollment_id'])
        for key in ('company_id', 'host_id'):
            if not isinstance(value[key], str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value[key]) is None:
                raise ValueError()
        for key in ('nonce', 'invitation_token'):
            if not isinstance(value[key], str) or re.fullmatch(r'[a-f0-9]{64}', value[key]) is None:
                raise ValueError()
        if value['state'] != 'pending':
            raise ValueError()
        anchor = value.get('setup_signer_fingerprint')
        if anchor is not None and (not isinstance(anchor, str) or re.fullmatch(r'[a-f0-9]{64}', anchor) is None):
            raise ValueError()
        return value
    except (ValueError, KeyError, TypeError):
        raise HostFailure('paste the complete pending invitation JSON from the console') from None


def enroll(gateway: str, invitation: dict, state_root: pathlib.Path) -> dict:
    gateway = gateway_url(gateway)
    directory = private_directory(state_root / invitation['company_id'] / invitation['host_id'])
    identity_file = directory / 'identity.json'
    fingerprint = hashlib.sha256(ensure_key(directory)).hexdigest()
    pending = {key: invitation[key] for key in ('enrollment_id', 'company_id', 'host_id')}
    pending.update(gateway=gateway, state='pending', key_fingerprint=fingerprint)
    if identity_file.exists() or identity_file.is_symlink():
        previous = json.loads(private_file(identity_file))
        if any(previous.get(key) != pending[key] for key in ('gateway', 'enrollment_id', 'company_id', 'host_id', 'key_fingerprint')):
            raise HostFailure('local host identity belongs to another enrollment; it was retained')
        if previous.get('state') == 'enrolled':
            return {key: previous[key] for key in ('company_id', 'host_id', 'state', 'key_fingerprint', 'executor_ready')}
    if invitation.get('setup_signer_fingerprint') is not None:
        from host_setup import anchor_signer
        anchor_signer(directory, invitation['setup_signer_fingerprint'])
    save_private(identity_file, pending)
    message = {key: invitation[key] for key in ('enrollment_id', 'company_id', 'host_id', 'nonce')}
    message['version'] = 1
    request = {'invitation_token': invitation['invitation_token'],
        'public_key': base64.b64encode(ensure_key(directory)).decode(), 'proof': sign(directory, stable_json(message))}
    receipt = post_json(gateway, '/v3/fleet/hosts/enrollments/' + invitation['enrollment_id'] + '/claim', request)
    if any(receipt.get(key) != pending[key] for key in ('enrollment_id', 'company_id', 'host_id', 'key_fingerprint')) \
            or receipt.get('state') != 'enrolled' or not isinstance(receipt.get('executor_ready'), bool):
        raise HostFailure('enrollment response does not match this local identity; retry is safe')
    save_private(identity_file, {**pending, **receipt, 'gateway': gateway})
    return receipt


def heartbeat(directory: pathlib.Path) -> dict:
    channel = HostChannel(directory)
    docker_version = None
    try:
        result = subprocess.run(['docker', 'version', '--format', '{{.Server.Version}}'],
            capture_output=True, timeout=10, check=False)
        if result.returncode == 0:
            candidate = result.stdout.decode().strip()
            if re.fullmatch(r'[A-Za-z0-9_.+-]{1,128}', candidate):
                docker_version = candidate
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return channel.request('POST', '/v3/fleet/hosts/' + channel.identity['host_id'] + '/heartbeat',
        {'cli_version': '4.0.0', 'platform': platform.system() + '/' + platform.machine(),
            'docker_version': docker_version, 'status': 'reachable'})


def main() -> int:
    parser = argparse.ArgumentParser(description='Enroll this computer using a fresh local identity')
    commands = parser.add_subparsers(dest='action', required=True)
    enroll_parser = commands.add_parser('enroll')
    enroll_parser.add_argument('--gateway', required=True)
    enroll_parser.add_argument('--invitation-stdin', action='store_true', required=True)
    enroll_parser.add_argument('--state-root', type=pathlib.Path,
        default=pathlib.Path.home() / '.local/state/cauce-v3/hosts')
    heartbeat_parser = commands.add_parser('heartbeat')
    heartbeat_parser.add_argument('--identity-directory', type=pathlib.Path, required=True)
    for name, help_text in (('setup', 'Install and start the fleet executor as a systemd user service'),
                            ('status', 'Report whether the local executor is ready')):
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument('--identity-directory', type=pathlib.Path)
        sub.add_argument('--state-root', type=pathlib.Path, default=pathlib.Path.home() / '.local/state/cauce-v3/hosts')
        sub.add_argument('--install-root', type=pathlib.Path, default=pathlib.Path.home() / '.local/share/cauce-v3/hosts')
        if name == 'setup':
            sub.add_argument('--dry-run', action='store_true')
            sub.add_argument('--signer-fingerprint', help='setup signer fingerprint shown in the console, for identities enrolled without one')
    args = parser.parse_args()
    try:
        if args.action in ('setup', 'status'):
            import host_setup
            identity = host_setup.locate_identity(args.state_root, args.identity_directory)
            receipt = host_setup.setup(identity, args.install_root, args.dry_run, args.signer_fingerprint) if args.action == 'setup' \
                else host_setup.status(identity, args.install_root)
            print(json.dumps(receipt, sort_keys=True))
            return 0 if args.action == 'setup' or receipt['executor_ready'] else 3
        receipt = enroll(args.gateway, invitation_from_stdin(), args.state_root) if args.action == 'enroll' else heartbeat(args.identity_directory)
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except HostFailure as error:
        if args.action in ('setup', 'status'):
            print('cauce: ' + str(error), file=sys.stderr)
            return 1
        print('cauce: no se pudo verificar el enrolamiento o canal; identidad local conservada. Revisa la invitación, permisos, conexión y estado en la consola.', file=sys.stderr)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError):
        print('cauce: no se pudo verificar el enrolamiento o canal; identidad local conservada. Revisa la invitación, permisos, conexión y estado en la consola.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
