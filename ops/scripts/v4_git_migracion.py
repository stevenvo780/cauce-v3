"""Git history metadata preserved alongside migration bundles."""
from __future__ import annotations

import os
import re
import stat


def alternate_entries(raw: bytes) -> list[bytes]:
    """Git 2.56 parse_alternates. A '#' entry is a comment. A C quote consumes one extra byte, the separator."""
    simple = {97: 7, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 92: 92, 34: 34}
    entries, i, n = [], 0, len(raw)

    def unquote(start: int) -> tuple[bytes, int] | None:
        out, j = bytearray(), start + 1
        while j < n and raw[j] != 34:
            if raw[j] != 92:
                out.append(raw[j])
                j += 1
            elif (esc := raw[j + 1] if j + 1 < n else -1) in simple:
                out.append(simple[esc])
                j += 2
            elif 48 <= esc <= 51 and j + 3 < n and raw[j + 2] in b'01234567' and raw[j + 3] in b'01234567':
                out.append(((esc - 48) << 6) | ((raw[j + 2] - 48) << 3) | (raw[j + 3] - 48))
                j += 4
            else:
                return None
        return (bytes(out), j + 1) if j < n and raw[j] == 34 else None
    while i < n:
        if raw[i] == 35:
            found = raw.find(b'\n', i)
            i = n if found < 0 else found + 1
        elif raw[i] == 34 and (quoted := unquote(i)):
            entries.append(quoted[0])
            i = quoted[1] + 1 if quoted[1] < n else n
        else:
            found = raw.find(b'\n', i)
            entries.append(raw[i:] if found < 0 else raw[i:found])
            i = n if found < 0 else found + 1
    return [entry for entry in entries if entry]


def shallow_boundaries(path: str, object_format: str = 'sha1') -> list[str]:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except FileNotFoundError:
        return []
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 1 << 20:
            raise ValueError('invalid shallow metadata file')
        with os.fdopen(descriptor, 'rb', closefd=False) as handle:
            raw = handle.read((1 << 20) + 1)
        after = os.fstat(descriptor)
        if len(raw) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('shallow metadata changed while copied')
        boundaries = raw.decode('ascii').splitlines()
        if not valid_boundaries(sorted(boundaries), object_format):
            raise ValueError('invalid shallow commit boundaries')
        return sorted(boundaries)
    finally:
        os.close(descriptor)


def valid_boundaries(boundaries, object_format: str) -> bool:
    if object_format not in ('sha1', 'sha256') or not isinstance(boundaries, list):
        return False
    size = 40 if object_format == 'sha1' else 64
    return all(isinstance(value, str) and re.fullmatch(f'[0-9a-f]{{{size}}}', value) for value in boundaries) and boundaries == sorted(set(boundaries))


def init_repository(path: str, metadata: dict, git) -> None:
    git(path, 'init', '-q', '--object-format=' + metadata.get('objectFormat', 'sha1'))
    boundaries = metadata.get('shallow', [])
    if not boundaries:
        return
    directory = os.open(os.path.join(path, '.git'), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        writer = os.open('shallow', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        with os.fdopen(writer, 'w', encoding='ascii') as handle:
            handle.write('\n'.join(boundaries) + '\n')
    finally:
        os.close(directory)
