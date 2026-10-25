from __future__ import annotations

import json
import pathlib
import sys
import time

from context_client import (
    ContextArgumentParser,
    ContextClient,
    ContextFailure,
    arguments,
    console_failure_message,
    read_scoped,
    valid_path,
)


def sync(client: ContextClient, tenant: str, alias: str, root: str, paths: list[str], removed: list[str], expected: int) -> dict:
    directory = pathlib.Path(root).absolute()
    if directory.resolve() != directory:
        raise ContextFailure('native context root must be a real directory')
    snapshot = client.request('GET', tenant, alias)
    if snapshot['version'] != expected:
        raise ContextFailure('context version changed; reload before syncing native files')
    files = {file['path']: file['content'] for file in snapshot['files']}
    for path in removed:
        files.pop(valid_path(path), None)
    for path in paths:
        relative = valid_path(path)
        files[relative] = read_scoped(directory, relative).decode('utf-8')
    content = [{'path': path, 'content': value} for path, value in sorted(files.items())]
    if content == snapshot['files']:
        return snapshot
    return client.request('PUT', tenant, alias, body={'expected_version': expected, 'source': 'native', 'files': content})


def main() -> int:
    parser = ContextArgumentParser(prog='cauce context-native', description='Ingesta CAS de ficheros nativos explícitos, sin recorrer perfiles ni sesiones')
    arguments(parser)
    parser.add_argument('--root', required=True)
    parser.add_argument('--expected-version', type=int, required=True)
    parser.add_argument('--remove', action='append', default=[])
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('paths', nargs='*')
    args = parser.parse_args()
    try:
        if not args.paths and not args.remove:
            raise ContextFailure('an explicit native context file list is required')
        client = ContextClient(args.gateway, args.origin, args.session_file, args.ca_file)
        expected = args.expected_version
        while True:
            result = sync(client, args.tenant, args.alias, args.root, args.paths, args.remove, expected)
            if not args.watch or result['version'] != expected:
                print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
            expected = result['version']
            if not args.watch:
                return 0
            time.sleep(2)
    except KeyboardInterrupt:
        return 0
    except ContextFailure as error:
        print('cauce context-native: ' + console_failure_message(error), file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print('La sincronización nativa se detuvo; revisa CAS, sesión, rutas y ficheros permitidos.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
