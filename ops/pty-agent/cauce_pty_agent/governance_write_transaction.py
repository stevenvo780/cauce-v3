from __future__ import annotations

import hashlib
import os
import stat
import sys
from typing import Any


class GovernanceBindMountError(Exception):
    """The destination is a bind-mounted file and cannot be committed with rename."""


class GovernanceWriteTransactionMixin:
    """Apply staged governance batches with rollback and durable cleanup."""

    def _apply_governance_batch(self, pending: Any) -> list[dict[str, Any]]:
        """Preflight, stage, revalidate and commit; any failed commit rolls the prefix back."""
        plans: list[dict[str, Any]] = []
        try:
            # COMPLETE PRE-FLIGHT. Nothing is created, truncated, renamed, or touched before this loop ends.
            for index, entry in enumerate(pending.entries):
                directory, basename = self._open_governance_parent(entry.path)
                plan: dict[str, Any] = {
                    "entry": entry, "directory": directory, "basename": basename,
                    "index": index, "temporary": None, "backup": None, "committed": False,
                }
                plans.append(plan)
                try:
                    current_sha, current_info = self._hash_regular_at(directory, basename)
                    exists = True
                except FileNotFoundError:
                    current_sha, current_info, exists = None, None, False
                plan.update({"current_sha": current_sha, "current_info": current_info, "exists": exists})

                if entry.mode == "verify":
                    if entry.operation == "present":
                        if not exists:
                            raise FileNotFoundError(basename)
                        if current_sha != entry.expected_sha:
                            raise ValueError(f"{basename} changed; SHA-256 precondition failed")
                        plan["ack_operation"] = "unchanged"
                    else:
                        if exists:
                            raise FileExistsError(basename)
                        plan["ack_operation"] = "absent"
                    continue

                unchanged = exists and current_sha == entry.content_sha
                if unchanged and pending.operation_descriptor is None:
                    plan["ack_operation"] = "unchanged"
                    continue
                if entry.operation == "create":
                    if exists:
                        raise FileExistsError(basename)
                else:
                    if not exists:
                        raise FileNotFoundError(basename)
                    if current_sha != entry.expected_sha:
                        raise ValueError(f"{basename} changed; SHA-256 precondition failed")
                    if (not unchanged
                            and self._target_is_mount_point(directory, entry.path, current_info)):
                        # The rollback of this transaction is a hardlink to the ORIGINAL inode
                        # restored with os.replace: over a mounted destination there is no inode
                        # to link and no name to put back. Refusing keeps the mount whole.
                        raise GovernanceBindMountError(
                            f"{basename} is a bind-mounted file; a transactional profile cannot commit it",
                        )
                if unchanged:
                    plan["ack_operation"] = "unchanged"
                    plan["sync_unchanged"] = True
                    continue
                plan["ack_operation"] = entry.operation

            # COMPLETE STAGING. Temporaries are not served names and do not change destinations.
            for plan in plans:
                entry = plan["entry"]
                if entry.mode != "write" or plan["ack_operation"] == "unchanged":
                    continue
                directory = plan["directory"]
                temporary = f".cauce-profile-{pending.request_id}-{plan['index']}.tmp"
                temp_fd = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600, dir_fd=directory,
                )
                plan["temporary"] = temporary
                try:
                    content = memoryview(bytes(entry.content))
                    written = 0
                    while written < len(content):
                        amount = os.write(temp_fd, content[written:])
                        if amount <= 0:
                            raise OSError("short governance batch write")
                        written += amount
                    current_info = plan["current_info"]
                    if current_info is not None:
                        os.fchmod(temp_fd, stat.S_IMODE(current_info.st_mode))
                        if current_info.st_uid != os.geteuid() or current_info.st_gid != os.getegid():
                            os.fchown(temp_fd, current_info.st_uid, current_info.st_gid)
                    os.fsync(temp_fd)
                    staged = os.fstat(temp_fd)
                    plan["staged_inode"] = (staged.st_dev, staged.st_ino)
                finally:
                    os.close(temp_fd)

            # GLOBAL REVALIDATION. Verifies and no-ops are also re-measured right before.
            for plan in plans:
                entry = plan["entry"]
                directory = plan["directory"]
                basename = plan["basename"]
                try:
                    latest_sha, latest_info = self._hash_regular_at(directory, basename)
                    latest_exists = True
                except FileNotFoundError:
                    latest_sha, latest_info, latest_exists = None, None, False
                if plan["exists"] != latest_exists:
                    raise ValueError(f"{basename} changed after preflight")
                if latest_exists and self._stat_identity(latest_info) != self._stat_identity(plan["current_info"]):
                    raise ValueError(f"{basename} changed after preflight")
                if latest_sha != plan["current_sha"]:
                    raise ValueError(f"{basename} changed after preflight")
                if plan.get("sync_unchanged"):
                    self._sync_unchanged_governance_file(
                        directory, basename, latest_info, latest_sha,
                    )
                if entry.mode == "write" and plan["ack_operation"] == "replace":
                    backup = f".cauce-profile-{pending.request_id}-{plan['index']}.bak"
                    os.link(basename, backup, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                    plan["backup"] = backup
                    # Creating the rollback hardlink changes the inode's ctime/nlink even though
                    # nobody edited its bytes. That post-link identity is the one that must reach commit.
                    plan["commit_identity"] = self._stat_identity(
                        os.stat(basename, dir_fd=directory, follow_symlinks=False),
                    )
                elif latest_info is not None:
                    plan["commit_identity"] = self._stat_identity(latest_info)

            # COMMIT. Each step is atomic; if one fails, the prefix is reverted in reverse order.
            try:
                for plan in plans:
                    entry = plan["entry"]
                    operation = plan["ack_operation"]
                    if entry.mode != "write" or operation == "unchanged":
                        continue
                    directory = plan["directory"]
                    basename = plan["basename"]
                    temporary = plan["temporary"]
                    if operation == "create":
                        os.link(
                            temporary, basename,
                            src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False,
                        )
                        os.unlink(temporary, dir_fd=directory)
                        plan["temporary"] = None
                    else:
                        latest = os.stat(basename, dir_fd=directory, follow_symlinks=False)
                        if self._stat_identity(latest) != plan["commit_identity"]:
                            raise ValueError(f"{basename} changed before commit")
                        os.replace(temporary, basename, src_dir_fd=directory, dst_dir_fd=directory)
                        plan["temporary"] = None
                    plan["committed"] = True
                    os.fsync(directory)
            except BaseException:
                rollback_failed = False
                for plan in reversed(plans):
                    if not plan["committed"]:
                        continue
                    directory = plan["directory"]
                    basename = plan["basename"]
                    try:
                        current_sha, current = self._hash_regular_at(directory, basename)
                        entry = plan["entry"]
                        if ((current.st_dev, current.st_ino) != plan["staged_inode"]
                                or current_sha != entry.content_sha):
                            rollback_failed = True
                            continue
                        if plan["ack_operation"] == "create":
                            os.unlink(basename, dir_fd=directory)
                        else:
                            os.replace(
                                plan["backup"], basename,
                                src_dir_fd=directory, dst_dir_fd=directory,
                            )
                            plan["backup"] = None
                        os.fsync(directory)
                    except OSError:
                        rollback_failed = True
                if rollback_failed:
                    raise OSError("governance batch rollback could not restore every file") from None
                raise

            acknowledgements: list[dict[str, Any]] = []
            for plan in plans:
                entry = plan["entry"]
                if plan["ack_operation"] == "absent":
                    digest, size = None, 0
                elif entry.mode == "write":
                    digest, size = entry.content_sha, entry.content_bytes
                else:
                    digest, size = entry.expected_sha, plan["current_info"].st_size
                acknowledgements.append({
                    "path": entry.path,
                    "operation": plan["ack_operation"],
                    "sha": digest,
                    "bytes": size,
                })
            return acknowledgements
        finally:
            active_error = sys.exc_info()[1]
            cleanup_error: OSError | None = None
            for plan in plans:
                directory = plan["directory"]
                changed = False
                for key in ("temporary", "backup"):
                    name = plan.get(key)
                    if name is not None:
                        try:
                            os.unlink(name, dir_fd=directory)
                            changed = True
                        except OSError as error:
                            if cleanup_error is None:
                                cleanup_error = error
                if changed:
                    try:
                        os.fsync(directory)
                    except OSError as error:
                        if cleanup_error is None:
                            cleanup_error = error
                os.close(directory)
            if cleanup_error is not None:
                if active_error is None:
                    raise OSError("governance batch cleanup was not durable") from cleanup_error
                active_error.add_note("governance batch cleanup was not durable")

    def _sync_unchanged_governance_file(
        self, directory: int, basename: str, expected: os.stat_result, expected_sha: str,
    ) -> None:
        descriptor = os.open(basename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or self._stat_identity(before) != self._stat_identity(expected):
                raise ValueError("the unchanged file identity changed before synchronization")
            digest = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            after = os.fstat(descriptor)
            if (self._stat_identity(before) != self._stat_identity(after)
                    or digest.hexdigest() != expected_sha):
                raise ValueError("the unchanged file changed before synchronization")
            os.fsync(descriptor)
            if self._stat_identity(after) != self._stat_identity(os.fstat(descriptor)):
                raise ValueError("the unchanged file changed during synchronization")
        finally:
            os.close(descriptor)
        current = os.stat(basename, dir_fd=directory, follow_symlinks=False)
        if self._stat_identity(current) != self._stat_identity(expected):
            raise ValueError("the unchanged file changed before directory synchronization")
        os.fsync(directory)
