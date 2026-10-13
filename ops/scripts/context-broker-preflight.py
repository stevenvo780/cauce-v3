#!/usr/bin/env python3
"""Read-only preflight of the context broker repository.

Checks what the broker needs before seeding real agents or rehearsing a sync failure: the repository owner and
private modes, Git metadata that nobody else can write, core.sshCommand selecting the private deploy key, local
main equal to the remote main and a push dry run that succeeds. Git runs with the same environment as the broker
(inherited GIT_* removed, hooks disabled, no system config). Nothing is written and no key content is printed.
Inside the gateway container: docker exec -i <gateway> python3 - --repository /var/lib/cauce-v3/contexts < this file.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import stat
import subprocess
import sys

MAIN = 'refs/heads/main'


def git(repository: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}
    environment.update(LC_ALL='C', GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1')
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', repository, *arguments], env=environment,
                          capture_output=True, text=True, timeout=60, check=False)


def directory_check(path: str, uid: int, forbidden: int) -> tuple[bool, str]:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False, 'missing'
    if not stat.S_ISDIR(info.st_mode):
        return False, 'not a real directory'
    detail = f'uid={info.st_uid} mode={stat.S_IMODE(info.st_mode):o}'
    return info.st_uid == uid and not info.st_mode & forbidden, detail


def deploy_key(repository: str, uid: int, expected: str | None) -> tuple[bool, str]:
    configured = git(repository, 'config', '--local', '--get', 'core.sshCommand')
    if configured.returncode != 0 or not configured.stdout.strip():
        return False, 'core.sshCommand is not configured in the repository'
    words = shlex.split(configured.stdout.strip())
    key = words[words.index('-i') + 1] if '-i' in words[:-1] else None
    if key is None or not key.startswith('/'):
        return False, 'core.sshCommand does not select an absolute deploy key with -i'
    if expected is not None and key != expected:
        return False, f'core.sshCommand selects {key} instead of {expected}'
    try:
        info = os.stat(key)
    except OSError:
        return False, f'{key} is not readable'
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        return False, f'{key} must be a regular file of uid {uid} without group or other access'
    return True, f'{key} uid={info.st_uid} mode={stat.S_IMODE(info.st_mode):o} identities_only={"IdentitiesOnly=yes" in words}'


def preflight(repository: str, uid: int, expected_key: str | None) -> dict:
    checks: list[dict] = []

    def record(name: str, outcome: tuple[bool, str]) -> bool:
        checks.append({'check': name, 'ok': outcome[0], 'detail': outcome[1]})
        return outcome[0]
    canonical = os.path.isabs(repository) and os.path.realpath(repository) == repository
    record('repository_canonical', (canonical, 'absolute path without links' if canonical else 'path is relative or crosses a link'))
    record('repository_private', directory_check(repository, uid, 0o077))
    if record('git_metadata_private', directory_check(os.path.join(repository, '.git'), uid, 0o022)):
        record('deploy_key', deploy_key(repository, uid, expected_key))
        local = git(repository, 'rev-parse', '--verify', '--quiet', MAIN).stdout.strip()
        listed = git(repository, 'ls-remote', '--exit-code', 'origin', MAIN)
        remote = listed.stdout.split()[0] if listed.returncode == 0 and listed.stdout.split() else ''
        record('main_matches_origin', (local != '' and local == remote, f'main={local or "absent"} origin/main={remote or "unreachable or absent"}'))
        push = git(repository, 'push', '--dry-run', '--porcelain', 'origin', f'{MAIN}:{MAIN}')
        record('push_dry_run', (push.returncode == 0, f'exit {push.returncode}'))
    return {'state': 'ready' if all(check['ok'] for check in checks) else 'failed', 'repository': repository, 'checks': checks}


def main() -> int:
    parser = argparse.ArgumentParser(description='Preflight de solo lectura del repositorio del broker de contextos')
    parser.add_argument('--repository', required=True, help='raíz del repositorio privado del broker')
    parser.add_argument('--uid', type=int, default=1000, help='dueño esperado del repositorio y de la clave (1000 por defecto)')
    parser.add_argument('--key', help='ruta absoluta esperada de la deploy key en core.sshCommand')
    args = parser.parse_args()
    result = preflight(args.repository, args.uid, args.key)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result['state'] != 'ready':
        print('preflight fallido: ' + ', '.join(check['check'] for check in result['checks'] if not check['ok']), file=sys.stderr)
    return 0 if result['state'] == 'ready' else 1


if __name__ == '__main__':
    raise SystemExit(main())
