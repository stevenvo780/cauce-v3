from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "provision-alertmanager-config.py"
SPEC = importlib.util.spec_from_file_location("provision_alertmanager_config", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProvisionAlertmanagerConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cauce-alertmanager-provision-")
        self.root = pathlib.Path(self.temp.name)
        self.runtime = self.root / "telegram"
        self.secrets = self.root / "alertmanager"
        self.data = self.root / "alertmanager-data"
        self.runtime.mkdir(mode=0o700)
        self.secrets.mkdir(mode=0o700)
        self.data.mkdir(mode=0o700)
        self.token = self.runtime / "kant.token"
        self.token.write_text("synthetic-token\n", encoding="ascii")
        self.token.chmod(0o600)
        self.config = self.runtime / "config.json"
        self._write_config(["123456789", "222222222"], ["123456789", "-333333333"])

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_config(self, users: list[str], chats: list[str], token_file: str = "/run/cauce-telegram/kant.token") -> None:
        document = {"aliases": [{
            "alias": "kant",
            "token_file": token_file,
            "allowed_user_ids": users,
            "allowed_chat_ids": chats,
        }]}
        self.config.write_text(json.dumps(document), encoding="utf-8")
        self.config.chmod(0o600)

    def test_provisions_private_chat_id_and_reuses_existing_token(self) -> None:
        chat_id, token, data, uid, gid = MODULE.provision(
            self.config, self.runtime, "kant", self.secrets, self.data, "123456789"
        )
        self.assertEqual(token, self.token)
        self.assertEqual(data, self.data)
        self.assertEqual((uid, gid), (self.token.stat().st_uid, self.token.stat().st_gid))
        self.assertEqual(stat.S_IMODE(chat_id.stat().st_mode), 0o600)
        self.assertEqual(chat_id.read_text(encoding="ascii"), "123456789\n")

    def test_trusted_origin_disambiguates_multiple_authorized_private_chats(self) -> None:
        self._write_config(
            ["123456789", "222222222"],
            ["123456789", "222222222"],
        )
        chat_id, *_ = MODULE.provision(
            self.config, self.runtime, "kant", self.secrets, self.data, "222222222"
        )
        self.assertEqual(chat_id.read_text(encoding="ascii"), "222222222\n")

    def test_rejects_origin_not_authorized_by_both_allowlists(self) -> None:
        for users, chats in (
            (["123456789"], ["-333333333"]),
            (["123456789"], ["123456789"]),
        ):
            self._write_config(users, chats)
            candidate = "123456789" if "123456789" not in chats else "222222222"
            with self.subTest(users=users, chats=chats), self.assertRaisesRegex(MODULE.ProvisionError, "authorized"):
                MODULE.provision(self.config, self.runtime, "kant", self.secrets, self.data, candidate)

    def test_rejects_permissive_sources_and_token_escape(self) -> None:
        self.config.chmod(0o640)
        with self.assertRaisesRegex(MODULE.ProvisionError, "permissions"):
            MODULE.provision(self.config, self.runtime, "kant", self.secrets, self.data, "123456789")
        self.config.chmod(0o600)
        self.token.chmod(0o644)
        with self.assertRaisesRegex(MODULE.ProvisionError, "permissions"):
            MODULE.provision(self.config, self.runtime, "kant", self.secrets, self.data, "123456789")
        self.token.chmod(0o600)
        self._write_config(["123456789"], ["123456789"], "/tmp/token")
        with self.assertRaisesRegex(MODULE.ProvisionError, "outside"):
            MODULE.provision(self.config, self.runtime, "kant", self.secrets, self.data, "123456789")

    def test_rejects_symlinks_and_repo_output(self) -> None:
        linked = self.root / "linked-config"
        linked.symlink_to(self.config)
        with self.assertRaisesRegex(MODULE.ProvisionError, "regular file"):
            MODULE.provision(linked, self.runtime, "kant", self.secrets, self.data, "123456789")
        with self.assertRaises(MODULE.ProvisionError):
            MODULE.provision(self.config, self.runtime, "kant", MODULE.PROJECT, self.data, "123456789")

    def test_selects_exactly_one_recent_private_origin_without_logging_it(self) -> None:
        completed = subprocess.CompletedProcess([], 0, "123456789\n", "")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as called:
            selected = MODULE._trusted_direct_origin(
                pathlib.Path("/private/database-url"), "Steven", "kant", 24
            )
        self.assertEqual(selected, "123456789")
        command = called.call_args.args[0]
        self.assertIn("-XAtq", command)
        self.assertNotIn("123456789", command)

    def test_rejects_ambiguous_recent_origins_without_echoing_them(self) -> None:
        completed = subprocess.CompletedProcess([], 0, "123456789\n222222222\n", "")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(MODULE.ProvisionError, "exactly one") as raised:
                MODULE._trusted_direct_origin(
                    pathlib.Path("/private/database-url"), "Steven", "kant", 24
                )
        self.assertNotIn("123456789", str(raised.exception))

    def test_container_origin_requires_the_canonical_running_postgres(self) -> None:
        inspect_ok = subprocess.CompletedProcess([], 0, "cauce-v3-prod|postgres|true\n", "")
        query_ok = subprocess.CompletedProcess([], 0, "123456789\n", "")
        with mock.patch.object(MODULE.subprocess, "run", side_effect=[inspect_ok, query_ok]) as called:
            selected = MODULE._trusted_direct_origin_from_container(
                "cauce-v3-prod-postgres-1", "Steven", "kant", 24
            )
        self.assertEqual(selected, "123456789")
        self.assertEqual(called.call_args_list[1].args[0][:3], ["docker", "exec", "-i"])
        self.assertNotIn("123456789", called.call_args_list[1].args[0])

        wrong_service = subprocess.CompletedProcess([], 0, "cauce-v3-prod|gateway|true\n", "")
        with mock.patch.object(MODULE.subprocess, "run", return_value=wrong_service):
            with self.assertRaisesRegex(MODULE.ProvisionError, "canonical production"):
                MODULE._trusted_direct_origin_from_container(
                    "cauce-v3-prod-gateway-1", "Steven", "kant", 24
                )

    def test_cli_emits_only_paths_and_non_secret_ownership(self) -> None:
        arguments = [
            str(SCRIPT),
            "--telegram-config", str(self.config),
            "--telegram-runtime-dir", str(self.runtime),
            "--alias", "kant",
            "--tenant", "Steven",
            "--database-url-file", "/private/database-url",
            "--secret-dir", str(self.secrets),
            "--data-dir", str(self.data),
        ]
        output = io.StringIO()
        with mock.patch.object(sys, "argv", arguments), mock.patch.object(
            MODULE, "_trusted_direct_origin", return_value="123456789"
        ), contextlib.redirect_stdout(output):
            MODULE.main()
        rendered = output.getvalue()
        self.assertNotIn("synthetic-token", rendered)
        self.assertNotIn("123456789", rendered)
        self.assertIn("CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH=", rendered)


if __name__ == "__main__":
    unittest.main()
