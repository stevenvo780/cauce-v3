#!/usr/bin/env python3
"""The two primitives every source digest in this directory is built from.

source-digest.py binds each evidence artifact to the domain that can change its result, and
container_ops_digest.py binds OPERATIONS.sha256 to the container-operations surface. They answer
different questions and keep their own hand-written inventories and their own logical-path mapping.
What they share is the mechanics below, and two copies of mechanics like these fail silently: a
divergence moves one digest and not the other, so evidence issued under one tool stops meaning what
the other tool would have said about the same bytes.

tracked_files expands declared inputs into the files Git treats as source: tracked files plus new
files no ignore rule covers, so a freshly added operational script cannot evade a digest before it
is committed, while an operator's ignored backup never enters one. Operator-global excludes are
disabled, so a local preference cannot hide repository source. A release archive has no `.git`; the
physical tree is already the source tree there and no ignore lookup applies.

fold_digest folds those files into one `sha256:` value over the logical paths in LC_ALL=C order,
which for UTF-8 is Python's own string order. Path and content are BOTH hashed, so a rename is
observable. Each is framed by its own big-endian 8-byte length before its bytes. That framing is a
length prefix and not a separator byte, so no path and no content can forge the boundary and no
byte value is forbidden inside either. The framing is fixed: changing it would move every digest
ever issued by either tool.
"""

from __future__ import annotations

import hashlib
import pathlib
import subprocess
from collections.abc import Callable, Iterable

KeepPredicate = Callable[[pathlib.Path, pathlib.PurePosixPath], bool]


class DigestError(ValueError):
    """A sanitized digest-selection failure, safe to report without path or target details."""


def git_source_paths(
    root: pathlib.Path, *, worktree_root: bool = False
) -> set[str] | None:
    """Return the paths, relative to *root*, that Git treats as source below it.

    ``None`` means no Git policy applies and the caller must take the physical tree as the source
    tree, which is exactly what a release archive is. With *worktree_root* the caller declares that
    *root* must be the top of the worktree it digests; a probe that fails there is a failure, not an
    archive, and a *root* that resolves inside some other checkout is rejected instead of silently
    digesting that checkout's policy. Files inside a NESTED repository (a submodule or a stray
    checkout below *root*) belong to that repository's policy and are not listed here, so they stay
    outside the digest; a caller that must cover such a tree has to digest it as its own root.
    """

    if worktree_root and not (root / ".git").exists():
        return None
    try:
        probe = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        if worktree_root:
            raise DigestError("digest could not resolve the worktree ignore policy") from None
        return None
    if probe.returncode != 0:
        if worktree_root:
            raise DigestError("digest could not resolve the worktree ignore policy")
        return None
    repository = pathlib.Path(probe.stdout.strip()).resolve()
    resolved = root.resolve()
    if worktree_root and repository != resolved:
        raise DigestError("digest root differs from the resolved Git worktree")
    try:
        prefix = resolved.relative_to(repository).as_posix()
    except ValueError:
        return None
    command = [
        "git",
        "-C",
        str(repository),
        "-c",
        "core.excludesFile=/dev/null",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ]
    if prefix not in {"", "."}:
        command.extend(["--", prefix])
    listed = subprocess.run(command, check=False, capture_output=True)
    if listed.returncode != 0:
        raise DigestError("digest could not enumerate the tracked inputs")
    base = "" if prefix in {"", "."} else f"{prefix}/"
    known: set[str] = set()
    for entry in listed.stdout.split(b"\0"):
        if not entry:
            continue
        value = entry.decode("utf-8")
        if base:
            if not value.startswith(base):
                continue
            value = value[len(base) :]
        known.add(value)
    return known


def tracked_files(
    root: pathlib.Path,
    inputs: Iterable[str],
    *,
    keep: KeepPredicate | None = None,
    worktree_root: bool = False,
) -> list[pathlib.Path]:
    """Enumerate the Git source files under *inputs*, each declared relative to *root*.

    An input that is a file contributes itself; an input that is a directory is walked whole, so a
    file added to it later is covered automatically instead of escaping the digest. Symlinks are
    enumerated rather than skipped: whether one is source, an error or noise is a policy each caller
    decides in *keep*, which receives the path and its root-relative logical name. The result is
    deduplicated and ordered by that logical name.
    """

    known = git_source_paths(root, worktree_root=worktree_root)
    selected: dict[str, pathlib.Path] = {}
    for relative in inputs:
        candidate = root / relative
        paths = (
            [candidate]
            if candidate.is_file() or candidate.is_symlink()
            else candidate.rglob("*")
        )
        for path in paths:
            if not path.is_symlink() and not path.is_file():
                continue
            local = pathlib.PurePosixPath(path.relative_to(root).as_posix())
            if keep is not None and not keep(path, local):
                continue
            name = local.as_posix()
            if known is not None and name not in known:
                continue
            selected[name] = path
    return [selected[name] for name in sorted(selected)]


def fold_digest(pairs: Iterable[tuple[str, pathlib.Path]]) -> str:
    """Fold (logical path, file) pairs into one `sha256:`-prefixed digest.

    Ordering is by logical path, so the digest cannot depend on the order a filesystem happened to
    hand its entries back. Only the bytes of each file are read: metadata such as mtime, ownership
    or mode is deliberately outside the digest, because none of it is source.
    """

    digest = hashlib.sha256()
    for logical, path in sorted(pairs, key=lambda pair: pair[0]):
        name = logical.encode("utf-8")
        content = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"
