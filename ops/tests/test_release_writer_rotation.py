from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


OPS = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = OPS / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "release_writer_state", SCRIPTS / "release-writer-state.py"
)
assert SPEC is not None and SPEC.loader is not None
WRITER_STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WRITER_STATE)


def unit(alias: str, family: str, scope: str, *, active: bool = False) -> dict[str, object]:
    prefix = "alias" if family == "host-native" else "container"
    return {
        "activeState": "active" if active else "inactive",
        "family": family,
        "fragmentSha256": f"sha256:{'a' * 64}",
        "loadState": "loaded",
        "mainPid": 123 if active else 0,
        "name": f"cauce-v3-{prefix}-{alias}.service",
        "scope": scope,
        "subState": "running" if active else "dead",
        "unitFileState": "enabled" if active else "disabled",
    }


def alias_row(alias: str, *, active_family: str | None = None) -> dict[str, object]:
    families = (
        ("host-native", "system"),
        ("container-system", "system"),
        ("container-rootless", "user"),
    )
    return {
        "alias": alias,
        "host": "local",
        "leaseActive": active_family is not None,
        "systemdUser": "stev",
        "tenant": "Steven",
        "units": [
            unit(alias, family, scope, active=family == active_family)
            for family, scope in families
        ],
    }


def snapshot(*, zeus_active: bool, kant_active: bool = True) -> dict[str, object]:
    compose = ["terminal-relay"]
    aliases = [
        alias_row("kant", active_family="container-rootless" if kant_active else None),
        alias_row("zeus", active_family="host-native" if zeus_active else None),
    ]
    return {
        "aliases": aliases,
        "composeWriters": compose,
        "kind": "cauce-v3-release-writer-snapshot",
        "manifestSha256": f"sha256:{'b' * 64}",
        "schemaVersion": 2,
        "writersExpectedCandidate": len(compose) + int(kant_active) + int(zeus_active),
    }


class ZeusWriterRotationTest(unittest.TestCase):
    def test_accepts_only_the_single_zeus_inactive_to_active_delta(self) -> None:
        WRITER_STATE.validate_zeus_activation_rotation(
            snapshot(zeus_active=False), snapshot(zeus_active=True)
        )

    def test_rejects_old_snapshot_that_does_not_prove_zeus_inactive(self) -> None:
        with self.assertRaisesRegex(
            WRITER_STATE.WriterStateError, "does not prove Zeus inactive"
        ):
            WRITER_STATE.validate_zeus_activation_rotation(
                snapshot(zeus_active=True), snapshot(zeus_active=True)
            )

    def test_rejects_any_other_active_set_or_compose_drift(self) -> None:
        changed_alias = snapshot(zeus_active=True, kant_active=False)
        with self.assertRaisesRegex(
            WRITER_STATE.WriterStateError, "outside Zeus"
        ):
            WRITER_STATE.validate_zeus_activation_rotation(
                snapshot(zeus_active=False), changed_alias
            )

        changed_compose = snapshot(zeus_active=True)
        changed_compose["composeWriters"] = ["relay-worker"]
        with self.assertRaisesRegex(
            WRITER_STATE.WriterStateError, "Compose writer active set"
        ):
            WRITER_STATE.validate_zeus_activation_rotation(
                snapshot(zeus_active=False), changed_compose
            )

    def test_idempotent_selected_retry_still_requires_zeus_active(self) -> None:
        WRITER_STATE.validate_zeus_activation_rotation(None, snapshot(zeus_active=True))
        with self.assertRaisesRegex(
            WRITER_STATE.WriterStateError, "does not prove Zeus active"
        ):
            WRITER_STATE.validate_zeus_activation_rotation(
                None, snapshot(zeus_active=False)
            )

    def test_snapshot_publication_is_create_only_but_accepts_identical_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination = root / "zeus-active.json"
            first = (json.dumps({}, separators=(",", ":")) + "\n").encode()
            different = (json.dumps({"drift": True}, separators=(",", ":")) + "\n").encode()
            with mock.patch.object(WRITER_STATE, "validate_snapshot"):
                digest = WRITER_STATE.publish_snapshot(destination, first, OPS)
                self.assertEqual(
                    WRITER_STATE.publish_snapshot(
                        destination, first, OPS, allow_identical=True
                    ),
                    digest,
                )
                with self.assertRaisesRegex(
                    WRITER_STATE.WriterStateError, "differs from the retry candidate"
                ):
                    WRITER_STATE.publish_snapshot(
                        destination, different, OPS, allow_identical=True
                    )
                with self.assertRaisesRegex(
                    WRITER_STATE.WriterStateError, "already exists"
                ):
                    WRITER_STATE.publish_snapshot(destination, first, OPS)

    def test_snapshot_publication_does_not_remove_a_competing_create(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination = root / "zeus-active.json"
            candidate = (json.dumps({}, separators=(",", ":")) + "\n").encode()
            competing = (
                json.dumps({"winner": "other"}, separators=(",", ":")) + "\n"
            ).encode()

            def competing_link(
                _source: pathlib.Path,
                target: pathlib.Path,
                *,
                follow_symlinks: bool,
            ) -> None:
                self.assertFalse(follow_symlinks)
                target.write_bytes(competing)
                raise FileExistsError

            with (
                mock.patch.object(WRITER_STATE, "validate_snapshot"),
                mock.patch.object(WRITER_STATE.os, "link", side_effect=competing_link),
            ):
                with self.assertRaises(FileExistsError):
                    WRITER_STATE.publish_snapshot(destination, candidate, OPS)

            self.assertEqual(destination.read_bytes(), competing)

    def test_snapshot_publication_does_not_remove_a_post_link_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination = root / "zeus-active.json"
            candidate = (json.dumps({}, separators=(",", ":")) + "\n").encode()
            competing = (
                json.dumps({"winner": "replacement"}, separators=(",", ":")) + "\n"
            ).encode()

            def replace_after_link(
                path: pathlib.Path,
                *,
                label: str,
            ) -> bytes:
                self.assertEqual(label, "published writer snapshot")
                path.unlink()
                path.write_bytes(competing)
                return competing

            with (
                mock.patch.object(WRITER_STATE, "validate_snapshot"),
                mock.patch.object(
                    WRITER_STATE, "private_file", side_effect=replace_after_link
                ),
            ):
                with self.assertRaisesRegex(
                    WRITER_STATE.WriterStateError,
                    "differs after atomic read-back",
                ):
                    WRITER_STATE.publish_snapshot(destination, candidate, OPS)

            self.assertEqual(destination.read_bytes(), competing)


if __name__ == "__main__":
    unittest.main()
