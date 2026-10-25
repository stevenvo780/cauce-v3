from __future__ import annotations

import json
import pathlib
import subprocess
import uuid


def container_probe(binding: dict, placement: dict, harness: str, *, tmpfs_size: str,
                    volumes: tuple[str, ...] = ()) -> bool:
    directory = pathlib.Path(__file__).resolve().parent
    if ':' in str(directory):
        return False
    name = 'cauce-' + harness + '-probe-' + uuid.uuid4().hex
    program = ('import json,sys\nsys.path.insert(0,"/cauce/executor")\n'
               f'try:\n from fleet_provider_{harness} import measured_definition\n'
               ' result=measured_definition(json.load(sys.stdin),strict=True)\n'
               'except Exception:\n sys.exit(2)\n'
               'print("cauce-probe:true" if result else "cauce-probe:false")\n')
    try:
        mounts = [value for volume in (f'{directory}:/cauce/executor:ro,z', *volumes) for value in ('--volume', volume)]
        result = subprocess.run(['/usr/bin/docker', 'run', '--rm', '--pull=never', '--name', name, '-i',
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--tmpfs', f'/tmp:rw,nosuid,nodev,size={tmpfs_size}', '--user', placement['runtime_user'],
            *mounts, '--entrypoint', placement['python'], placement['image'], '-I', '-B', '-c', program],
            input=json.dumps(binding).encode(), capture_output=True, timeout=40 if harness != 'openclaw' else 15, check=False)
        if result.returncode != 0:
            raise subprocess.CalledProcessError(result.returncode, 'container capability probe')
        if result.stdout not in (b'cauce-probe:true\n', b'cauce-probe:false\n'):
            raise ValueError('container capability probe has no definitive verdict')
        return result.stdout == b'cauce-probe:true\n'
    finally:
        try:
            subprocess.run(['/usr/bin/docker', 'rm', '-f', name], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            pass
