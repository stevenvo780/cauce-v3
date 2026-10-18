"""Clone pinned repositories into an agent's dedicated destination space."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import pathlib
import re
import shlex
import urllib.parse

from v4_copia_migracion import GIT_ENV, git_command

NAME = re.compile(r'[a-z][a-z0-9-]{0,62}\Z')
REVISION = re.compile(r'[0-9a-f]{40}\Z')
USER = re.compile(r'[a-z_][a-z0-9_-]{0,31}\Z')
HOST = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\Z')
COMPONENT = re.compile(r'[A-Za-z0-9_.-]+\Z')
PATH_CHECK = '''import os,pathlib,stat,sys
base,target,mode=map(str,sys.argv[1:])
path=pathlib.Path(base)
for current in [*reversed(path.parents),path]:
 if not stat.S_ISDIR(current.lstat().st_mode): raise ValueError('repository base is not a directory without links')
path=pathlib.Path(base)/target
for current in [*reversed(path.parents),path]:
 if not current.is_relative_to(base): continue
 try: info=current.lstat()
 except FileNotFoundError:
  if mode!='prepare': raise
  if current==path: continue
  current.mkdir(mode=0o700)
  info=current.lstat()
 if mode=='prepare' and current==path: raise ValueError('repository destination already exists')
 if not stat.S_ISDIR(info.st_mode): raise ValueError('repository path is not a directory without links')
if mode=='verify':
 metadata=path/'.git'
 if not stat.S_ISDIR(metadata.lstat().st_mode): raise ValueError('repository metadata is not a directory')
 for current,children,files in os.walk(metadata,followlinks=False):
  for name in children+files:
   if stat.S_ISLNK((pathlib.Path(current)/name).lstat().st_mode): raise ValueError('repository metadata contains a link')
 for name in ('objects/info/alternates','objects/info/http-alternates','commondir'):
  candidate=metadata/name
  if candidate.exists() and candidate.stat().st_size: raise ValueError('repository uses shared object storage')
'''
SSH_CHECK = '''import os,pathlib,stat,sys
profile=pathlib.Path(sys.argv[1])
for current in [*reversed(profile.parents),profile,profile/'ssh']:
 if not stat.S_ISDIR(current.lstat().st_mode): raise ValueError('SSH profile path is not a directory without links')
for name in ('id_ed25519','known_hosts'):
 info=(profile/'ssh'/name).lstat()
 if not stat.S_ISREG(info.st_mode): raise ValueError('SSH identity or trust file is not regular')
 if name=='id_ed25519' and (info.st_uid!=os.getuid() or info.st_mode&0o077): raise ValueError('SSH identity is not private to the runtime user')
if not all(os.access(binary,os.X_OK) for binary in ('/usr/bin/git','/usr/bin/ssh')):
 raise ValueError('repository cloning requires git and ssh in the approved image')
'''


def canonical_path(value, absolute):
    if not isinstance(value, str) or not value or value.startswith('/') is not absolute:
        raise ValueError('repository paths must be canonical')
    path = pathlib.PurePosixPath(value)
    if str(path) != value or any(part in {'.', '..'} or not COMPONENT.fullmatch(part)
                                 for part in path.parts if part != '/'):
        raise ValueError('repository paths must be canonical')
    return path


def ssh_source(value):
    if not isinstance(value, str) or len(value) > 4096 or any(char.isspace() or ord(char) < 32 for char in value):
        raise ValueError('repository source must be an SSH URL')
    try:
        url = urllib.parse.urlsplit(value)
        host = url.hostname
        if url.scheme != 'ssh' or not USER.fullmatch(url.username or '') or url.password is not None \
                or url.port is not None or url.query or url.fragment or not host or len(host) > 253 or '%' in host:
            raise ValueError('repository source must use SSH without credentials or an explicit port')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if not HOST.fullmatch(host):
                raise ValueError('repository source host is invalid') from None
        authority = url.username + '@' + ('[' + host + ']' if ':' in host else host)
        if url.netloc.lower() != authority.lower():
            raise ValueError('repository source authority is invalid')
        path = canonical_path(url.path, True)
        if path == pathlib.PurePosixPath('/'):
            raise ValueError('repository source must identify a repository')
    except (TypeError, AttributeError):
        raise ValueError('repository source must be an SSH URL') from None


def validate_repositories(plan):
    repositories = plan.get('repositories', [])
    if not isinstance(repositories, list) or len(repositories) > 32:
        raise ValueError('repositories must be a bounded list')
    names = {item['name'] for item in plan.get('roots', [])}
    targets = [canonical_path(item['target'], False) for item in plan.get('roots', [])]
    for item in repositories:
        if not isinstance(item, dict) or set(item) != {'name', 'source', 'target', 'revision'}:
            raise ValueError('each repository requires name, source, target and revision')
        if not isinstance(item['name'], str) or not NAME.fullmatch(item['name']) or item['name'] in names:
            raise ValueError('repository names must be distinct from every copy root')
        if not isinstance(item['revision'], str) or not REVISION.fullmatch(item['revision']):
            raise ValueError('repository revisions must be pinned commit hashes')
        ssh_source(item['source'])
        target = canonical_path(item['target'], False)
        if len(target.parts) < 2 or target.parts[0] != 'projects' \
                or any(target.is_relative_to(other) or other.is_relative_to(target) for other in targets):
            raise ValueError('repository targets must be distinct projects outside copy roots')
        names.add(item['name'])
        targets.append(target)
    return repositories


def provider_profile(info, request):
    account, runtime = request.get('primary_account_id'), request.get('runtime_key')
    if not isinstance(account, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', account) \
            or not isinstance(runtime, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', runtime):
        raise ValueError('repository cloning requires the current account and runtime binding')
    roots = [canonical_path(mount['Destination'], True) for mount in info.get('Mounts', [])
             if mount.get('Type') == 'volume' and mount.get('Name') == request['placement']['container_name'] + '-provider-profiles'
             and mount.get('RW') is True]
    if len(roots) != 1:
        raise ValueError('SSH profile requires a dedicated provider volume')
    return roots[0] / runtime / hashlib.sha256(account.encode()).hexdigest()


def clone_repositories(request):
    from v4_mover_host import docker

    repositories = validate_repositories(request)
    if not repositories:
        return {'verified': True, 'repositories': []}
    placement = request['placement']
    base = str(canonical_path(placement['state_directory'], True) / 'space')
    home = str(canonical_path(placement['home_directory'], True))
    info = json.loads(docker('inspect', placement['container_name']))[0]
    labels = info['Config'].get('Labels') or {}
    if any(labels.get('cauce.fleet.' + label) != request[key] for label, key in
           [('runtime_key', 'runtime_key'), ('tenant', 'tenant'), ('alias', 'alias')]) \
            or labels.get('cauce.fleet.host') != placement['host_id'] \
            or info['State']['Running'] is not True or info['Image'] != request['image']:
        raise ValueError('repository destination runtime differs from its pinned identity')

    def execute(*arguments):
        return docker('exec', '--user', placement['runtime_user'], info['Id'], *arguments).decode().strip()

    profile = provider_profile(info, request)
    execute('/usr/bin/python3', '-I', '-B', '-c', SSH_CHECK, str(profile))
    ssh = ['ssh', '-i', str(profile / 'ssh' / 'id_ed25519'), '-o', 'BatchMode=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
           '-o', 'UserKnownHostsFile=' + str(profile / 'ssh' / 'known_hosts')]
    environment = {**GIT_ENV, 'HOME': home,
                   'GIT_SSH_COMMAND': shlex.join(ssh)}

    def git(path, *arguments):
        return execute('/usr/bin/env', '-i', *[key + '=' + value for key, value in environment.items()],
                       *git_command(path, ('-c', 'protocol.file.allow=never', '-c', 'protocol.ssh.allow=always', *arguments)))

    result = []
    for item in repositories:
        target = str(pathlib.PurePosixPath(base) / item['target'])
        execute('/usr/bin/python3', '-I', '-B', '-c', PATH_CHECK, base, item['target'], 'prepare')
        git(base, 'clone', '--no-local', '--no-checkout', '--', item['source'], target)
        execute('/usr/bin/python3', '-I', '-B', '-c', PATH_CHECK, base, item['target'], 'verify')
        git(target, 'cat-file', '-e', item['revision'] + '^{commit}')
        git(target, 'checkout', '--detach', item['revision'])
        head = git(target, 'rev-parse', 'HEAD')
        if head != item['revision'] or git(target, 'remote', 'get-url', 'origin') != item['source']:
            raise ValueError('repository head or origin differs from its pin')
        execute('/usr/bin/python3', '-I', '-B', '-c', PATH_CHECK, base, item['target'], 'verify')
        result.append({'name': item['name'], 'path': target, 'head': head})
    return {'verified': True, 'repositories': result}
