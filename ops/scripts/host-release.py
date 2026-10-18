#!/usr/bin/env python3
"""Packs and verifies the release the gateway serves to enrolled computers (`cauce hosts setup`).

`pack` turns a staged tree into a byte-reproducible `release.tar`, measures the pins the platform policy names with
`@pin:<name>@` on the tree exactly as the computer extracts it, saves the agent image with `docker save | gzip -n` and
writes `host-release.json`. `verify` rechecks every size and SHA-256 before a deploy pins the directory.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'ops/cli'), str(ROOT / 'ops/container-runtime')]
from cauce_container_base import bundle_digest  # noqa: E402
from host_image import archive_image  # noqa: E402
from host_setup import MAX_ARTIFACT, MAX_IMAGE, REQUIRED_IN_RELEASE, extract_release  # noqa: E402

MANIFEST = 'host-release.json'
RELEASE = 'release.tar'
IMAGE = 'agent-image.tar.gz'
QUOTA_IMAGE = 'quota-image.tar.gz'
DOCKER = '/usr/bin/docker'
REVISION = re.compile(r'[a-f0-9]{40}')
HEX = re.compile(r'[a-f0-9]{64}')
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
PIN = re.compile(r'[a-z][a-z0-9_]{0,63}')
# The adapter only runs a pinned command that is a single-link regular file of root, not writable by group or others.
PROVIDER_PROBE = ('import hashlib,os,shutil,stat,sys\nfound=shutil.which(sys.argv[1])\nif found is None:raise SystemExit("missing "+sys.argv[1])\n'
    'real=os.path.realpath(found);info=os.stat(real)\n'
    'if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=0 or info.st_mode&0o022:raise SystemExit("unpinnable "+real)\n'
    'print(real,hashlib.sha256(open(real,"rb").read()).hexdigest())\n')


class ReleaseError(Exception):
    pass


def tar_entries(stage: pathlib.Path):
    """Every entry under `stage` in name order; links must stay inside the tree, like the computer's extraction demands."""
    for current, directories, files in os.walk(stage):
        directories.sort()
        base = pathlib.Path(current)
        for name in sorted(directories + files):
            path = base / name
            relative = path.relative_to(stage).as_posix()
            details = path.lstat()
            if stat.S_ISLNK(details.st_mode):
                target = os.readlink(path)
                if os.path.isabs(target) or not (path.parent / target).resolve().is_relative_to(stage.resolve()):
                    raise ReleaseError(f'link escapes the release: {relative}')
            elif not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)):
                raise ReleaseError(f'unsupported entry in the release: {relative}')
            yield relative, path, details


def write_release(stage: pathlib.Path, archive: pathlib.Path, epoch: int) -> None:
    """Owner, times and modes are fixed, so the same tree always yields the same bytes; hard links become plain files."""
    with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as bundle:
        for relative, path, details in tar_entries(stage):
            info = tarfile.TarInfo(relative)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = epoch
            if stat.S_ISLNK(details.st_mode):
                info.type, info.linkname, info.mode = tarfile.SYMTYPE, os.readlink(path), 0o777
                bundle.addfile(info)
            elif stat.S_ISDIR(details.st_mode):
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                bundle.addfile(info)
            else:
                info.size, info.mode = details.st_size, 0o755 if details.st_mode & 0o100 else 0o644
                with open(path, 'rb') as stream:
                    bundle.addfile(info, stream)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def docker(*arguments: str, timeout: int = 600) -> str:
    result = subprocess.run([DOCKER, *arguments], capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise ReleaseError(f'docker {arguments[0]} failed: {result.stderr.decode("utf-8", "replace").strip()[-300:]}')
    return result.stdout.decode().strip()


def save_image(reference: str, target: pathlib.Path) -> tuple[str, int]:
    """`docker save` compressed without a timestamp; the computer hands the file to `docker load` as it is."""
    digest, size = hashlib.sha256(), 0

    class Counting:
        def write(self, chunk):
            nonlocal size
            digest.update(chunk)
            size += len(chunk)
            return sink.write(chunk)

        def flush(self):
            sink.flush()

    with subprocess.Popen([DOCKER, 'save', reference], stdout=subprocess.PIPE) as process, open(target, 'wb') as sink:
        with gzip.GzipFile(filename='', mode='wb', fileobj=Counting(), mtime=0) as compressed:
            assert process.stdout is not None
            while chunk := process.stdout.read(1024 * 1024):
                compressed.write(chunk)
    if process.returncode:
        raise ReleaseError(f'docker save {reference} failed')
    return digest.hexdigest(), size


def measure_providers(reference: str, providers: list[str]) -> dict[str, str]:
    pins = {}
    for item in providers:
        name, _, command = item.partition('=')
        if PIN.fullmatch(name) is None or not command:
            raise ReleaseError(f'--provider takes NAME=COMMAND: {item}')
        found = docker('run', '--rm', '--network', 'none', '--entrypoint', 'python3', reference, '-c', PROVIDER_PROBE, command).split()
        if len(found) != 2 or not found[0].startswith('/') or HEX.fullmatch(found[1]) is None:
            raise ReleaseError(f'could not measure {command} inside {reference}')
        pins[f'{name}_command'], pins[f'{name}_command_sha256'] = found
    return pins


def pack_image(reference: str, directory: pathlib.Path, filename: str) -> tuple[dict, str]:
    builder_id = docker('image', 'inspect', '--format', '{{.Id}}', reference)
    if IMAGE_ID.fullmatch(builder_id) is None:
        raise ReleaseError(f'{reference} has no content-addressed Id')
    sha256, size = save_image(reference, directory / filename)
    image_id = archive_image(directory / filename, builder_id)['id']
    return {'file': filename, 'sha256': sha256, 'size': size, 'id': image_id, 'reference': reference}, builder_id


def quota_providers(reference: str) -> list[str]:
    providers = ['claude', 'codex', 'grok', 'muse']
    for provider in providers:
        docker('run', '--rm', '--network', 'none', '--entrypoint', provider, reference, '--version')
    try:
        docker('run', '--rm', '--network', 'none', '--entrypoint', 'agy', reference, '--version')
        providers.append('agy')
    except ReleaseError:
        pass
    return providers


def pack(arguments: argparse.Namespace) -> dict:
    stage, out = arguments.stage.resolve(), arguments.out
    if REVISION.fullmatch(arguments.revision) is None:
        raise ReleaseError('--revision must be a full 40-hex commit')
    for required in REQUIRED_IN_RELEASE:
        if not (stage / required).is_file():
            raise ReleaseError(f'the staged release lacks {required}')
    if out.exists() and any(out.iterdir()):
        raise ReleaseError(f'{out} must be absent or empty')
    out.mkdir(parents=True, exist_ok=True)
    out.chmod(0o755)
    write_release(stage, out / RELEASE, arguments.epoch)
    pins = {}
    with tempfile.TemporaryDirectory() as scratch:
        extracted = pathlib.Path(scratch) / 'release'
        extract_release(out / RELEASE, extracted)
        if (extracted / 'adapter').is_dir():
            pins['adapter_digest'] = bundle_digest(str(extracted / 'adapter'))
        pins['hook_sha256'] = sha256_file(extracted / 'ops/cli/fleet-provider-hook.py')
    manifest = {'version': 1, 'revision': arguments.revision,
        'release': {'file': RELEASE, 'sha256': sha256_file(out / RELEASE), 'size': (out / RELEASE).stat().st_size}}
    if arguments.image:
        manifest['image'], builder_id = pack_image(arguments.image, out, IMAGE)
        pins.update(image=manifest['image']['id'], **measure_providers(builder_id, arguments.provider))
    if reference := getattr(arguments, 'quota_image', None):
        manifest['quota_image'], builder_id = pack_image(reference, out, QUOTA_IMAGE)
        manifest['quota_image']['providers'] = quota_providers(builder_id)
        pins['quota_image'] = manifest['quota_image']['id']
    for item in arguments.pin:
        name, _, value = item.partition('=')
        if PIN.fullmatch(name) is None or not value or name in pins:
            raise ReleaseError(f'--pin takes a new NAME=VALUE: {item}')
        pins[name] = value
    manifest['pins'] = pins
    for name in os.listdir(out):
        (out / name).chmod(0o644)
    (out / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (out / MANIFEST).chmod(0o644)
    verify_directory(out, arguments.revision)
    return manifest


def verify_directory(directory: pathlib.Path, revision: str | None = None) -> dict:
    """What the gateway will serve: regular files nobody else can rewrite, with the sizes and digests the manifest signs off."""
    details = directory.lstat()
    if not stat.S_ISDIR(details.st_mode) or details.st_mode & 0o022 or (details.st_mode & 0o005) != 0o005:
        raise ReleaseError(f'{directory} must be a directory readable by everyone and writable only by its owner')
    manifest = json.loads((directory / MANIFEST).read_text())
    if not isinstance(manifest, dict) or manifest.get('version') != 1 or REVISION.fullmatch(str(manifest.get('revision'))) is None:
        raise ReleaseError('host-release.json is not a version 1 manifest')
    if revision is not None and manifest['revision'] != revision:
        raise ReleaseError(f'the host release is {manifest["revision"]}, not the deployed {revision}')
    entries = [('release', MAX_ARTIFACT)] + [(key, MAX_IMAGE) for key in ('image', 'quota_image') if key in manifest]
    for key, limit in entries:
        item = manifest[key]
        path = directory / item['file']
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not info.st_mode & 0o004 or info.st_size != item['size'] \
                or not 0 < item['size'] <= limit or sha256_file(path) != item['sha256']:
            raise ReleaseError(f'{path} differs from host-release.json')
    for key in ('image', 'quota_image'):
        if key in manifest:
            if IMAGE_ID.fullmatch(manifest[key].get('id', '')) is None or manifest['pins'].get(key) != manifest[key]['id']:
                raise ReleaseError(f'the {key} pin differs from the image Id')
            archive_image(directory / manifest[key]['file'], manifest[key]['id'])
    if 'quota_image' in manifest:
        providers = manifest['quota_image'].get('providers')
        if not isinstance(providers, list) or not providers \
                or any(provider not in ('claude', 'codex', 'grok', 'muse', 'agy') for provider in providers) \
                or len(providers) != len(set(providers)):
            raise ReleaseError('the quota image providers are invalid')
    if not all(PIN.fullmatch(name) and isinstance(value, str) and value for name, value in manifest.get('pins', {}).items()):
        raise ReleaseError('host-release.json pins are invalid')
    return manifest


def deploy(root: pathlib.Path, revision: str) -> pathlib.Path:
    """The directory deploy.sh pins: built from this clone when absent, always verified against the deployed commit."""
    if not root.is_absolute() or REVISION.fullmatch(revision) is None:
        raise ReleaseError('the host release root must be absolute and the revision a full commit')
    directory = root / revision
    if not directory.exists():
        root.mkdir(parents=True, exist_ok=True)
        if subprocess.run([str(ROOT / 'ops/scripts/build-host-release.sh'), str(directory)], stdout=sys.stderr, check=False).returncode:
            raise ReleaseError('no pude construir el paquete de ordenadores; constrúyelo con ops/scripts/build-host-release.sh '
                f'en un clon limpio de {revision} y copia el directorio a {directory}')
    verify_directory(directory, revision)
    return directory


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest='action', required=True)
    packing = commands.add_parser('pack')
    packing.add_argument('--stage', type=pathlib.Path, required=True)
    packing.add_argument('--out', type=pathlib.Path, required=True)
    packing.add_argument('--revision', required=True)
    packing.add_argument('--epoch', type=int, default=0, help='mtime of every archived entry; the commit time keeps rebuilds identical')
    packing.add_argument('--image', help='local image reference to save as the agent image')
    packing.add_argument('--quota-image', help='local image reference to save as the quota runtime image')
    packing.add_argument('--provider', action='append', default=[], help='NAME=COMMAND measured inside the image')
    packing.add_argument('--pin', action='append', default=[], help='extra NAME=VALUE for @pin:NAME@')
    checking = commands.add_parser('verify')
    checking.add_argument('directory', type=pathlib.Path)
    checking.add_argument('--revision')
    deploying = commands.add_parser('deploy', help='build when absent, verify and print <root>/<revision>')
    deploying.add_argument('root', type=pathlib.Path)
    deploying.add_argument('--revision', required=True)
    arguments = parser.parse_args()
    try:
        if arguments.action == 'deploy':
            print(deploy(arguments.root, arguments.revision))
            return 0
        result = pack(arguments) if arguments.action == 'pack' else verify_directory(arguments.directory, arguments.revision)
    except (ReleaseError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f'host-release: {error}', file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
