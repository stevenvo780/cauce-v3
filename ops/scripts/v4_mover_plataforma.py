from __future__ import annotations

import json
import pathlib
import re
import shlex
import subprocess
import uuid


class PlatformFailure(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class PlatformClient:
    def __init__(self, settings: dict, company: str, tenant: str | None = None):
        if not isinstance(settings, dict) or set(settings) - {'route', 'container', 'human_id', 'project_root'}:
            raise PlatformFailure('invalid internal gateway configuration')
        try:
            human_id = str(uuid.UUID(settings.get('human_id', '')))
        except (ValueError, TypeError, AttributeError):
            raise PlatformFailure('platform gateway requires an explicit administrator UUID') from None
        route = settings.get('route', 'local')
        container = settings.get('container')
        root = settings.get('project_root', '/app' if container else str(pathlib.Path(__file__).resolve().parents[2]))
        if not isinstance(root, str) or not root.startswith('/') or '..' in pathlib.PurePosixPath(root).parts:
            raise PlatformFailure('invalid internal gateway project root')
        if route != 'local' and (not isinstance(route, str) or not re.fullmatch(r'ssh:[A-Za-z0-9_][A-Za-z0-9_.@-]*', route)):
            raise PlatformFailure('invalid internal gateway route')
        if container is not None and (not isinstance(container, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', container)):
            raise PlatformFailure('invalid internal gateway container')
        if route != 'local' and container is None:
            raise PlatformFailure('remote platform authority requires an explicit gateway container')
        self.settings, self.company, self.tenant = settings, company, tenant
        self.human_id = human_id
        module = root + ('/services/gateway/dist/fleet/migration-platform.js' if container else '/services/gateway/src/fleet/migration-platform.ts')
        bootstrap = ('const {runMigrationPlatformCommand}=await import(' + json.dumps(module)
                     + '); await runMigrationPlatformCommand();')
        command = ['node', *([] if container else ['--import', 'tsx']), '--input-type=module', '-e', bootstrap]
        if container:
            command = ['docker', 'exec', '-i', container, root + '/deploy/runtime-entrypoint.sh', *command]
        self.command = command if route == 'local' else ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                                                         route[4:], shlex.join(command)]

    def request(self, method: str, path: str, payload=None):
        packet = {'human_id': self.human_id, 'company': self.company, 'tenant': self.tenant,
                  'method': method, 'path': path, 'payload': payload}
        try:
            result = subprocess.run(self.command, input=json.dumps(packet), capture_output=True,
                                    text=True, timeout=120, check=False)
            response = json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            raise PlatformFailure('internal gateway request could not be verified') from None
        if result.returncode != 0 or not isinstance(response, dict) or type(response.get('status')) is not int:
            raise PlatformFailure('internal gateway returned an invalid receipt')
        if response['status'] >= 400:
            detail = response.get('body')
            message = detail.get('message') if isinstance(detail, dict) else None
            diagnostic = detail.get('diagnostic') if isinstance(detail, dict) else None
            if isinstance(diagnostic, dict):
                suffix = ' '.join(str(diagnostic[key]) for key in ('sqlstate', 'constraint', 'type') if key in diagnostic)
                if suffix:
                    message = (message + ' ' if isinstance(message, str) else '') + suffix
            raise PlatformFailure('internal gateway rejected the scoped migration request'
                                  + (': ' + message[:240] if isinstance(message, str) else ''), response['status'])
        return response.get('body')
