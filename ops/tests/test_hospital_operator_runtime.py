from __future__ import annotations

import copy
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# cauce:requiere non-root

ROOT = Path(__file__).resolve().parents[2]
INSTANCE = ROOT / "ops/instances/hospital"
SPEC = importlib.util.spec_from_file_location("operator_runtime_guard", INSTANCE / "operator-runtime-guard.py")
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)
SUP_SPEC = importlib.util.spec_from_file_location("praxis_supervision_trusted_runtime",
                                                  INSTANCE / "praxis-supervision.py")
SUP = importlib.util.module_from_spec(SUP_SPEC)
SUP_SPEC.loader.exec_module(SUP)
TRUSTED = "/opt/cauce-hospital/runtime"
LEGACY = "/home/node/clawd/.cauce/runtime"

FAKE_DOCKER = r'''import json, os, subprocess, sys
# Runs `docker exec` locally: container paths map to fixture directories and map back in the output.
arguments = sys.argv[1:]
with open(os.environ["FAKE_DOCKER_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(arguments) + "\n")
if arguments[:3] == ["inspect", "--type", "container"]:
    sys.stdout.write(open(os.environ["FAKE_DOCKER_INSPECT"], encoding="utf-8").read())
    sys.exit(0)
if arguments[:3] == ["exec", "-u", "1000:1000"]:
    remap = json.loads(os.environ["FAKE_DOCKER_REMAP"])
    def view(argument):
        for source, target in remap:
            if argument == source or argument.startswith(source + "/"):
                return target + argument[len(source):]
        return argument
    completed = subprocess.run([view(argument) for argument in arguments[4:]], capture_output=True, check=False)
    output = completed.stdout.decode("utf-8", "surrogateescape")
    for source, target in remap:
        output = output.replace(target, source)
    sys.stdout.write(output)
    sys.exit(completed.returncode)
sys.exit(2)
'''


class TrustedRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="operator-runtime-")
        self.addCleanup(temporary.cleanup)
        self.addCleanup(self.restore_writable, Path(temporary.name))
        self.base = Path(temporary.name)
        self.root = self.base / "opt" / "cauce-hospital" / "runtime"
        self.root.parent.parent.mkdir(mode=0o755)
        self.home = self.base / "container-home"
        (self.home / ".openclaw").mkdir(parents=True)
        self.config = self.home / ".openclaw" / "openclaw.json"
        self.config.write_text(json.dumps({"agents": {"defaults": {"model": {
            "primary": "xai/grok-4.7", "fallbacks": []}}}}), encoding="utf-8")
        self.docker = self.base / "docker"
        self.docker.write_text(f"#!{sys.executable}\n{FAKE_DOCKER}", encoding="utf-8")
        self.docker.chmod(0o755)
        self.log = self.base / "docker.log"
        self.inspect_file = self.base / "inspect.json"
        self.remap = [["/home/node", str(self.home)], ["/opt/muse-code", str(self.base / "muse-code")]]
        self.inspect = {"State": {"Running": True}, "Config": {"Env": ["PATH=/usr/bin", "HOME=/home/node"]},
                        "Mounts": [{"Type": "bind", "Source": str(self.root), "Destination": str(self.root),
                                    "Mode": "ro", "RW": False},
                                   {"Type": "bind", "Source": "/srv/state-operator",
                                    "Destination": "/home/node/.openclaw", "Mode": "rw", "RW": True}]}

    @staticmethod
    def restore_writable(base: Path) -> None:
        for directory, _, _ in os.walk(base):
            os.chmod(directory, 0o755)

    def install(self) -> dict[str, str]:
        return GUARD.install(INSTANCE, self.root, os.getuid(), os.getgid())

    def seal(self) -> None:
        """Emulate root ownership for the unprivileged actor: nothing in the runtime stays writable."""
        for directory, _, files in os.walk(self.root):
            for name in files:
                os.chmod(Path(directory) / name, 0o444)
        for directory, _, _ in sorted(os.walk(self.root), reverse=True):
            os.chmod(directory, 0o555)

    def verify(self, fallback: bool = False) -> None:
        self.inspect_file.write_text(json.dumps([self.inspect]), encoding="utf-8")
        environment = {"FAKE_DOCKER_LOG": str(self.log), "FAKE_DOCKER_INSPECT": str(self.inspect_file),
                       "FAKE_DOCKER_REMAP": json.dumps(self.remap)}
        previous = {name: os.environ.get(name) for name in environment}
        os.environ.update(environment)
        try:
            GUARD.verify("hospital-agent-openclaw-operator-gateway-1", str(self.root), fallback,
                         binary=str(self.docker), owner=os.getuid())
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def assert_rejected(self, code: str, fallback: bool = False) -> None:
        with self.assertRaises(GUARD.GuardError) as raised:
            self.verify(fallback)
        self.assertIn(code, raised.exception.codes)

    def test_install_places_exact_runtime_with_source_bytes_and_no_group_or_other_write(self) -> None:
        digests = self.install()
        self.assertEqual(set(digests), set(GUARD.runtime_entries()))
        for relative in GUARD.runtime_entries():
            installed = self.root / relative
            source = INSTANCE / relative
            self.assertEqual(installed.read_bytes(), source.read_bytes())
            self.assertEqual(stat.S_IMODE(installed.lstat().st_mode), 0o644)
        for directory in (self.root.parent, self.root, self.root / GUARD.PLUGIN_DIRECTORY):
            self.assertEqual(stat.S_IMODE(directory.lstat().st_mode), 0o755)
        self.assertEqual(sorted(os.listdir(self.root)), sorted([*GUARD.RUNTIME_FILES, GUARD.PLUGIN_DIRECTORY]))

    def test_reinstall_replaces_files_in_place_and_prunes_planted_entries(self) -> None:
        self.install()
        inode = self.root.stat().st_ino
        (self.root / "muse-cli-backend.py").write_text("print('planted')\n", encoding="utf-8")
        (self.root / "__pycache__").mkdir()
        (self.root / "__pycache__" / "praxis-proof.cpython-312.pyc").write_bytes(b"planted")
        (self.root / "json.py").write_text("raise SystemExit('planted')\n", encoding="utf-8")
        (self.root / GUARD.PLUGIN_DIRECTORY / "evil.js").write_text("planted", encoding="utf-8")
        os.symlink("/etc/passwd", self.root / "usercustomize.py")
        self.install()
        self.assertEqual(self.root.stat().st_ino, inode, "the bind-mounted directory inode must survive")
        self.assertEqual(sorted(os.listdir(self.root)), sorted([*GUARD.RUNTIME_FILES, GUARD.PLUGIN_DIRECTORY]))
        self.assertEqual(sorted(os.listdir(self.root / GUARD.PLUGIN_DIRECTORY)), sorted(GUARD.PLUGIN_FILES))
        self.assertEqual((self.root / "muse-cli-backend.py").read_bytes(),
                         (INSTANCE / "muse-cli-backend.py").read_bytes())

    def test_install_refuses_symlinked_or_shared_writable_locations(self) -> None:
        elsewhere = self.base / "elsewhere"
        elsewhere.mkdir()
        self.root.parent.mkdir(mode=0o755)
        os.symlink(elsewhere, self.root)
        with self.assertRaises(GUARD.GuardError):
            self.install()
        self.assertEqual(os.listdir(elsewhere), [])
        os.unlink(self.root)
        os.chmod(self.root.parent.parent, 0o777)
        with self.assertRaises(GUARD.GuardError) as raised:
            self.install()
        self.assertTrue(raised.exception.codes[0].startswith("untrusted_ancestor:"))

    def test_verify_accepts_read_only_bind_with_matching_bytes_and_fallback_off(self) -> None:
        self.install()
        self.seal()
        self.verify()
        calls = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(calls[0], ["inspect", "--type", "container", "hospital-agent-openclaw-operator-gateway-1"])
        self.assertTrue(all(call[:3] == ["exec", "-u", "1000:1000"] for call in calls[1:]))
        probed = next(call for call in calls if "-c" in call and call[call.index("-c") + 1] == GUARD.PROBE)
        self.assertIn(str(self.root), probed)
        self.assertIn(str(self.root / "muse-cli-backend.py"), probed)
        self.assertIn(str(self.root / "praxis-proof.py"), probed)
        self.assertIn(str(self.root / "praxis-qa-review.py"), probed)

    def test_verify_rejects_runtime_writable_by_the_actor(self) -> None:
        self.install()
        self.assert_rejected(f"runtime_not_read_only_for_actor:{self.root}")
        self.assert_rejected(f"runtime_not_read_only_for_actor:{self.root / 'muse-cli-backend.py'}")

    def test_verify_rejects_a_mount_that_is_missing_writable_or_from_another_source(self) -> None:
        self.install()
        self.seal()
        original = copy.deepcopy(self.inspect)
        for mutate in (lambda mount: mount.update(RW=True), lambda mount: mount.update(Source="/home/node/clawd"),
                       lambda mount: mount.update(Type="volume"), lambda mount: mount.update(Destination="/opt/x")):
            with self.subTest(mutate=mutate):
                self.inspect = copy.deepcopy(original)
                mutate(self.inspect["Mounts"][0])
                self.assert_rejected("runtime_mount_not_read_only_bind")

    def test_verify_rejects_a_writable_mount_shadowing_a_runtime_file(self) -> None:
        self.install()
        self.seal()
        self.inspect["Mounts"].append({"Type": "bind", "Source": "/home/node/clawd/x.py", "RW": True,
                                       "Destination": str(self.root / "praxis-proof.py")})
        self.assert_rejected("runtime_mount_shadowed")

    def test_verify_rejects_a_container_view_with_different_bytes(self) -> None:
        self.install()
        other = self.base / "other-runtime"
        GUARD.install(INSTANCE, other, os.getuid(), os.getgid())
        (other / "praxis-proof.py").chmod(0o644)
        (other / "praxis-proof.py").write_text("print('forged evidence')\n", encoding="utf-8")
        self.seal()
        for directory, _, files in os.walk(other):
            for name in files:
                os.chmod(Path(directory) / name, 0o444)
            os.chmod(directory, 0o555)
        self.remap.insert(0, [str(self.root), str(other)])
        self.assert_rejected("runtime_digest_mismatch:praxis-proof.py")

    def test_verify_fallback_off_rejects_muse_config_plugin_env_and_runtime(self) -> None:
        self.install()
        self.seal()
        baseline_config = self.config.read_text(encoding="utf-8")
        self.config.write_text(json.dumps({"agents": {"defaults": {"model": {
            "primary": "xai/grok-4.7", "fallbacks": ["muse-cli/muse-spark-1.3"]}}}}), encoding="utf-8")
        self.assert_rejected("operator_config_references_muse_fallback")
        self.config.write_text(baseline_config, encoding="utf-8")

        extension = self.home / ".openclaw" / "extensions" / "hospital-muse-native"
        extension.mkdir(parents=True)
        self.assert_rejected("operator_has_writable_muse_plugin")
        extension.rmdir()

        self.inspect["Config"]["Env"].append("CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK=1")
        self.assert_rejected("operator_env_enables_muse_fallback")
        self.inspect["Config"]["Env"].pop()

        self.inspect["Mounts"].append({"Type": "bind", "Source": "/srv/state-muse-operator",
                                       "Destination": "/home/node/.muse", "RW": True})
        self.assert_rejected("operator_has_muse_runtime")
        self.inspect["Mounts"].pop()

        (self.home / ".muse" / "config").mkdir(parents=True)
        self.assert_rejected("operator_has_muse_runtime")
        (self.home / ".muse" / "config").rmdir()
        self.verify()

    def test_verify_fallback_on_requires_env_opt_in_and_plugin_from_trusted_runtime(self) -> None:
        self.install()
        self.seal()
        self.inspect["Mounts"].append({"Type": "bind", "Source": "/srv/state-muse-operator",
                                       "Destination": "/home/node/.muse", "RW": True})
        self.config.write_text(json.dumps({"plugins": {"load": {"paths": [str(self.root / "openclaw-muse-native")]}},
                                           "agents": {"defaults": {"model": {
                                               "primary": "xai/grok-4.7",
                                               "fallbacks": ["muse-cli/muse-spark-1.3"]}}}}), encoding="utf-8")
        self.assert_rejected("operator_env_lacks_muse_fallback_opt_in", fallback=True)
        self.inspect["Config"]["Env"].append("CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK=1")
        self.verify(fallback=True)
        extension = self.home / ".openclaw" / "extensions" / "hospital-muse-native"
        extension.mkdir(parents=True)
        self.assert_rejected("operator_has_writable_muse_plugin", fallback=True)
        extension.rmdir()
        self.config.write_text(json.dumps({"agents": {"defaults": {"model": {
            "fallbacks": ["muse-cli/muse-spark-1.3"]}}}}), encoding="utf-8")
        self.assert_rejected("operator_plugin_not_loaded_from_trusted_runtime", fallback=True)

    def test_verify_fails_closed_on_docker_errors_and_stopped_containers(self) -> None:
        self.install()
        self.seal()
        self.inspect["State"]["Running"] = False
        self.assert_rejected("container_not_running")
        self.inspect["State"]["Running"] = True
        self.config.unlink()
        self.assert_rejected("docker_failed:exec")

    def test_cli_requires_root_and_an_explicit_fallback_flag(self) -> None:
        program = INSTANCE / "operator-runtime-guard.py"
        refused = subprocess.run([sys.executable, "-I", str(program), "verify", "--container", "x",
                                  "--muse-fallback", "0"], capture_output=True, text=True, check=False)
        self.assertEqual(refused.returncode, 1)
        self.assertIn("requires_root", refused.stderr)
        for value in ("", "2", "true"):
            invalid = subprocess.run([sys.executable, "-I", str(program), "verify", "--container", "x",
                                      "--muse-fallback", value], capture_output=True, text=True, check=False)
            self.assertEqual(invalid.returncode, 2)
        missing = subprocess.run([sys.executable, "-I", str(program), "verify", "--container", "x"],
                                 capture_output=True, text=True, check=False)
        self.assertEqual(missing.returncode, 2)


class TrustedInvocationTests(unittest.TestCase):
    def test_evidence_producers_run_from_the_trusted_runtime_in_isolated_mode(self) -> None:
        proof = f"/opt/praxis-qa-venv/bin/python -I -B {TRUSTED}/praxis-proof.py "
        review = f"/opt/praxis-qa-venv/bin/python -I -B {TRUSTED}/praxis-qa-review.py "
        self.assertIn(proof, SUP.ROOT_TEXT)
        review_source = (INSTANCE / "praxis-supervision-review.py").read_text(encoding="utf-8")
        self.assertIn(review, review_source)
        self.assertIn(f"{TRUSTED}/praxis-qa-review.py; ", review_source)

    def test_proof_evidence_records_the_isolated_interpreter_flags_it_ran_with(self) -> None:
        probe = ("import importlib.util, json, sys; "
                 "spec = importlib.util.spec_from_file_location('proof', sys.argv[1]); "
                 "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
                 "print(json.dumps(module.interpreter_invocation()))")
        program = str((INSTANCE / "praxis-proof.py").resolve())
        for flags, expected in ((["-I", "-B"], ["-I", "-B"]), (["-B"], ["-B"])):
            with self.subTest(flags=flags):
                output = subprocess.run([sys.executable, *flags, "-c", probe, program], capture_output=True,
                                        text=True, check=True).stdout
                self.assertEqual(json.loads(output), [sys.executable, *expected, program])

    def test_no_hospital_artifact_executes_from_the_agent_workspace(self) -> None:
        for path in sorted(INSTANCE.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                with self.subTest(path=path.name):
                    self.assertNotIn(LEGACY, path.read_text(encoding="utf-8", errors="replace"))
        self.assertNotIn(LEGACY, SUP.ROOT_TEXT)

    def test_every_trusted_entry_exists_in_the_source_tree(self) -> None:
        self.assertEqual(GUARD.RUNTIME_ROOT, TRUSTED)
        for relative in GUARD.runtime_entries():
            self.assertTrue((INSTANCE / relative).is_file(), relative)

    def test_provision_validates_the_flag_before_side_effects_and_verifies_the_operator(self) -> None:
        script = (INSTANCE / "provision-agents.sh").read_text(encoding="utf-8")
        self.assertIn('OPERATOR_MUSE_FALLBACK=${CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK:-0}', script)
        validation = script.index('case "$OPERATOR_MUSE_FALLBACK" in')
        utc = script.index("datetime.UTC")
        self.assertLess(validation, script.index("umask 077"))
        self.assertLess(utc, script.index("umask 077"))
        self.assertLess(validation, script.index("install -o 1000"))
        install = script.index('python3 -I "$RUNTIME_GUARD" install --source "$REPO/ops/instances/hospital"')
        verify = script.index('python3 -I "$RUNTIME_GUARD" verify --container "$(container_for operador)"')
        self.assertLess(install, verify)
        self.assertLess(script.index("test -w /home/node/clawd &&"), verify)
        self.assertLess(verify, script.index("runtime_image=$(env_value"))
        self.assertIn('--muse-fallback "$OPERATOR_MUSE_FALLBACK"', script)


if __name__ == "__main__":
    unittest.main()
