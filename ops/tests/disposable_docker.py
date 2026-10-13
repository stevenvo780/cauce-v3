"""Disposable Docker fixtures for ops tests that need a real container and a real tmux.

Everything a fixture creates carries its own owner label, so cleanup removes exactly that and proves no
container or image is left behind. CAUCE_REAL_DOCKER_IMAGE reuses a prebuilt image with tmux and procps.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import tempfile
import uuid

OWNER_LABEL = 'cauce.test.owner'
BASE_IMAGE = 'node:22-slim'
PACKAGES = ('tmux', 'procps')


def required() -> bool:
    return '1' in (os.environ.get('CAUCE_REQUIRE_REAL_DOCKER'), os.environ.get('CAUCE_RELEASE_VALIDATION'))


def docker(*arguments: str, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=timeout, check=check)


def unavailable_reason() -> str | None:
    if shutil.which('docker') is None:
        return 'docker CLI is missing'
    try:
        answer = docker('info', '--format', '{{.ServerVersion}}', timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return 'docker daemon does not answer'
    return None if answer.returncode == 0 else 'docker daemon does not answer'


class Disposable:
    def __init__(self, purpose: str) -> None:
        self.owner = f'{purpose}-{uuid.uuid4().hex[:12]}'
        self.image = ''
        self.owned_image = False
        self.containers: list[str] = []

    def build(self) -> str:
        prebuilt = os.environ.get('CAUCE_REAL_DOCKER_IMAGE')
        if prebuilt:
            self.image = prebuilt
            return prebuilt
        tag = f'cauce-test-disposable:{self.owner}'
        with tempfile.TemporaryDirectory(prefix='cauce-disposable-build-') as context:
            pathlib.Path(context, 'Dockerfile').write_text(
                f'FROM {BASE_IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends '
                f'{" ".join(PACKAGES)} && rm -rf /var/lib/apt/lists/*\n', encoding='utf-8')
            self.owned_image = True
            docker('build', '-q', '--label', f'{OWNER_LABEL}={self.owner}', '-t', tag, context, timeout=900)
        self.image = tag
        return tag

    def run(self, suffix: str, *arguments: str) -> str:
        name = f'cauce-test-{self.owner}-{suffix}'
        self.containers.append(name)
        docker('run', '-d', '--init', '--name', name, '--label', f'{OWNER_LABEL}={self.owner}', '--network', 'none',
               *arguments, self.image, 'sleep', 'infinity')
        return name

    def residue(self) -> list[str]:
        containers = docker('ps', '-aq', '--filter', f'label={OWNER_LABEL}={self.owner}', check=False).stdout.split()
        images = docker('images', '-q', '--filter', f'label={OWNER_LABEL}={self.owner}', check=False).stdout.split()
        return containers + images

    def cleanup(self) -> list[str]:
        for name in self.containers:
            docker('rm', '-f', name, check=False)
        if self.owned_image:
            docker('image', 'rm', '-f', f'cauce-test-disposable:{self.owner}', check=False)
        return self.residue()
