#!/usr/bin/env python3
"""Tests for ops/scripts/generate-telegram-config.py (gaps G1/G2/G3).

Validates that the generated Telegram bridge config matches the shape enforced by
services/telegram-bridge/src/config.ts, covering the subset (canary) path, the
unknown-alias failure, the runtime-dir path defaults (which must match the compose
mount), the single self-recipient invariant, and the ids-only allowlist file. Core tests
use a hermetic synthetic fleet (independent of the live manifests, which other
branches may be editing); a final block runs the real CLI end-to-end against the
checked-in 12-alias source of truth.

Runs standalone (`python3 ops/tests/test_generate_telegram_config.py`) or under pytest.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

OPS_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = OPS_DIR / "scripts" / "generate-telegram-config.py"

# A synthetic fleet with multi-member and singleton rooms. Telegram ingress still
# routes each bot only to itself; room fan-out belongs to durable Cauce V3 messages.
SYNTHETIC_FLEET = {
    "kant": {"tenant": "Steven", "room": "grp.steven", "harness": "codex"},
    "argos": {"tenant": "Steven", "room": "grp.steven", "harness": "hermes"},
    "jarvis": {"tenant": "Steven", "room": "grp.steven", "harness": "openclaw"},
    "hegel": {"tenant": "Jhon", "room": "grp.jhon", "harness": "openclaw"},
}


def load_generator():
    spec = importlib.util.spec_from_file_location("generate_telegram_config", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gen = load_generator()


class ShapeTests(unittest.TestCase):
    def test_full_build_validates_and_is_ordered(self) -> None:
        config = gen.build_config(SYNTHETIC_FLEET)  # build_config validates internally
        gen.validate_config(config)  # explicit, also proves the schema replication passes
        aliases = config["aliases"]
        self.assertEqual([row["alias"] for row in aliases], ["argos", "hegel", "jarvis", "kant"])
        for row in aliases:
            self.assertEqual(tuple(row.keys()), gen.ALIAS_FIELD_ORDER)
            self.assertEqual(row["tenant_id"], SYNTHETIC_FLEET[row["alias"]]["tenant"])
            self.assertEqual(row["room_id"], SYNTHETIC_FLEET[row["alias"]]["room"])
            self.assertEqual(row["poll_timeout_seconds"], gen.DEFAULT_POLL_TIMEOUT_SECONDS)
            self.assertEqual(row["poll_lease_ms"], gen.DEFAULT_POLL_LEASE_MS)

    def test_placeholder_paths_match_compose_mount(self) -> None:
        # gap G1: token/marker default UNDER the compose mount (/run/cauce-telegram),
        # alongside config.json, so the read-only bind exposes them to the container.
        config = gen.build_config(SYNTHETIC_FLEET)
        self.assertEqual(gen.DEFAULT_RUNTIME_DIR, "/run/cauce-telegram")
        for row in config["aliases"]:
            alias = row["alias"]
            self.assertEqual(row["token_file"], f"/run/cauce-telegram/{alias}.token")
            self.assertEqual(row["v2_shutdown_marker_file"], f"/run/cauce-telegram/{alias}.disabled")
            self.assertNotIn("token", row)
            self.assertNotIn("bot_token", row)
            # No value resembles a real Telegram bot token (`<digits>:<secret>`).
            self.assertNotRegex(row["token_file"], r"^[0-9]{6,20}:")

    def test_placeholder_allowlists_are_identical_sentinels(self) -> None:
        # gap G3: with no operational ids, allowlists default to the shared sentinel
        # (an obvious "replace me" that the preflight rejects before enabling).
        config = gen.build_config(SYNTHETIC_FLEET)
        for row in config["aliases"]:
            self.assertEqual(row["allowed_user_ids"], [gen.PLACEHOLDER_USER_ID])
            self.assertEqual(row["allowed_chat_ids"], [gen.PLACEHOLDER_CHAT_ID])

    def test_default_recipients_is_self(self) -> None:
        # gap G2: default self policy — a human DMs the <alias> bot and <alias> answers.
        config = {row["alias"]: row for row in gen.build_config(SYNTHETIC_FLEET)["aliases"]}
        for alias, row in config.items():
            self.assertEqual(row["recipients"], [{"tenant_id": SYNTHETIC_FLEET[alias]["tenant"], "alias": alias}])

    def test_idempotent(self) -> None:
        first = gen.build_config(SYNTHETIC_FLEET)
        second = gen.build_config(SYNTHETIC_FLEET)
        self.assertEqual(first, second)
        self.assertEqual(gen.render(first), gen.render(second))

    def test_override_allowlists_reflected(self) -> None:
        options = gen.default_options()
        options["allowed_user_ids"] = ["101", "202"]
        options["allowed_chat_ids"] = ["-303"]
        config = gen.build_config(SYNTHETIC_FLEET, None, options)
        for row in config["aliases"]:
            self.assertEqual(row["allowed_user_ids"], ["101", "202"])
            self.assertEqual(row["allowed_chat_ids"], ["-303"])


class RecipientsPolicyTests(unittest.TestCase):
    def _by_alias(self, policy: str) -> dict:
        options = gen.default_options()
        options["recipients_policy"] = policy
        return {row["alias"]: row for row in gen.build_config(SYNTHETIC_FLEET, None, options)["aliases"]}

    def test_self_policy(self) -> None:
        config = self._by_alias("self")
        self.assertEqual(config["kant"]["recipients"], [{"tenant_id": "Steven", "alias": "kant"}])
        self.assertEqual(config["hegel"]["recipients"], [{"tenant_id": "Jhon", "alias": "hegel"}])

    def test_room_and_peers_policies_are_rejected(self) -> None:
        for policy in ("room", "peers"):
            with self.subTest(policy=policy), self.assertRaises(gen.GeneratorError):
                self._by_alias(policy)

    def test_unknown_policy_raises(self) -> None:
        options = gen.default_options()
        options["recipients_policy"] = "everyone"
        with self.assertRaises(gen.GeneratorError):
            gen.build_config(SYNTHETIC_FLEET, None, options)


class RuntimeDirTests(unittest.TestCase):
    def test_runtime_dir_override_moves_token_and_marker(self) -> None:
        options = gen.default_options()
        options["token_dir"] = "/mnt/tg"
        options["marker_dir"] = "/mnt/tg"
        config = {row["alias"]: row for row in gen.build_config(SYNTHETIC_FLEET, None, options)["aliases"]}
        self.assertEqual(config["kant"]["token_file"], "/mnt/tg/kant.token")
        self.assertEqual(config["kant"]["v2_shutdown_marker_file"], "/mnt/tg/kant.disabled")

    def test_cli_runtime_dir_flag(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--aliases", "kant", "--runtime-dir", "/run/cauce-telegram"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads(result.stdout)["aliases"][0]
        self.assertEqual(row["token_file"], "/run/cauce-telegram/kant.token")
        self.assertEqual(row["v2_shutdown_marker_file"], "/run/cauce-telegram/kant.disabled")


class AllowlistFileTests(unittest.TestCase):
    def _options_with(self, document: dict) -> dict:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(document, handle)
            path = pathlib.Path(handle.name)
        self.addCleanup(path.unlink)
        options = gen.default_options()
        options["allowlist"] = gen.load_allowlist_file(path)
        return options

    def test_per_alias_entry_wins(self) -> None:
        options = self._options_with({"aliases": {"kant": {"user_ids": ["11"], "chat_ids": ["-22"]}}})
        config = {row["alias"]: row for row in gen.build_config(SYNTHETIC_FLEET, None, options)["aliases"]}
        self.assertEqual(config["kant"]["allowed_user_ids"], ["11"])
        self.assertEqual(config["kant"]["allowed_chat_ids"], ["-22"])
        # An alias without its own entry falls back to the sentinel placeholder.
        self.assertEqual(config["argos"]["allowed_user_ids"], [gen.PLACEHOLDER_USER_ID])

    def test_tenant_entry_applies_to_members(self) -> None:
        options = self._options_with({"tenants": {"Steven": {"user_ids": ["77"], "chat_ids": ["-88"]}}})
        config = {row["alias"]: row for row in gen.build_config(SYNTHETIC_FLEET, None, options)["aliases"]}
        for alias in ("kant", "argos", "jarvis"):
            self.assertEqual(config[alias]["allowed_user_ids"], ["77"])
            self.assertEqual(config[alias]["allowed_chat_ids"], ["-88"])
        # hegel is a different tenant, so it keeps the placeholder.
        self.assertEqual(config["hegel"]["allowed_user_ids"], [gen.PLACEHOLDER_USER_ID])

    def test_alias_entry_beats_tenant_entry(self) -> None:
        options = self._options_with({
            "aliases": {"kant": {"user_ids": ["11"], "chat_ids": ["-22"]}},
            "tenants": {"Steven": {"user_ids": ["77"], "chat_ids": ["-88"]}},
        })
        config = {row["alias"]: row for row in gen.build_config(SYNTHETIC_FLEET, None, options)["aliases"]}
        self.assertEqual(config["kant"]["allowed_user_ids"], ["11"])
        self.assertEqual(config["argos"]["allowed_user_ids"], ["77"])

    def test_rejects_inline_token_key(self) -> None:
        with self.assertRaises(gen.GeneratorError):
            self._options_with({"aliases": {"kant": {"user_ids": ["11"], "chat_ids": ["-22"], "token": "x"}}})

    def test_rejects_bad_id(self) -> None:
        with self.assertRaises(gen.GeneratorError):
            self._options_with({"aliases": {"kant": {"user_ids": ["not-an-id"], "chat_ids": ["-22"]}}})

    def test_rejects_unknown_top_level_key(self) -> None:
        with self.assertRaises(gen.GeneratorError):
            self._options_with({"bots": {"kant": {"user_ids": ["11"], "chat_ids": ["-22"]}}})


class SelectionTests(unittest.TestCase):
    def test_subset_canary(self) -> None:
        config = gen.build_config(SYNTHETIC_FLEET, ["kant", "argos"])
        self.assertEqual([row["alias"] for row in config["aliases"]], ["argos", "kant"])
        gen.validate_config(config)

    def test_subset_is_order_independent(self) -> None:
        a = gen.render(gen.build_config(SYNTHETIC_FLEET, ["kant", "argos"]))
        b = gen.render(gen.build_config(SYNTHETIC_FLEET, ["argos", "kant"]))
        self.assertEqual(a, b)

    def test_unknown_alias_raises(self) -> None:
        with self.assertRaises(gen.GeneratorError):
            gen.build_config(SYNTHETIC_FLEET, ["ghost"])

    def test_duplicate_selection_raises(self) -> None:
        with self.assertRaises(gen.GeneratorError):
            gen.build_config(SYNTHETIC_FLEET, ["kant", "kant"])


class ValidatorTests(unittest.TestCase):
    def _valid(self) -> dict:
        return gen.build_config(SYNTHETIC_FLEET)

    def test_rejects_empty_allowlist(self) -> None:
        # Documents WHY placeholders (not literally-empty) are emitted: the schema
        # forbids an empty allowlist.
        bad = copy.deepcopy(self._valid())
        bad["aliases"][0]["allowed_user_ids"] = []
        with self.assertRaises(gen.GeneratorError):
            gen.validate_config(bad)

    def test_rejects_inline_token(self) -> None:
        bad = copy.deepcopy(self._valid())
        bad["aliases"][0]["token"] = "123456:secret-material"
        with self.assertRaises(gen.GeneratorError):
            gen.validate_config(bad)

    def test_rejects_relative_token_file(self) -> None:
        bad = copy.deepcopy(self._valid())
        bad["aliases"][0]["token_file"] = "run/cauce-telegram/kant.token"
        with self.assertRaises(gen.GeneratorError):
            gen.validate_config(bad)

    def test_rejects_short_poll_lease(self) -> None:
        bad = copy.deepcopy(self._valid())
        bad["aliases"][0]["poll_timeout_seconds"] = 25
        bad["aliases"][0]["poll_lease_ms"] = 10_000  # < 25*1000 + 5000
        with self.assertRaises(gen.GeneratorError):
            gen.validate_config(bad)


class RealFleetCliTests(unittest.TestCase):
    """End-to-end against the checked-in 12-alias source of truth."""

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_cli_full_fleet_stdout_validates(self) -> None:
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(len(config["aliases"]), 12)
        gen.validate_config(config)
        names = sorted(row["alias"] for row in config["aliases"])
        self.assertEqual(len(set(names)), 12)
        # Turnkey defaults: self recipients + token/marker under the compose mount.
        for row in config["aliases"]:
            self.assertEqual(row["recipients"], [{"tenant_id": row["tenant_id"], "alias": row["alias"]}])
            self.assertTrue(row["token_file"].startswith("/run/cauce-telegram/"))
            self.assertTrue(row["v2_shutdown_marker_file"].startswith("/run/cauce-telegram/"))

    def test_cli_subset(self) -> None:
        result = self._run("--aliases", "kant,jarvis")
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual([row["alias"] for row in config["aliases"]], ["jarvis", "kant"])

    def test_cli_unknown_alias_exits_nonzero(self) -> None:
        result = self._run("--aliases", "nope")
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown alias", result.stderr)

    def test_cli_idempotent_output(self) -> None:
        first = self._run("--no-cross-check")
        second = self._run("--no-cross-check")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, second.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
