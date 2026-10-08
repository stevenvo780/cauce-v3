from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cauce_pty_agent.native_admin import execute_native_admin, operation_record
from cauce_pty_agent.native_admin_paths import digest, read_path


class NativeAdminTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-native-admin-test-")
        self.home = Path(self.temporary.name) / "home"
        self.home.mkdir(mode=0o700)
        self.root = self.home / "account"
        self.root.mkdir(mode=0o700)
        self.writer = str(uuid.uuid4())
        self.bundle = {"harness": "codex", "home": str(self.home), "runtime_uid": os.geteuid(),
                       "container_id": "fixture-container", "generation": "fixture-generation",
                       "runtime_facts": {"codex_home": str(self.root)}}
        self.identity = {"generation": self.bundle["generation"], "container_id": self.bundle["container_id"], "writer_instance_id": self.writer}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def command(self, op: str, **fields):
        return {"op": op, "request_id": str(uuid.uuid4()), "identity": self.identity, **fields}

    def call(self, op: str, **fields):
        return execute_native_admin(self.bundle, self.writer, self.command(op, **fields))

    def put(self, kind="skill", identifier="native-proof", expected=None, value=None):
        return {"kind": kind, "id": identifier, "action": "put", "expected_sha": expected,
                "value": value if value is not None else {"content": "---\nname: native-proof\ndescription: Native fixture proof\n---\nRead carefully.\n"}}

    def mutate(self, mutation):
        operation = {"operation_id": str(uuid.uuid4()), "operation_generation": str(uuid.uuid4()), "operation_token": str(uuid.uuid4())}
        return self.call("mutate", mutation=mutation, operation=operation), operation

    def test_real_skill_crud_has_private_backup_and_durable_receipt(self):
        mutation = self.put()
        plan = self.call("prepare", mutation=mutation)
        self.assertEqual(plan["type"], "plan")
        self.assertFalse((self.root / "skills").exists())
        receipt, operation = self.mutate(mutation)
        self.assertEqual(receipt["type"], "receipt")
        self.assertEqual(read_path(receipt["path"]).decode(), mutation["value"]["content"])
        self.assertEqual(self.call("status", mutation=mutation, operation=operation), receipt)
        modified = {**mutation, "expected_sha": receipt["sha"], "value": {"content": mutation["value"]["content"] + "Changed.\n"}}
        changed, _ = self.mutate(modified)
        backup = self.root / ".cauce-native-admin" / (changed["backup_id"] + ".backup")
        self.assertEqual(backup.read_text(), mutation["value"]["content"])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.parent.stat().st_mode & 0o777, 0o700)
        deleted, _ = self.mutate({"kind": "skill", "id": "native-proof", "action": "delete", "expected_sha": changed["sha"]})
        self.assertIsNone(deleted["sha"])
        self.assertFalse(Path(deleted["path"]).exists())
        self.assertEqual(self.call("list", kind="skill")["items"], [])

    def test_unseen_status_fences_a_late_writer_without_touching_the_piece(self):
        mutation = self.put()
        operation = {"operation_id": str(uuid.uuid4()), "operation_generation": str(uuid.uuid4()), "operation_token": str(uuid.uuid4())}
        receipt = self.call("status", mutation=mutation, operation=operation)
        self.assertEqual(receipt["type"], "receipt")
        self.assertIsNone(receipt["sha"])
        self.assertEqual(self.call("mutate", mutation=mutation, operation=operation), receipt)
        self.assertFalse((self.root / "skills/native-proof/SKILL.md").exists())

    def test_interrupted_writing_can_be_reconciled_only_with_exact_disk_state(self):
        mutation = self.put()
        result, operation = self.mutate(mutation)
        journal = self.root / ".cauce-native-admin" / (operation["operation_id"] + ".json")
        record = json.loads(journal.read_text())
        record["state"] = "writing"
        record["backup_id"] = result["backup_id"]
        record["plan"] = {"path": result["path"], "before_sha": None, "target_sha": result["sha"]}
        del record["receipt"]
        journal.write_text(json.dumps(record))
        recovered = self.call("status", mutation=mutation, operation=operation)
        self.assertEqual(recovered["sha"], result["sha"])
        Path(result["path"]).write_text("Unrelated change")
        self.assertEqual(self.call("status", mutation=mutation, operation=operation)["error"], "conflict")

    def test_crash_before_creating_the_native_parent_recovers_durable_absence(self):
        mutation = self.put()
        operation = {"operation_id": str(uuid.uuid4()), "operation_generation": str(uuid.uuid4()), "operation_token": str(uuid.uuid4())}
        command = self.command("status", mutation=mutation, operation=operation)
        name, metadata = operation_record(command)
        plan = self.call("prepare", mutation=mutation)
        state = self.root / ".cauce-native-admin"
        backup = str(uuid.uuid4())
        (state / (backup + ".backup")).write_bytes(b"")
        journal = {**metadata, "state": "writing", "plan": plan, "backup_id": backup}
        (state / name).write_text(json.dumps(journal))
        self.assertFalse((self.root / "skills").exists())
        recovered = execute_native_admin(self.bundle, self.writer, command)
        self.assertEqual(recovered["type"], "receipt")
        self.assertIsNone(recovered["sha"])
        self.assertEqual(self.call("mutate", mutation=mutation, operation=operation), recovered)
        self.assertFalse((self.root / "skills").exists())

    def test_cas_identity_traversal_and_credential_like_commands_fail_before_effect(self):
        self.assertEqual(self.call("prepare", mutation=self.put(identifier="../auth"))["error"], "invalid_input")
        self.assertEqual(self.call("prepare", mutation={**self.put(), "path": "/tmp/auth.json"})["error"], "invalid_input")
        self.assertEqual(self.call("prepare", mutation=self.put(expected="a" * 64))["error"], "conflict")
        command = self.command("mutate", mutation=self.put(), operation={})
        command["identity"] = {**self.identity, "generation": "replaced"}
        self.assertEqual(execute_native_admin(self.bundle, self.writer, command)["error"], "conflict")
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (self.root / "skills").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.call("prepare", mutation=self.put())["error"], "unsafe_path")
        self.assertEqual(list(outside.iterdir()), [])

    def test_mcp_projection_preserves_private_fields_and_rejects_raw_tokens(self):
        self.bundle["harness"] = "claude"
        self.bundle["runtime_facts"] = {"claude_config_dir": str(self.root)}
        config = self.root / ".claude.json"
        private = {"oauthAccount": {"token": "PRIVATE_SENTINEL"}, "mcpServers": {"opaque": {"type": "http", "url": "https://example.invalid", "headers": {"Authorization": "RAW_TOKEN_SENTINEL"}}}}
        config.write_text(json.dumps(private))
        mutation = self.put("mcp", "native-proof", digest(config.read_bytes()), {"mcp": {"url": "https://example.invalid/mcp", "bearer_token_env_var": "MCP_TEST_TOKEN"}})
        result, _ = self.mutate(mutation)
        self.assertEqual(result["type"], "receipt")
        persisted = json.loads(config.read_text())
        self.assertEqual(persisted["oauthAccount"], private["oauthAccount"])
        self.assertEqual(persisted["mcpServers"]["opaque"], private["mcpServers"]["opaque"])
        public = json.dumps(self.call("get", kind="mcp", id="native-proof"))
        self.assertNotIn("PRIVATE_SENTINEL", public)
        self.assertNotIn("RAW_TOKEN_SENTINEL", json.dumps(self.call("get", kind="mcp", id="opaque")))
        self.assertFalse(self.call("get", kind="mcp", id="opaque")["piece"]["editable"])
        self.assertEqual(self.call("prepare", mutation=self.put("mcp", "opaque", result["sha"], {"mcp": {"url": "https://example.invalid/mcp"}}))["error"], "unsupported")

    def test_codex_mcp_preserves_other_toml_and_guards_structured_sections(self):
        path = self.root / "config.toml"
        original = 'model = "fixture"\n[features]\nmulti_agent = true\n'
        path.write_text(original)
        result, _ = self.mutate(self.put("mcp", "native-proof", digest(path.read_bytes()), {"mcp": {"url": "https://example.invalid/mcp"}}))
        self.assertEqual(result["type"], "receipt")
        self.assertTrue(path.read_text().startswith(original))
        deleted, _ = self.mutate({"kind": "mcp", "id": "native-proof", "action": "delete", "expected_sha": result["sha"]})
        self.assertEqual(deleted["type"], "receipt")
        self.assertEqual(self.call("list", kind="mcp")["items"], [])
        self.assertIn('[features]\nmulti_agent = true', path.read_text())

    def test_actual_vendor_binary_recognizes_private_native_paths_without_model_call(self):
        for harness in ("codex", "claude"):
            if shutil.which(harness) is None:
                self.skipTest("native vendor binary unavailable")
            self.bundle["harness"] = harness
            self.bundle["runtime_facts"] = {"codex_home" if harness == "codex" else "claude_config_dir": str(self.root)}
            mutation = self.put("mcp", "native-proof", value={"mcp": {"url": "https://example.invalid/mcp"}})
            result, _ = self.mutate(mutation)
            self.assertEqual(result["type"], "receipt")
            recognized = self.call("recognize", kind="mcp", id="native-proof", expected_sha=result["sha"])
            self.assertEqual(recognized.get("reason"), "provider_read_verified" if harness == "codex" else "provider_format_verified", harness + ": " + json.dumps(recognized))
        self.bundle["harness"] = "codex"
        self.bundle["runtime_facts"] = {"codex_home": str(self.root)}
        result, _ = self.mutate(self.put())
        self.assertEqual(self.call("recognize", kind="skill", id="native-proof", expected_sha=result["sha"])["state"], "available_for_new_session")


if __name__ == "__main__":
    unittest.main()
