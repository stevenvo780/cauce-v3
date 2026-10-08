from __future__ import annotations

import hashlib
import json
import os
import pathlib
import stat
import tempfile
import threading
import unittest
import uuid
from unittest import mock

from cauce_pty_agent import agent as pty_agent
from cauce_pty_agent import framing
from cauce_pty_agent.governance_write_journal import (
    GovernanceWriteJournal,
    JournalConflict,
    JournalIdentityError,
)


class GovernanceWriteJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        os.chmod(self.temporary.name, 0o700)
        self.root = pathlib.Path(self.temporary.name)
        self.identity = {
            "tenant_id": "tenant-a",
            "alias": "agent-a",
            "container_id": "container-a",
            "generation": "generation-a",
        }
        self.writer_instance_id = str(uuid.uuid4())
        self.journal = GovernanceWriteJournal(
            str(self.root), self.identity, self.writer_instance_id,
        )
        self.journals = [self.journal]
        self.descriptor = {
            "operation_id": str(uuid.uuid4()),
            "operation_token": str(uuid.uuid4()),
            "operation_generation": str(uuid.uuid4()),
            "request_id": None,
            "runtime_generation": self.identity["generation"],
        }
        self.descriptor["request_id"] = self.descriptor["operation_id"]
        self.entries = [{
            "mode": "write",
            "path": "/home/agent-a/.config/AGENTS.md",
            "operation": "replace",
            "expected_sha": "c" * 64,
            "content_sha": "b" * 64,
            "bytes": 42,
        }]

    def tearDown(self) -> None:
        for journal in self.journals:
            journal.close()
        self.temporary.cleanup()

    def test_begin_fsyncs_private_writing_record_before_any_effect(self) -> None:
        receipt = self.journal.begin(self.descriptor, self.entries)

        status = self.journal.status(self.descriptor)
        record = self.root / f"{self.descriptor['operation_id']}.json"
        self.assertEqual(status.state, "writing")
        self.assertEqual(status.writer_instance_id, self.writer_instance_id)
        self.assertTrue(record.is_file())
        self.assertEqual(stat_mode(record), 0o600)
        self.assertNotIn(self.descriptor["operation_token"], record.read_text())
        self.assertEqual(receipt.operation_id, self.descriptor["operation_id"])

    def test_done_is_available_only_after_explicit_terminal_commit(self) -> None:
        receipt = self.journal.begin(self.descriptor, self.entries)
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

        result = [{
            "path": self.entries[0]["path"], "operation": "replace",
            "sha": self.entries[0]["content_sha"], "bytes": self.entries[0]["bytes"],
        }]
        self.journal.complete(receipt, result)

        status = self.journal.status(self.descriptor)
        self.assertEqual(status.state, "done")
        self.assertEqual(status.entries, tuple(result))

    def test_wrong_token_request_or_runtime_identity_is_unknown(self) -> None:
        self.journal.begin(self.descriptor, self.entries)
        wrong_values = (
            {**self.descriptor, "operation_token": "c" * 64},
            {**self.descriptor, "request_id": str(uuid.uuid4())},
            {**self.descriptor, "runtime_generation": "generation-b"},
            {**self.descriptor, "tenant_id": "tenant-b"},
            {**self.descriptor, "alias": "agent-b"},
            {**self.descriptor, "container_id": "container-b"},
        )

        for descriptor in wrong_values:
            with self.subTest(descriptor=descriptor):
                self.assertEqual(self.journal.status(descriptor).state, "unknown")

    def test_duplicate_operation_cannot_replace_a_writing_receipt(self) -> None:
        self.journal.begin(self.descriptor, self.entries)

        with self.assertRaises(JournalConflict):
            self.journal.begin(self.descriptor, self.entries)

        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

    def test_restart_does_not_reassign_or_terminalize_old_writer(self) -> None:
        old_receipt = self.journal.begin(self.descriptor, self.entries)
        restarted = GovernanceWriteJournal(
            str(self.root), self.identity, str(uuid.uuid4()),
        )
        self.journals.append(restarted)

        self.assertEqual(restarted.status(self.descriptor).state, "unknown")
        with self.assertRaises(JournalIdentityError):
            restarted.complete(old_receipt, self.entries)
        self.assertEqual(restarted.status(self.descriptor).state, "unknown")

    def test_mismatched_result_cannot_be_marked_done(self) -> None:
        receipt = self.journal.begin(self.descriptor, self.entries)
        wrong_result = [{**self.entries[0], "sha256": "d" * 64}]

        with self.assertRaises(JournalIdentityError):
            self.journal.complete(receipt, wrong_result)

        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

    def test_symlinked_journal_directory_is_rejected(self) -> None:
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)

        with self.assertRaises(JournalIdentityError):
            GovernanceWriteJournal(
                str(link), self.identity, str(uuid.uuid4()),
            )

    def test_quiescence_feature_is_only_advertised_with_validated_journal(self) -> None:
        instance = pty_agent.PtyAgent.__new__(pty_agent.PtyAgent)
        config = self.root / ".claude"
        config.mkdir(mode=0o700)
        instance.bundle = {"home": str(self.root), "harness": "claude", "runtime_uid": os.geteuid(),
                           "runtime_facts": {"claude_config_dir": str(config)}}
        instance.governance_write_journal = None
        self.assertNotIn("write_quiescence_v1", instance._features())
        self.assertNotIn("native_admin_v1", instance._features())
        instance.governance_write_journal = self.journal
        self.assertIn("write_quiescence_v1", instance._features())
        self.assertIn("native_admin_v1", instance._features())
        instance.bundle["runtime_uid"] = os.geteuid() + 1
        self.assertNotIn("native_admin_v1", instance._features())
        self.assertIn("write_quiescence_v1", instance._features())

    def test_incomplete_descriptor_or_invalid_entry_is_rejected_before_record(self) -> None:
        incomplete = {**self.descriptor, "runtime_generation": "wrong"}
        wrong_request = {**self.descriptor, "request_id": str(uuid.uuid4())}
        invalid_entries = [[{**self.entries[0], "path": "/home/agent-a/../outside"}]]

        with self.assertRaises(JournalIdentityError):
            self.journal.begin(incomplete, self.entries)
        with self.assertRaises(JournalIdentityError):
            self.journal.begin(wrong_request, self.entries)
        with self.assertRaises(JournalIdentityError):
            self.journal.begin(self.descriptor, invalid_entries[0])
        self.assertFalse((self.root / f"{self.descriptor['operation_id']}.json").exists())


class GovernanceWriteJournalIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        os.chmod(self.temporary.name, 0o700)
        self.root = pathlib.Path(self.temporary.name)
        self.home = self.root / "home"
        self.config = self.home / ".claude"
        self.config.mkdir(parents=True)
        self.journal_dir = self.root / "journal"
        self.journal_dir.mkdir(mode=0o700)
        self.identity = {
            "tenant_id": "tenant-a",
            "alias": "agent-a",
            "container_id": "container-a",
            "generation": "generation-a",
        }
        self.writer_instance_id = str(uuid.uuid4())
        self.journal = GovernanceWriteJournal(
            str(self.journal_dir), self.identity, self.writer_instance_id,
        )
        self.journals = [self.journal]
        self.instance = pty_agent.PtyAgent.__new__(pty_agent.PtyAgent)
        self.instance.identity = self.identity
        self.instance.bundle = {}
        self.instance.bundle = {
            "home": str(self.home),
            "harness": "claude",
            "runtime_facts": {"claude_config_dir": str(self.config)},
            "tenant_id": self.identity["tenant_id"],
            "alias": self.identity["alias"],
            "container_id": self.identity["container_id"],
            "generation": self.identity["generation"],
        }
        self.instance.pending_writes = {}
        self.instance.pending_write_batches = {}
        self.instance.outbound = bytearray()
        self.instance.governance_write_journal = self.journal
        self.instance.writer_instance_id = self.writer_instance_id
        self.request_id = str(uuid.uuid4())
        self.operation_id = str(uuid.uuid4())
        self.operation_token = str(uuid.uuid4())
        self.descriptor = {
            "operation_id": self.operation_id,
            "operation_token": self.operation_token,
            "operation_generation": str(uuid.uuid4()),
            "request_id": self.operation_id,
            "runtime_generation": self.identity["generation"],
        }
        self.request_id = self.operation_id
        self.path = str(self.config / "CLAUDE.md")
        pathlib.Path(self.path).write_bytes(b"before")
        self.content = b"after"

    def tearDown(self) -> None:
        for journal in self.journals:
            journal.close()
        self.temporary.cleanup()

    def test_real_batch_stays_writing_while_filesystem_replace_is_paused(self) -> None:
        pathlib.Path(self.path).write_bytes(b"before")
        entered = threading.Event()
        resume = threading.Event()
        real_replace = os.replace
        errors: list[BaseException] = []

        def paused_replace(*args, **kwargs):
            entered.set()
            if not resume.wait(5):
                raise TimeoutError("test barrier timed out")
            return real_replace(*args, **kwargs)

        def write_batch() -> None:
            try:
                with mock.patch.object(pty_agent.os, "replace", side_effect=paused_replace):
                    self._send_batch(paused_replace)
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=write_batch, daemon=True)
        thread.start()
        self.assertTrue(entered.wait(5), f"writer did not reach the real replace barrier: {errors!r}")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), b"before")
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")
        try:
            self.instance._on_write_status(self._status_request())
            status_tag, status = self._take_frame()
            self.assertEqual(status_tag, framing.TAG_WRITE_STATUS_OK)
            self.assertEqual(status["state"], "writing")
            self.assertNotIn("operation_token", status)

            self.instance._on_write_batch_cancel({"request_id": self.request_id})
            self.assertEqual(self.journal.status(self.descriptor).state, "writing")
        finally:
            resume.set()
        thread.join(5)
        self.assertFalse(thread.is_alive(), "writer did not leave the filesystem barrier")
        self.assertEqual(errors, [])
        self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
        self.assertEqual(self.journal.status(self.descriptor).state, "done")
        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_OK)
        self.assertEqual(response["receipt"]["operation_generation"], self.descriptor["operation_generation"])
        self.assertEqual(response["receipt"]["writer_instance_id"], self.writer_instance_id)
        self.assertNotIn("operation_token", response["receipt"])
        self.assertEqual(set(response["receipt"]["files"][0]), {"path", "sha", "bytes"})
        self.assertEqual(set(response["files"][0]), {"path", "operation", "sha", "bytes"})

    def test_journal_terminal_record_is_written_after_batch_cleanup(self) -> None:
        completed = []
        original_complete = self.journal.complete

        def check_complete(receipt, entries):
            self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
            self.assertEqual(list(self.config.glob(".cauce-profile-*.bak")), [])
            self.assertEqual(list(self.config.glob(".cauce-profile-*.tmp")), [])
            completed.append(True)
            return original_complete(receipt, entries)

        self.journal.complete = check_complete
        self._send_batch(os.replace)

        self.assertEqual(completed, [True])
        self.assertEqual(self.journal.status(self.descriptor).state, "done")
        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_OK)
        self.assertEqual(response["receipt"]["state"], "done")

    def test_single_write_receipt_uses_store_request_id_and_no_token(self) -> None:
        content_sha = hashlib.sha256(self.content).hexdigest()
        self.instance._on_write({
            **self.descriptor,
            "path": self.path,
            "operation": "replace",
            "expected_sha": hashlib.sha256(b"before").hexdigest(),
            "content_sha": content_sha,
            "bytes": len(self.content),
            "chunks": 1,
        })
        self.instance._on_write_data(self.request_id, self.content)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_OK)
        receipt = response["receipt"]
        self.assertEqual(receipt["request_id"], self.operation_id)
        self.assertEqual(receipt["operation_id"], self.operation_id)
        self.assertEqual(receipt["files"][0]["sha"], content_sha)
        self.assertEqual(set(receipt["files"][0]), {"path", "sha", "bytes"})
        self.assertNotIn("operation_token", receipt)
        self.assertEqual(self.journal.status(self.descriptor).state, "done")

    def test_operation_without_configured_journal_is_rejected_before_file_effect(self) -> None:
        self.instance.governance_write_journal = None
        self.instance.writer_instance_id = None

        self._send_batch(os.replace)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_ERR)
        self.assertEqual(response["error"], "unavailable")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), b"before")
        self.assertEqual(list(self.config.glob(".cauce-profile-*")), [])

    def test_restarted_writer_reports_prior_operation_unknown(self) -> None:
        self._send_batch(os.replace)
        self._take_frame()
        restarted_id = str(uuid.uuid4())
        self.instance.writer_instance_id = restarted_id
        self.instance.governance_write_journal = GovernanceWriteJournal(
            str(self.journal_dir), self.identity, restarted_id,
        )
        self.journals.append(self.instance.governance_write_journal)

        self.instance._on_write_status(self._status_request())

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_STATUS_OK)
        self.assertEqual(response["state"], "unknown")
        self.assertEqual(response["writer_instance_id"], restarted_id)
        self.assertEqual(response["files"], [])

    def test_status_done_receipt_uses_only_the_physical_file_projection(self) -> None:
        self._send_batch(os.replace)
        self._take_frame()

        self.instance._on_write_status(self._status_request())

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_STATUS_OK)
        self.assertEqual(response["state"], "done")
        self.assertEqual(set(response["files"][0]), {"path", "sha", "bytes"})

    def test_cleanup_fsync_failure_keeps_operation_nonterminal(self) -> None:
        real_unlink = os.unlink
        real_fsync = os.fsync
        backup_removed = False

        def track_unlink(path, *args, **kwargs):
            nonlocal backup_removed
            result = real_unlink(path, *args, **kwargs)
            if isinstance(path, str) and path.endswith(".bak"):
                backup_removed = True
            return result

        def fail_cleanup_fsync(descriptor):
            if backup_removed and stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError("injected cleanup directory fsync failure")
            return real_fsync(descriptor)

        with mock.patch.object(pty_agent.os, "unlink", side_effect=track_unlink), \
                mock.patch.object(pty_agent.os, "fsync", side_effect=fail_cleanup_fsync):
            self._send_batch(os.replace)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_ERR)
        self.assertEqual(response["error"], "unknown")
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
        self.assertEqual(list(self.config.glob(".cauce-profile-*.bak")), [])

    def test_durable_batch_rechecks_replace_precondition_before_unchanged(self) -> None:
        pathlib.Path(self.path).write_bytes(self.content)

        self._send_batch(os.replace)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_ERR)
        self.assertEqual(response["error"], "conflict")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

    def test_durable_batch_rejects_create_when_matching_bytes_already_exist(self) -> None:
        pathlib.Path(self.path).write_bytes(self.content)
        entry = {
            "path": self.path,
            "mode": "write",
            "operation": "create",
            "expected_sha": None,
            "content_sha": hashlib.sha256(self.content).hexdigest(),
            "bytes": len(self.content),
            "chunks": 1,
        }
        self.instance._on_write_batch({**self.descriptor, "entries": [entry]})
        self.instance._on_write_batch_data(self.request_id, self.content)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_ERR)
        self.assertEqual(response["error"], "conflict")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

    def test_durable_single_rechecks_replace_precondition_before_unchanged(self) -> None:
        pathlib.Path(self.path).write_bytes(self.content)
        self.instance._on_write({
            **self.descriptor,
            "path": self.path,
            "operation": "replace",
            "expected_sha": hashlib.sha256(b"before").hexdigest(),
            "content_sha": hashlib.sha256(self.content).hexdigest(),
            "bytes": len(self.content),
            "chunks": 1,
        })
        self.instance._on_write_data(self.request_id, self.content)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_ERR)
        self.assertEqual(response["error"], "conflict")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

    def test_durable_single_rejects_create_when_matching_bytes_already_exist(self) -> None:
        pathlib.Path(self.path).write_bytes(self.content)
        self.instance._on_write({
            **self.descriptor,
            "path": self.path,
            "operation": "create",
            "expected_sha": None,
            "content_sha": hashlib.sha256(self.content).hexdigest(),
            "bytes": len(self.content),
            "chunks": 1,
        })
        self.instance._on_write_data(self.request_id, self.content)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_ERR)
        self.assertEqual(response["error"], "conflict")
        self.assertEqual(pathlib.Path(self.path).read_bytes(), self.content)
        self.assertEqual(self.journal.status(self.descriptor).state, "writing")

    def test_durable_batch_synchronizes_a_preconditioned_unchanged_file(self) -> None:
        pathlib.Path(self.path).write_bytes(self.content)
        entry = {
            "path": self.path,
            "mode": "write",
            "operation": "replace",
            "expected_sha": hashlib.sha256(self.content).hexdigest(),
            "content_sha": hashlib.sha256(self.content).hexdigest(),
            "bytes": len(self.content),
            "chunks": 1,
        }
        real_fsync = os.fsync
        synced_modes = []

        def record_fsync(descriptor):
            synced_modes.append("directory" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file")
            return real_fsync(descriptor)

        with mock.patch.object(pty_agent.os, "fsync", side_effect=record_fsync):
            self.instance._on_write_batch({**self.descriptor, "entries": [entry]})
            self.instance._on_write_batch_data(self.request_id, self.content)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_BATCH_OK)
        self.assertEqual(response["files"][0]["operation"], "unchanged")
        self.assertEqual(self.journal.status(self.descriptor).state, "done")
        self.assertIn("file", synced_modes)
        self.assertIn("directory", synced_modes)

    def test_durable_single_synchronizes_a_preconditioned_unchanged_file(self) -> None:
        pathlib.Path(self.path).write_bytes(self.content)
        self.instance._on_write({
            **self.descriptor,
            "path": self.path,
            "operation": "replace",
            "expected_sha": hashlib.sha256(self.content).hexdigest(),
            "content_sha": hashlib.sha256(self.content).hexdigest(),
            "bytes": len(self.content),
            "chunks": 1,
        })
        real_fsync = os.fsync
        synced_modes = []

        def record_fsync(descriptor):
            synced_modes.append("directory" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file")
            return real_fsync(descriptor)

        with mock.patch.object(pty_agent.os, "fsync", side_effect=record_fsync):
            self.instance._on_write_data(self.request_id, self.content)

        tag, response = self._take_frame()
        self.assertEqual(tag, framing.TAG_WRITE_OK)
        self.assertEqual(response["operation"], "replace")
        self.assertEqual(self.journal.status(self.descriptor).state, "done")
        self.assertEqual(self.journal.status(self.descriptor).entries[0]["operation"], "unchanged")
        self.assertIn("file", synced_modes)
        self.assertIn("directory", synced_modes)

    def _send_batch(self, replace) -> None:
        entry = {
            "path": self.path,
            "mode": "write",
            "operation": "replace",
            "expected_sha": hashlib.sha256(b"before").hexdigest(),
            "content_sha": hashlib.sha256(self.content).hexdigest(),
            "bytes": len(self.content),
            "chunks": 1,
        }
        self.instance._on_write_batch({
            **self.descriptor,
            "entries": [entry],
        })
        self.instance._on_write_batch_data(self.request_id, self.content)

    def _status_request(self) -> dict[str, str]:
        return {
            **self.descriptor,
            "tenant_id": self.identity["tenant_id"],
            "alias": self.identity["alias"],
            "container_id": self.identity["container_id"],
        }

    def _take_frame(self):
        frames = pty_agent.FrameDecoder().feed(bytes(self.instance.outbound))
        self.instance.outbound.clear()
        self.assertEqual(len(frames), 1)
        tag, payload = frames[0]
        return tag, json.loads(payload.decode("utf-8"))


def stat_mode(path: pathlib.Path) -> int:
    return path.stat().st_mode & 0o777


if __name__ == "__main__":
    unittest.main()
