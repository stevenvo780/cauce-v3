from __future__ import annotations

import hashlib
import json
import pathlib
import re
import tarfile

IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
REFERENCE = re.compile(r'[a-z0-9][a-zA-Z0-9._:/@-]{0,255}')
MAX_METADATA = 4 * 1024 * 1024


class ImageFailure(ValueError):
    pass


def archive_image(path: pathlib.Path, expected_id: str | None = None) -> dict:
    """The config digest survives Docker's classic and containerd stores; no archive entry is extracted."""
    try:
        with tarfile.open(path, 'r:*') as archive:
            members = {}
            for member in archive:
                if member.name in members:
                    raise ImageFailure('image archive has duplicate entries')
                members[member.name] = member

            def read(name: str) -> bytes:
                member = members.get(name)
                if member is None or not member.isfile() or not 0 < member.size <= MAX_METADATA:
                    raise ImageFailure('image archive metadata is missing or unsafe')
                stream = archive.extractfile(member)
                if stream is None:
                    raise ImageFailure('image archive metadata is unreadable')
                with stream:
                    return stream.read(MAX_METADATA + 1)

            manifest = json.loads(read('manifest.json'))
            if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
                raise ImageFailure('image archive must contain exactly one image')
            config = read(manifest[0]['Config'])
            config_id = 'sha256:' + hashlib.sha256(config).hexdigest()
            references = manifest[0].get('RepoTags') or []
            if not isinstance(references, list) or any(not isinstance(value, str) or REFERENCE.fullmatch(value) is None for value in references):
                raise ImageFailure('image archive has invalid references')
            if expected_id is not None and expected_id != config_id:
                def contains_config(digest: str, depth: int = 0) -> bool:
                    if not isinstance(digest, str) or IMAGE_ID.fullmatch(digest) is None or depth > 3:
                        raise ImageFailure('image manifest digest or depth is invalid')
                    descriptor = read('blobs/sha256/' + digest.removeprefix('sha256:'))
                    if 'sha256:' + hashlib.sha256(descriptor).hexdigest() != digest:
                        raise ImageFailure('image manifest digest differs from its bytes')
                    value = json.loads(descriptor)
                    if value.get('config', {}).get('digest') == config_id:
                        return True
                    children = value.get('manifests', [])
                    if not isinstance(children, list) or len(children) > 64:
                        raise ImageFailure('image index exceeds its bound')
                    return any(contains_config(child['digest'], depth + 1) for child in children)

                # Older packages pin an OCI manifest or index, including optional build attestations.
                if not contains_config(expected_id):
                    raise ImageFailure('image archive differs from the signed image pin')
            return {'id': config_id, 'references': references}
    except (OSError, tarfile.TarError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise ImageFailure(f'cannot verify image archive: {error}') from None
