from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import sys


def open_directory(directory: pathlib.Path, *, create: bool = False) -> int:
    if not directory.is_absolute() or '..' in directory.parts or str(directory) != str(pathlib.PurePosixPath(str(directory))):
        raise ValueError('invalid credential view directory')
    current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in directory.parts[1:]:
            if create:
                try:
                    os.mkdir(component, mode=0o711, dir_fd=current)
                except FileExistsError:
                    pass
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def install(directory: pathlib.Path, payload: dict, uid: int, gid: int) -> dict:
    if uid <= 0 or gid <= 0 or set(payload) != {'files'} or not isinstance(payload['files'], dict):
        raise ValueError('invalid delegated credential view')
    root = open_directory(directory, create=True)
    try:
        details = os.fstat(root)
        if details.st_uid != os.geteuid() or details.st_mode & 0o022:
            raise ValueError('credential view root has an unsafe owner or mode')
        os.fchmod(root, 0o711)
    finally:
        os.close(root)
    identities = {}
    for name, encoded in payload['files'].items():
        if name not in {'agent.crt', 'agent.key', 'agent.token', 'ca.crt'} and re.fullmatch(
                r'inventory/(?:applied-fleet\.json|desired-fleet\.json|generations/[0-9a-f]{64}/(?:flota\.json|container-aliases\.json|generated/fleet\.json|schemas/alias-manifest\.schema\.json|(?:bootstrap/)?manifests/[a-z][a-z0-9-]{0,63}\.yaml|bootstrap/container-aliases\.json))', name) is None:
            raise ValueError('unexpected delegated credential artifact')
        body = base64.b64decode(encoded, validate=True)
        if len(body) > 1024 * 1024:
            raise ValueError('delegated credential artifact exceeds limit')
        private = name in {'agent.key', 'agent.token'}
        mode, owner = (0o400, uid) if private else (0o444, os.geteuid())
        parent = open_directory((directory / name).parent, create=True)
        temporary = None
        try:
            try:
                descriptor = os.open(pathlib.Path(name).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            except FileNotFoundError:
                temporary = '.' + pathlib.Path(name).name + '.' + os.urandom(12).hex()
                descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                offset = 0
                while offset < len(body):
                    offset += os.write(descriptor, body[offset:])
                os.fchmod(descriptor, mode)
                if owner != os.geteuid():
                    os.fchown(descriptor, owner, gid)
                os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                details = os.fstat(descriptor)
                if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != owner \
                        or stat.S_IMODE(details.st_mode) != mode or details.st_size != len(body) or os.read(descriptor, len(body) + 1) != body:
                    raise ValueError('delegated credential artifact changed')
            finally:
                os.close(descriptor)
            if temporary is not None:
                os.link(temporary, pathlib.Path(name).name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                os.unlink(temporary, dir_fd=parent)
                temporary = None
                os.fsync(parent)
            identities[name] = hashlib.sha256(body).hexdigest()
        finally:
            if temporary is not None:
                os.unlink(temporary, dir_fd=parent)
            os.close(parent)
    return {'digest': hashlib.sha256(json.dumps(identities, sort_keys=True).encode()).hexdigest()}


def payload_for(policy: dict, agent: dict, bootstrap: bool) -> dict:
    from fleet_executor_pki import checked_file, pair_proof
    from fleet_executor_policy import SafeFailure
    from fleet_runtime_materialization import load_desired_fleet
    key, kind = agent['runtime_key'], 'bootstrap' if bootstrap else 'normal'
    pair = pathlib.Path(policy['roots']['pki']) / kind / key
    signer = policy.get('signer')
    if not isinstance(signer, dict):
        raise SafeFailure('runtime has no approved Cauce credential signer')
    pair_proof(pair, key, pathlib.Path(signer['certificate']))
    source = {'agent.crt': pair / ('agent-' + key + '.crt'), 'agent.key': pair / ('agent-' + key + '.key'),
              'agent.token': pathlib.Path(policy['roots']['tokens']) / kind / (key + '.token'),
              'ca.crt': pathlib.Path(policy.get('transport', {}).get('ca_certificate', signer['certificate']))}
    files = {name: base64.b64encode(checked_file(filename, name in {'agent.key', 'agent.token'})).decode('ascii')
             for name, filename in source.items()}
    state = pathlib.Path(policy['roots']['state'])
    receipt = load_desired_fleet(state)
    files['inventory/desired-fleet.json'] = base64.b64encode(json.dumps(receipt).encode()).decode('ascii')
    if not bootstrap:
        files['inventory/applied-fleet.json'] = files['inventory/desired-fleet.json']
    for filename in receipt['files']:
        target = 'inventory/generations/' + receipt['generation'] + '/' + filename
        files[target] = base64.b64encode(checked_file(state / 'generations' / receipt['generation'] / filename)).decode('ascii')
    return {'files': files}


def environment(directory: pathlib.Path, policy: dict, bootstrap: bool) -> dict:
    values = {'CAUCE_CERT_PATH': str(directory / 'agent.crt'), 'CAUCE_KEY_PATH': str(directory / 'agent.key'),
              'CAUCE_TOKEN_PATH': str(directory / 'agent.token'), 'CAUCE_CA_PATH': str(directory / 'ca.crt'),
              'CAUCE_FLEET_RUNTIME_STATE': str(directory / 'inventory')}
    if 'transport' in policy:
        values.update(CAUCE_BOOTSTRAP_URL=policy['transport']['bootstrap_url'], CAUCE_GATEWAY_URL=policy['transport']['gateway_url'])
    return values


def remove(directory: pathlib.Path):
    parent = open_directory(directory.parent)
    try:
        try:
            descriptor = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            if os.fstat(descriptor).st_uid != os.geteuid() or not shutil.rmtree.avoids_symlink_attacks:
                raise ValueError('unsafe delegated credential removal')
            shutil.rmtree(directory.name, dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--root', type=pathlib.Path, required=True)
        parser.add_argument('--uid', type=int)
        parser.add_argument('--gid', type=int)
        parser.add_argument('--remove', action='store_true')
        args = parser.parse_args()
        if args.remove:
            remove(args.root)
        else:
            raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError('delegated credential payload exceeds limit')
            print(json.dumps(install(args.root, json.loads(raw), args.uid, args.gid)))
    except Exception:
        print('delegated Cauce credential effect was not verified', file=sys.stderr)
        raise SystemExit(2) from None
