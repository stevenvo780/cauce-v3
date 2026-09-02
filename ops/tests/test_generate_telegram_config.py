#!/usr/bin/env python3
"""Unit tests for ops/scripts/generate-telegram-config.py against a synthetic fleet.

Covers the two dataloss failure modes fixed in this module: `--aliases` must fuse into an
existing `--output` (preserving untouched aliases, `chats`/`bot_username` included) instead of
replacing it, and writing the placeholder sentinel over an alias that already has real ids at
`--output` must fail closed unless `--allow-placeholders` is given explicitly.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "generate-telegram-config.py"
SPEC = importlib.util.spec_from_file_location("generate_telegram_config", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SENTINEL_USER = [MODULE.PLACEHOLDER_USER_ID]
SENTINEL_CHAT = [MODULE.PLACEHOLDER_CHAT_ID]


def _write_container_aliases(root: pathlib.Path, aliases: dict[str, str]) -> None:
    """aliases: {alias: tenant}. Fixed room/harness, distinct per-alias container/user/home."""
    document = {
        "schemaVersion": 2,
        "systemPrincipals": {},
        "historicalAliases": {},
        "aliases": {
            alias: {
                "tenant": tenant,
                "room": f"grp.{tenant.lower()}",
                "container": alias,
                "user": alias,
                "home": f"/home/{alias}",
                "stateDirectory": f"/home/{alias}/.state",
                "harness": "claude",
                "membershipRole": "agent",
                "systemdUser": alias,
            }
            for alias, tenant in aliases.items()
        },
    }
    (root / "container-aliases.json").write_text(json.dumps(document), encoding="utf-8")


def _write_json(path: pathlib.Path, document: object) -> None:
    path.write_text(json.dumps(document), encoding="utf-8")


def _run(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = MODULE.main(argv)
    return code, out.getvalue(), err.getvalue()


class FixtureTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ops_dir = pathlib.Path(self._tmp.name) / "ops"
        self.ops_dir.mkdir()
        _write_container_aliases(self.ops_dir, {"argos": "Steven", "atlas": "Miguel"})
        self.dest = pathlib.Path(self._tmp.name) / "config.json"

    def base_argv(self, *extra: str) -> list[str]:
        return ["--ops-dir", str(self.ops_dir), "--no-cross-check", "--output", str(self.dest), *extra]

    def allowlist_file(self, alias: str, user_id: str, chat_id: str) -> str:
        path = pathlib.Path(self._tmp.name) / f"allowlist-{alias}.json"
        _write_json(path, {"aliases": {alias: {"user_ids": [user_id], "chat_ids": [chat_id]}}})
        return str(path)


class MergeWithAliasesTests(FixtureTestCase):
    def test_merge_preserves_untouched_alias_including_chats_and_bot_username(self) -> None:
        groups_path = pathlib.Path(self._tmp.name) / "groups.json"
        _write_json(
            groups_path,
            {
                "bot_usernames": {"argos": "ArgosBotHandle"},
                "aliases": {"argos": {"chats": [{"chat_id": "-222", "mode": "mention"}]}},
            },
        )
        code, _, err = _run(
            self.base_argv(
                "--aliases", "argos",
                "--allowlist-file", self.allowlist_file("argos", "111", "-222"),
                "--groups-file", str(groups_path),
            )
        )
        self.assertEqual(code, 0, err)
        argos_after_first_call = json.loads(self.dest.read_text(encoding="utf-8"))["aliases"][0]
        self.assertEqual(argos_after_first_call["alias"], "argos")
        self.assertEqual(argos_after_first_call["bot_username"], "ArgosBotHandle")
        self.assertEqual([c["chat_id"] for c in argos_after_first_call["chats"]], ["-222"])

        # Second call only lists atlas. Without the merge fix this would replace the whole
        # file and drop argos (and its chats/bot_username) entirely.
        code, _, err = _run(
            self.base_argv("--aliases", "atlas", "--allowlist-file", self.allowlist_file("atlas", "333", "-444"))
        )
        self.assertEqual(code, 0, err)

        document = json.loads(self.dest.read_text(encoding="utf-8"))
        self.assertEqual([row["alias"] for row in document["aliases"]], ["argos", "atlas"])
        argos_after_second_call = document["aliases"][0]
        self.assertEqual(argos_after_second_call, argos_after_first_call)
        atlas_row = document["aliases"][1]
        self.assertEqual(atlas_row["allowed_user_ids"], ["333"])
        self.assertEqual(atlas_row["allowed_chat_ids"], ["-444"])
        self.assertNotIn("chats", atlas_row)
        self.assertNotIn("bot_username", atlas_row)


class SentinelRegressionTests(FixtureTestCase):
    def _seed_real_argos(self) -> str:
        code, _, err = _run(
            self.base_argv("--aliases", "argos", "--allowlist-file", self.allowlist_file("argos", "111", "-222"))
        )
        self.assertEqual(code, 0, err)
        return self.dest.read_text(encoding="utf-8")

    def test_sentinel_over_real_ids_fails_closed_without_allow_placeholders(self) -> None:
        before = self._seed_real_argos()
        code, _, err = _run(self.base_argv("--aliases", "argos"))  # no allowlist -> defaults to sentinel
        self.assertEqual(code, 2)
        self.assertIn("refusing to overwrite real allowed_user_ids", err)
        self.assertIn("argos", err)
        self.assertIn("--allow-placeholders", err)
        # Fail closed means nothing was written, not even a partial file.
        self.assertEqual(self.dest.read_text(encoding="utf-8"), before)

    def test_allow_placeholders_forces_the_overwrite(self) -> None:
        self._seed_real_argos()
        code, _, err = _run(self.base_argv("--aliases", "argos", "--allow-placeholders"))
        self.assertEqual(code, 0, err)
        row = json.loads(self.dest.read_text(encoding="utf-8"))["aliases"][0]
        self.assertEqual(row["allowed_user_ids"], SENTINEL_USER)
        self.assertEqual(row["allowed_chat_ids"], SENTINEL_CHAT)

    def test_full_regenerate_without_aliases_also_fails_closed(self) -> None:
        # The dataloss bug this fixes is not scoped to --aliases: a plain re-run over a live
        # config.json must not silently deny real traffic for an alias either.
        before = self._seed_real_argos()
        code, _, err = _run(self.base_argv())  # default selection = the whole fixture fleet
        self.assertEqual(code, 2)
        self.assertIn("refusing to overwrite real allowed_user_ids", err)
        self.assertEqual(self.dest.read_text(encoding="utf-8"), before)

    def test_new_alias_with_no_prior_real_ids_is_not_a_regression(self) -> None:
        self._seed_real_argos()
        code, _, err = _run(self.base_argv("--aliases", "atlas"))  # atlas has no existing entry
        self.assertEqual(code, 0, err)
        aliases = {row["alias"]: row for row in json.loads(self.dest.read_text(encoding="utf-8"))["aliases"]}
        self.assertEqual(aliases["atlas"]["allowed_user_ids"], SENTINEL_USER)
        self.assertEqual(aliases["argos"]["allowed_user_ids"], ["111"])  # untouched, still real

    def test_reuse_existing_allowlist_carries_real_ids_forward_without_failing(self) -> None:
        self._seed_real_argos()
        code, _, err = _run(self.base_argv("--aliases", "argos", "--reuse-existing-allowlist"))
        self.assertEqual(code, 0, err)
        row = json.loads(self.dest.read_text(encoding="utf-8"))["aliases"][0]
        self.assertEqual(row["allowed_user_ids"], ["111"])
        self.assertEqual(row["allowed_chat_ids"], ["-222"])


class CheckNoSentinelRegressionUnitTests(unittest.TestCase):
    def test_flags_user_ids_regression_independently_of_chat_ids(self) -> None:
        existing = {"argos": {"allowed_user_ids": ["111"], "allowed_chat_ids": SENTINEL_CHAT}}
        new_row = {"alias": "argos", "allowed_user_ids": SENTINEL_USER, "allowed_chat_ids": SENTINEL_CHAT}
        with self.assertRaises(MODULE.merge_lib.MergeError) as ctx:
            MODULE.merge_lib.check_no_sentinel_regression(existing, [new_row], pathlib.Path("config.json"), False)
        self.assertIn("allowed_user_ids", str(ctx.exception))

    def test_allow_placeholders_bypasses_the_check(self) -> None:
        existing = {"argos": {"allowed_user_ids": ["111"], "allowed_chat_ids": ["-222"]}}
        new_row = {"alias": "argos", "allowed_user_ids": SENTINEL_USER, "allowed_chat_ids": SENTINEL_CHAT}
        MODULE.merge_lib.check_no_sentinel_regression(existing, [new_row], pathlib.Path("config.json"), True)  # no raise

    def test_repeating_the_same_real_ids_is_not_a_regression(self) -> None:
        existing = {"argos": {"allowed_user_ids": ["111"], "allowed_chat_ids": ["-222"]}}
        new_row = {"alias": "argos", "allowed_user_ids": ["111"], "allowed_chat_ids": ["-222"]}
        MODULE.merge_lib.check_no_sentinel_regression(existing, [new_row], pathlib.Path("config.json"), False)  # no raise

    def test_unknown_alias_in_existing_document_is_not_touched(self) -> None:
        existing = {"argos": {"allowed_user_ids": ["111"], "allowed_chat_ids": ["-222"]}}
        new_row = {"alias": "atlas", "allowed_user_ids": SENTINEL_USER, "allowed_chat_ids": SENTINEL_CHAT}
        MODULE.merge_lib.check_no_sentinel_regression(existing, [new_row], pathlib.Path("config.json"), False)  # no raise


class MergeIntoExistingUnitTests(unittest.TestCase):
    def test_preserves_row_order_and_appends_new_aliases_sorted(self) -> None:
        existing_by_alias = {"atlas": {"alias": "atlas", "marker": "old-atlas"}, "argos": {"alias": "argos", "marker": "old-argos"}}
        new_rows = [
            {"alias": "argos", "marker": "new-argos"},
            {"alias": "zeta", "marker": "new-zeta"},
            {"alias": "beta", "marker": "new-beta"},
        ]
        merged = MODULE.merge_lib.merge_into_existing(existing_by_alias, new_rows, {"argos", "zeta", "beta"})
        self.assertEqual(
            [(row["alias"], row["marker"]) for row in merged["aliases"]],
            [("atlas", "old-atlas"), ("argos", "new-argos"), ("beta", "new-beta"), ("zeta", "new-zeta")],
        )

    def test_rejects_a_malformed_existing_document(self) -> None:
        with self.assertRaises(MODULE.merge_lib.MergeError):
            MODULE.merge_lib.existing_rows_by_alias({"aliases": "not-a-list"}, pathlib.Path("c.json"))

    def test_rejects_a_duplicate_alias_in_the_existing_document(self) -> None:
        existing = {"aliases": [{"alias": "argos"}, {"alias": "argos"}]}
        with self.assertRaises(MODULE.merge_lib.MergeError):
            MODULE.merge_lib.existing_rows_by_alias(existing, pathlib.Path("c.json"))


if __name__ == "__main__":
    unittest.main()
