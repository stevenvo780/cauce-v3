#!/usr/bin/env python3
"""Unit tests for ops/scripts/issue-alias-token.py against synthetic identity files."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "issue-alias-token.py"
SPEC = importlib.util.spec_from_file_location("issue_alias_token", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _write_json(path: pathlib.Path, document: object, mode: int) -> None:
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    path.chmod(mode)


def _record(alias: str, digest: str) -> dict[str, object]:
    return {
        "token_sha256": digest,
        "expires_at": "2028-01-01T00:00:00Z",
        "principal": {
            "tenant_id": "Steven",
            "alias": alias,
            "session_id": f"adapter-{alias}",
            "channel": "adapter",
            "roles": ["adapter"],
            "permissions": ["route", "read"],
        },
    }


class IssueAliasTokenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cauce-issue-alias-token-")
        self.root = pathlib.Path(self.temp.name)
        self.tokens_dir = self.root / "tokens"
        self.identities_dir = self.root / "identities"
        self.identities_dir.mkdir(mode=0o750)

        self.flota_json = self.root / "flota.json"
        self.flota_json.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "fleet": {
                        "argos": {
                            "tenant": "Steven",
                            "harness": "openclaw",
                            "enabled": True,
                            "container": "ctrl-infra",
                            "home": "/home/claw",
                            "role": "agent",
                            "room": "grp.steven",
                            "user": "claw",
                            "runtimeStateDirectory": "/home/claw/.openclaw/cauce-v3/argos",
                        },
                        "retirado": {
                            "tenant": "Steven",
                            "harness": "codex",
                            "enabled": False,
                            "container": "ctrl-infra",
                            "home": "/home/dev",
                            "role": "agent",
                            "room": "grp.steven",
                            "user": "dev",
                            "runtimeStateDirectory": "/home/dev/.local/state/cauce-v3/retirado",
                        },
                    },
                    "placement": {},
                    "retired": {},
                    "systemPrincipals": {},
                }
            ),
            encoding="utf-8",
        )

        self.token_hashes = self.identities_dir / "token_hashes.json"
        self.mtls_identities = self.identities_dir / "mtls_identities.json"
        _write_json(
            self.token_hashes,
            {"version": 1, "identities": [_record("jarvis", "a" * 64)]},
            0o400,
        )
        _write_json(self.mtls_identities, {"version": 1, "identities": []}, 0o400)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _issue(self, alias: str = "argos", ttl_days: int = 730) -> dict[str, object]:
        return MODULE.issue(alias, self.tokens_dir, self.identities_dir, self.flota_json, ttl_days)

    def test_issues_0400_token_and_matching_hash_record(self) -> None:
        result = self._issue()

        token_path = self.tokens_dir / "argos.token"
        self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o400)
        token_hex = token_path.read_text(encoding="ascii").strip()
        self.assertRegex(token_hex, r"\A[0-9a-f]{64}\Z")

        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(document["version"], 1)
        self.assertEqual(len(document["identities"]), 2)
        self.assertEqual(document["identities"][0]["principal"]["alias"], "jarvis")  # untouched
        new_record = document["identities"][1]
        self.assertEqual(new_record["token_sha256"], hashlib.sha256(token_hex.encode("ascii")).hexdigest())
        self.assertEqual(
            new_record["principal"],
            {
                "tenant_id": "Steven",
                "alias": "argos",
                "session_id": "adapter-argos",
                "channel": "adapter",
                "roles": ["adapter"],
                "permissions": ["route", "read"],
            },
        )
        self.assertEqual(stat.S_IMODE(self.token_hashes.stat().st_mode), 0o400)
        self.assertEqual(result["token_sha256"], new_record["token_sha256"])

    def test_never_touches_mtls_identities_file(self) -> None:
        before = self.mtls_identities.read_bytes()
        self._issue()
        self.assertEqual(self.mtls_identities.read_bytes(), before)

    def test_rejects_disabled_alias_and_writes_nothing(self) -> None:
        with self.assertRaises(MODULE.IssueTokenError):
            self._issue(alias="retirado")
        self.assertFalse(self.tokens_dir.exists())
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

    def test_rejects_unknown_alias(self) -> None:
        with self.assertRaises(MODULE.IssueTokenError):
            self._issue(alias="fantasma")
        self.assertFalse(self.tokens_dir.exists())

    def test_does_not_overwrite_existing_token_file(self) -> None:
        self.tokens_dir.mkdir(mode=0o700)
        existing = self.tokens_dir / "argos.token"
        existing.write_text("pre-existing\n", encoding="ascii")
        existing.chmod(0o400)
        before = existing.read_bytes()

        with self.assertRaises(MODULE.IssueTokenError):
            self._issue()

        self.assertEqual(existing.read_bytes(), before)
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

    def test_atomic_rollback_when_identity_already_registered(self) -> None:
        # An identity for this exact alias/tenant already exists: the JSON insertion step must
        # refuse the duplicate, and the token file already published in this same call must be
        # rolled back so nothing half-applied survives and a retry after revocation can succeed.
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        document["identities"].append(_record("argos", "b" * 64))
        _write_json(self.token_hashes, document, 0o400)
        before = self.token_hashes.read_bytes()

        with self.assertRaises(MODULE.IssueTokenError):
            self._issue()

        self.assertFalse((self.tokens_dir / "argos.token").exists())
        self.assertEqual(self.token_hashes.read_bytes(), before)

    def test_dry_run_leaves_filesystem_untouched(self) -> None:
        message = MODULE.describe_dry_run("argos", self.tokens_dir, self.identities_dir, self.flota_json, 730)
        self.assertIn("dry-run", message)
        self.assertIn("argos", message)
        self.assertFalse(self.tokens_dir.exists())
        document_after = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document_after["identities"]), 1)

    def test_cli_dry_run_exits_zero_and_prints_plan(self) -> None:
        completed = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "argos",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
                "--dry-run",
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("dry-run", completed.stdout)
        self.assertFalse(self.tokens_dir.exists())

    def test_cli_issues_then_second_run_fails_without_overwrite(self) -> None:
        first = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "argos",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(first.returncode, 0, first.stderr)
        token_path = self.tokens_dir / "argos.token"
        self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o400)
        before = token_path.read_bytes()

        second = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "argos",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(second.returncode, 2)
        self.assertIn("issue alias token failed", second.stderr)
        self.assertEqual(token_path.read_bytes(), before)
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 2)  # jarvis (seed) + argos, not tripled

    def test_revoke_removes_hash_and_token_file(self) -> None:
        self._issue()
        token_path = self.tokens_dir / "argos.token"
        self.assertTrue(token_path.exists())
        before = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(before["identities"]), 2)  # jarvis (seed) + argos

        result = MODULE.revoke("argos", self.tokens_dir, self.identities_dir)

        self.assertEqual(result["identities_removed"], 1)
        self.assertTrue(result["token_removed"])
        self.assertFalse(token_path.exists())
        after = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(after["identities"]), 1)
        self.assertEqual(after["identities"][0]["principal"]["alias"], "jarvis")
        self.assertEqual(stat.S_IMODE(self.token_hashes.stat().st_mode), 0o400)

    def test_revoke_is_idempotent(self) -> None:
        self._issue()
        first = MODULE.revoke("argos", self.tokens_dir, self.identities_dir)
        self.assertEqual(first["identities_removed"], 1)
        after_first = json.loads(self.token_hashes.read_text(encoding="utf-8"))

        second = MODULE.revoke("argos", self.tokens_dir, self.identities_dir)

        self.assertEqual(second["identities_removed"], 0)
        self.assertFalse(second["token_removed"])
        after_second = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(after_second, after_first)

    def test_revoke_of_never_issued_alias_is_a_noop(self) -> None:
        result = MODULE.revoke("argos", self.tokens_dir, self.identities_dir)
        self.assertEqual(result["identities_removed"], 0)
        self.assertFalse(result["token_removed"])
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)  # jarvis, untouched

    def test_revoke_does_not_touch_other_alias_records(self) -> None:
        self._issue()
        MODULE.revoke("argos", self.tokens_dir, self.identities_dir)
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual([r["principal"]["alias"] for r in document["identities"]], ["jarvis"])

    def test_revoke_never_touches_mtls_identities_file(self) -> None:
        self._issue()
        before = self.mtls_identities.read_bytes()
        MODULE.revoke("argos", self.tokens_dir, self.identities_dir)
        self.assertEqual(self.mtls_identities.read_bytes(), before)

    def test_revoke_rejects_invalid_alias(self) -> None:
        with self.assertRaises(MODULE.IssueTokenError):
            MODULE.revoke("Not-Valid", self.tokens_dir, self.identities_dir)

    def test_cli_revoke_dry_run_reports_and_leaves_everything_untouched(self) -> None:
        self._issue()
        completed = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--revoke", "--dry-run",
                "--alias", "argos",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("dry-run --revoke", completed.stdout)
        self.assertTrue((self.tokens_dir / "argos.token").exists())
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 2)

    def test_cli_revoke_removes_hash_and_token_then_succeeds_again(self) -> None:
        self._issue()
        first = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--revoke",
                "--alias", "argos",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertFalse((self.tokens_dir / "argos.token").exists())
        document = json.loads(self.token_hashes.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

        second = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--revoke",
                "--alias", "argos",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(second.returncode, 0, second.stderr)

    def test_cli_rejects_unknown_alias_without_leaking_internals(self) -> None:
        completed = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "fantasma",
                "--tokens-dir", str(self.tokens_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("issue alias token failed", completed.stderr)
        self.assertFalse(self.tokens_dir.exists())


if __name__ == "__main__":
    unittest.main()
