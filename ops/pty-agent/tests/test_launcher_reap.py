from __future__ import annotations

import errno
import os
import pathlib
import runpy
import shlex
import signal
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock

LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / "cauce-pty-launcher.sh"
REAPER = LAUNCHER.with_name("reap_orphan_agent.py")
INSTALLER = LAUNCHER.with_name("install-pty-agent.sh")
MOCK_AGENT_SOURCE = r'''import os
import signal
import time

mode = os.environ["MOCK_AGENT_MODE"]
event_path = os.environ["MOCK_AGENT_EVENT_PATH"]
ready_path = os.environ["MOCK_AGENT_READY_PATH"]


def record(event):
    with open(event_path, "a", encoding="utf-8") as stream:
        stream.write(event + "\n")
        stream.flush()


def on_term(_signum, _frame):
    record("TERM")
    if mode == "responsive":
        raise SystemExit(0)


signal.signal(signal.SIGTERM, on_term)
with open(ready_path, "w", encoding="utf-8") as stream:
    stream.write(str(os.getpid()))
while True:
    time.sleep(0.05)
'''


def _extract_reap_function() -> str:
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index("reap_orphan_agents() {")
    end = text.index("\n}\n", start) + len("\n}\n")
    return text[start:end]


def _extract_publish_function() -> str:
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index("publish_agent() {")
    end = text.index("\n}\n", start) + len("\n}\n")
    return text[start:end]


def _extract_docker_control_function() -> str:
    """reap_orphan_agents calls docker_control, not docker exec directly: the sandboxed
    runner script needs the real one-line definition, not a hand-copied stand-in."""
    for line in LAUNCHER.read_text(encoding="utf-8").splitlines():
        if line.startswith("docker_control()"):
            return line
    raise AssertionError("docker_control() definition not found in launcher")


def _create_forwarding_fake_docker(tmp_dir: pathlib.Path) -> pathlib.Path:
    script_path = tmp_dir / "docker"
    body = r"""#!/usr/bin/env bash
set -euo pipefail

[[ ${1:-} == exec ]] || exit 64
shift
while (($#)); do
  case "$1" in
    -i) shift ;;
    --user) shift 2 ;;
    --*) exit 64 ;;
    *) break ;;
  esac
done
(($# >= 2)) || exit 64
shift
exec "$@"
"""
    script_path.write_text(body, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


def _write_mock_agent(tmp_dir: pathlib.Path) -> None:
    package = tmp_dir / "cauce_pty_agent"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "__main__.py").write_text(MOCK_AGENT_SOURCE, encoding="utf-8")


def _wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class LauncherReapTest(unittest.TestCase):
    def _start_agent(
        self,
        tmp: pathlib.Path,
        bundle_path: pathlib.Path,
        mode: str,
        name: str,
        legacy_path: pathlib.Path | None = None,
        extra_args: tuple[str, ...] = (),
    ) -> tuple[subprocess.Popen[str], pathlib.Path]:
        ready = tmp / f"{name}.ready"
        events = tmp / f"{name}.events"
        env = dict(os.environ)
        env.update({
            "PYTHONPATH": str(tmp),
            "MOCK_AGENT_MODE": mode,
            "MOCK_AGENT_EVENT_PATH": str(events),
            "MOCK_AGENT_READY_PATH": str(ready),
        })
        command = ["/usr/bin/python3"]
        command.extend(
            ["-m", "cauce_pty_agent"] if legacy_path is None else [str(legacy_path)]
        )
        command.extend(["--bundle", str(bundle_path)])
        command.extend(extra_args)
        process = subprocess.Popen(
            command,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        threading.Thread(target=process.wait, daemon=True).start()
        self.assertTrue(_wait_for(ready.exists), "mock PTY agent did not become ready")
        return process, events

    def _run_reap(
        self,
        tmp: pathlib.Path,
        bundle_path: pathlib.Path,
        alias: str = "zeus",
        after_reap: str = "",
        docker_timeout: int = 10,
    ) -> subprocess.CompletedProcess[str]:
        runner_script = f"""
set -euo pipefail
die() {{ printf '%s\n' "$1" >&2; exit "${{2:-2}}"; }}
die_transient() {{ printf '%s\n' "$1" >&2; exit 75; }}
alias_name={shlex.quote(alias)}
container_id=deadbeef
runtime_uid=$(id -u)
runtime_gid=$(id -g)
bundle_path={shlex.quote(str(bundle_path))}
REAPER_SOURCE={shlex.quote(str(REAPER))}
DOCKER_CALL_TIMEOUT={docker_timeout}
{_extract_docker_control_function()}
{_extract_reap_function()}
reap_orphan_agents
{after_reap}
"""
        env = dict(os.environ)
        env["PATH"] = f"{tmp}:/usr/bin:/bin"
        return subprocess.run(
            ["bash", "-c", runner_script],
            capture_output=True,
            text=True,
            env=env,
            check=False,
            timeout=15,
        )

    @staticmethod
    def _terminate(process: subprocess.Popen[str]) -> None:
        if process.poll() is None:
            process.kill()
        _wait_for(lambda: process.poll() is not None)

    def test_term_responsive_agent_disappears_before_success(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            _write_mock_agent(tmp)
            _create_forwarding_fake_docker(tmp)
            bundle = tmp / ".cauce-pty-bundle-zeus.json"
            process, events = self._start_agent(tmp, bundle, "responsive", "responsive")
            try:
                result = self._run_reap(tmp, bundle)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(_wait_for(lambda: process.poll() is not None))
                self.assertEqual(process.returncode, 0)
                self.assertEqual(events.read_text(encoding="utf-8").splitlines(), ["TERM"])
                self.assertIn(f"alias=zeus pids={process.pid}", result.stderr)
            finally:
                self._terminate(process)

    def test_term_resistant_agent_is_killed_only_after_term_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            _write_mock_agent(tmp)
            _create_forwarding_fake_docker(tmp)
            bundle = tmp / ".cauce-pty-bundle-zeus.json"
            process, events = self._start_agent(tmp, bundle, "resistant", "resistant")
            started = time.monotonic()
            try:
                result = self._run_reap(tmp, bundle)
                elapsed = time.monotonic() - started
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertGreaterEqual(elapsed, 1.8)
                self.assertTrue(_wait_for(lambda: process.poll() is not None))
                self.assertEqual(process.returncode, -signal.SIGKILL)
                self.assertEqual(events.read_text(encoding="utf-8").splitlines(), ["TERM"])
            finally:
                self._terminate(process)

    def test_reaps_only_the_exact_alias_identity(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            _write_mock_agent(tmp)
            _create_forwarding_fake_docker(tmp)
            target_bundle = tmp / ".cauce-pty-bundle-zeus.json"
            neighbor_bundle = tmp / ".cauce-pty-bundle-kant.json"
            target, _events = self._start_agent(tmp, target_bundle, "responsive", "target-1")
            duplicate, _duplicate_events = self._start_agent(
                tmp, target_bundle, "responsive", "target-2",
            )
            neighbor, _neighbor_events = self._start_agent(tmp, neighbor_bundle, "responsive", "neighbor")
            try:
                (tmp / "cauce_pty_agent").rename(tmp / "loaded_agent_package")
                _write_mock_agent(tmp)
                self.assertIsNone(target.poll(), "loaded agent died when its modules were replaced")
                result = self._run_reap(tmp, target_bundle)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(_wait_for(lambda: target.poll() is not None))
                self.assertTrue(_wait_for(lambda: duplicate.poll() is not None))
                self.assertIsNone(neighbor.poll())
            finally:
                self._terminate(target)
                self._terminate(duplicate)
                self._terminate(neighbor)

    def test_legacy_exact_argv_is_reaped_without_touching_legacy_neighbor(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            _create_forwarding_fake_docker(tmp)
            suffix = uuid.uuid4().hex[:12]
            alias = f"legacy-{suffix}"
            neighbor_alias = f"neighbor-{suffix}"
            legacy = pathlib.Path(f"/var/tmp/cauce-pty-agent-{alias}.py")
            neighbor_legacy = pathlib.Path(f"/var/tmp/cauce-pty-agent-{neighbor_alias}.py")
            for path in (legacy, neighbor_legacy):
                with path.open("x", encoding="utf-8") as stream:
                    stream.write(MOCK_AGENT_SOURCE)
                self.addCleanup(path.unlink, missing_ok=True)
            target_bundle = tmp / f".cauce-pty-bundle-{alias}.json"
            neighbor_bundle = tmp / f".cauce-pty-bundle-{neighbor_alias}.json"
            target, _events = self._start_agent(
                tmp, target_bundle, "responsive", "legacy", legacy,
            )
            neighbor, _neighbor_events = self._start_agent(
                tmp, neighbor_bundle, "responsive", "legacy-neighbor", neighbor_legacy,
            )
            try:
                result = self._run_reap(tmp, target_bundle, alias)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(_wait_for(lambda: target.poll() is not None))
                self.assertIsNone(neighbor.poll())
            finally:
                self._terminate(target)
                self._terminate(neighbor)

    def test_no_matching_agent_is_a_clean_noop(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            _create_forwarding_fake_docker(tmp)
            result = self._run_reap(tmp, tmp / ".cauce-pty-bundle-zeus.json")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")

    def test_exact_argv_plus_empty_argument_is_never_signalled(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            _write_mock_agent(tmp)
            _create_forwarding_fake_docker(tmp)
            bundle = tmp / ".cauce-pty-bundle-zeus.json"
            process, events = self._start_agent(
                tmp, bundle, "responsive", "empty-argument", extra_args=("",),
            )
            try:
                result = self._run_reap(tmp, bundle)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(process.poll())
                self.assertFalse(events.exists(), "the non-matching process received TERM")
                self.assertEqual(result.stderr, "")
            finally:
                self._terminate(process)

    def test_semantic_reap_failure_78_prevents_exec(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            marker = tmp / "exec-reached"
            fake_docker = tmp / "docker"
            fake_docker.write_text("#!/usr/bin/env bash\nexit 78\n", encoding="utf-8")
            fake_docker.chmod(0o755)
            result = self._run_reap(
                tmp,
                tmp / ".cauce-pty-bundle-zeus.json",
                after_reap=f"printf reached > {shlex.quote(str(marker))}",
            )
            self.assertEqual(result.returncode, 78)
            self.assertFalse(marker.exists())
            self.assertIn("cannot prove prior PTY agent removal", result.stderr)

    def test_docker_exit_125_is_transient_and_prevents_exec(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            marker = tmp / "exec-reached"
            fake_docker = tmp / "docker"
            fake_docker.write_text("#!/usr/bin/env bash\nexit 125\n", encoding="utf-8")
            fake_docker.chmod(0o755)
            result = self._run_reap(
                tmp,
                tmp / ".cauce-pty-bundle-zeus.json",
                after_reap=f"printf reached > {shlex.quote(str(marker))}",
            )
            self.assertEqual(result.returncode, 75)
            self.assertFalse(marker.exists())
            self.assertIn("PTY reaper transport failed", result.stderr)

    def test_docker_timeout_is_transient_and_prevents_exec(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            marker = tmp / "exec-reached"
            fake_docker = tmp / "docker"
            fake_docker.write_text("#!/usr/bin/env bash\nsleep 10\n", encoding="utf-8")
            fake_docker.chmod(0o755)
            result = self._run_reap(
                tmp,
                tmp / ".cauce-pty-bundle-zeus.json",
                after_reap=f"printf reached > {shlex.quote(str(marker))}",
                docker_timeout=1,
            )
            self.assertEqual(result.returncode, 75)
            self.assertFalse(marker.exists())
            self.assertIn("status 124", result.stderr)

    def test_reap_follows_publication_and_generation_check_but_precedes_exec(self) -> None:
        launcher = LAUNCHER.read_text(encoding="utf-8")
        start = launcher[launcher.index("start_agent() {"):]
        reap = start.index("  reap_orphan_agents\n")
        self.assertLess(start.index("  publish_agent\n"), reap)
        self.assertLess(start.index("  publish_bundle\n"), reap)
        self.assertLess(start.index("  [[ $container_generation =="), reap)
        self.assertLess(reap, start.index("  exec docker exec"))


class ReapIdentityRaceTest(unittest.TestCase):
    def _namespace(self) -> dict[str, object]:
        loaded = runpy.run_path(str(REAPER), run_name="launcher_reap_test")
        return loaded["reap_candidate"].__globals__

    def test_capability_check_opens_self_pidfd_and_sends_only_signal_zero(self) -> None:
        namespace = self._namespace()
        with (
            mock.patch.object(namespace["os"], "getpid", return_value=321),
            mock.patch.object(namespace["os"], "pidfd_open", return_value=17) as pidfd_open,
            mock.patch.object(namespace["os"], "close") as close,
            mock.patch.object(namespace["signal"], "pidfd_send_signal") as send_signal,
        ):
            namespace["check_capabilities"]()
        pidfd_open.assert_called_once_with(321, 0)
        send_signal.assert_called_once_with(17, 0)
        close.assert_called_once_with(17)

    def test_capability_check_fails_closed_when_pidfd_is_unavailable(self) -> None:
        namespace = self._namespace()
        with mock.patch.object(namespace["os"], "pidfd_open", side_effect=OSError("blocked")):
            with self.assertRaises(namespace["ReapError"]):
                namespace["check_capabilities"]()

    def test_current_and_legacy_argv_are_exact_not_substring_matches(self) -> None:
        namespace = self._namespace()
        bundle = "/var/tmp/.cauce-pty-bundle-zeus.json"
        expected = namespace["expected_cmdlines"](bundle, "zeus")
        legacy = (
            b"/usr/bin/python3", b"/var/tmp/cauce-pty-agent-zeus.py",
            b"--bundle", os.fsencode(bundle),
        )
        self.assertIn(legacy, expected)
        self.assertNotIn((*legacy, b"unexpected"), expected)

    def test_cmdline_parser_preserves_intermediate_and_trailing_empty_arguments(self) -> None:
        namespace = self._namespace()
        raw = b"/usr/bin/python3\0\0--bundle\0bundle.json\0\0"
        self.assertEqual(
            namespace["parse_cmdline"](raw),
            (b"/usr/bin/python3", b"", b"--bundle", b"bundle.json", b""),
        )

    def test_discovery_fails_closed_for_unreadable_runtime_process(self) -> None:
        namespace = self._namespace()
        for error_number in (errno.EACCES, errno.EIO):
            with (
                self.subTest(error_number=error_number),
                mock.patch.object(namespace["os"], "listdir", return_value=["4242"]),
                mock.patch.object(namespace["os"], "geteuid", return_value=1000),
                mock.patch.object(
                    namespace["os"], "stat", return_value=mock.Mock(st_uid=1000),
                ),
                mock.patch(
                    "builtins.open",
                    side_effect=OSError(error_number, os.strerror(error_number)),
                ),
            ):
                with self.assertRaisesRegex(namespace["ReapError"], "PID 4242"):
                    namespace["discover"]("/var/tmp/bundle.json", "zeus")

    def test_discovery_fails_closed_for_malformed_runtime_identity(self) -> None:
        namespace = self._namespace()
        cmdline_reader = mock.mock_open(read_data=b"/usr/bin/python3\0")
        stat_reader = mock.mock_open(read_data="4242 (python) S")

        def open_proc(path, *_args, **_kwargs):
            return cmdline_reader() if str(path).endswith("/cmdline") else stat_reader()

        with (
            mock.patch.object(namespace["os"], "listdir", return_value=["4242"]),
            mock.patch.object(namespace["os"], "geteuid", return_value=1000),
            mock.patch.object(namespace["os"], "stat", return_value=mock.Mock(st_uid=1000)),
            mock.patch("builtins.open", side_effect=open_proc),
        ):
            with self.assertRaisesRegex(namespace["ReapError"], "parse identity for PID 4242"):
                namespace["discover"]("/var/tmp/bundle.json", "zeus")

    def test_pid_disappeared_before_pin_is_not_signalled(self) -> None:
        namespace = self._namespace()
        identity = (321, 456, (b"expected",))
        with (
            mock.patch.object(namespace["os"], "pidfd_open", side_effect=ProcessLookupError),
            mock.patch.object(namespace["signal"], "pidfd_send_signal") as send_signal,
        ):
            namespace["reap_candidate"](identity)
        send_signal.assert_not_called()

    def test_reused_pid_with_different_identity_is_not_signalled(self) -> None:
        namespace = self._namespace()
        original = (321, 456, (b"expected",))
        replacement = (321, 999, (b"unrelated",))
        with (
            mock.patch.object(namespace["os"], "pidfd_open", return_value=17),
            mock.patch.object(namespace["os"], "close") as close,
            mock.patch.object(namespace["signal"], "pidfd_send_signal") as send_signal,
            mock.patch.dict(namespace, {"read_identity": mock.Mock(return_value=replacement)}),
        ):
            namespace["reap_candidate"](original)
        send_signal.assert_not_called()
        close.assert_called_once_with(17)

    def test_identity_change_after_term_prevents_kill_escalation(self) -> None:
        namespace = self._namespace()
        original = (321, 456, (b"expected",))
        replacement = (321, 999, (b"unrelated",))
        send_pinned = mock.Mock(return_value=True)
        with (
            mock.patch.object(namespace["os"], "pidfd_open", return_value=17),
            mock.patch.object(namespace["os"], "close"),
            mock.patch.dict(namespace, {
                "read_identity": mock.Mock(side_effect=[original, replacement]),
                "send_pinned": send_pinned,
                "wait_identity_gone": mock.Mock(return_value=False),
            }),
        ):
            namespace["reap_candidate"](original)
        send_pinned.assert_called_once_with(17, signal.SIGTERM, 321)

    def test_failure_to_prove_disappearance_after_kill_fails_closed(self) -> None:
        namespace = self._namespace()
        identity = (321, 456, (b"expected",))
        with (
            mock.patch.object(namespace["os"], "pidfd_open", return_value=17),
            mock.patch.object(namespace["os"], "close"),
            mock.patch.dict(namespace, {
                "read_identity": mock.Mock(return_value=identity),
                "send_pinned": mock.Mock(return_value=True),
                "wait_identity_gone": mock.Mock(side_effect=[False, False]),
            }),
        ):
            with self.assertRaises(namespace["ReapError"]):
                namespace["reap_candidate"](identity)


class CapabilityPreflightTest(unittest.TestCase):
    def test_installer_checks_target_pidfd_before_preflight_success_or_install(self) -> None:
        installer = INSTALLER.read_text(encoding="utf-8")
        probe = installer.index("/usr/bin/python3 - --check-capabilities")
        self.assertIn('docker_control exec -i --user "$runtime_uid:$runtime_gid"', installer)
        self.assertIn('< "$REAPER_SOURCE"', installer)
        self.assertLess(probe, installer.index("if (( PREFLIGHT_ONLY == 1 ))"))
        self.assertLess(probe, installer.index("install -m 0644"))


class PublishReplacesTheAgentRootInsteadOfMerging(unittest.TestCase):
    """`/var/tmp` es 1777 y la raiz del agente la comparten todos los releases: fusionar sobre lo
    que ya hay deja un modulo retirado por un release posterior —o un `.py` que el usuario runtime
    hubiera plantado antes del lanzamiento— dentro del PYTHONPATH del proceso que sostiene el
    certificado del alias. `docker cp` solo sobrescribe los ficheros que trae, nunca borra."""

    def _docker_commands(self) -> list[str]:
        with tempfile.TemporaryDirectory() as raw:
            tmp = pathlib.Path(raw)
            log = tmp / "docker.log"
            fake = tmp / "docker"
            fake.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >>"$DOCKER_LOG"\n', encoding="utf-8")
            fake.chmod(0o755)
            runner_script = f"""
set -uo pipefail
die() {{ printf '%s\n' "$1" >&2; exit "${{2:-2}}"; }}
container_id=deadbeef
agent_root=/var/tmp/cauce-pty-agent-zeus
AGENT_SOURCE=/opt/cauce/pty-agent/cauce_pty_agent
DOCKER_CALL_TIMEOUT=30
{_extract_docker_control_function()}
{_extract_publish_function()}
publish_agent
"""
            done = subprocess.run(
                ["bash", "-c", runner_script],
                capture_output=True,
                text=True,
                env={"PATH": f"{tmp}:/usr/bin:/bin", "DOCKER_LOG": str(log)},
                check=False,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            return log.read_text(encoding="utf-8").splitlines()

    def test_the_root_is_removed_and_recreated_before_the_package_is_copied(self) -> None:
        commands = self._docker_commands()
        removals = [index for index, line in enumerate(commands) if "rm -rf" in line]
        copies = [index for index, line in enumerate(commands) if line.startswith("cp ")]
        self.assertEqual(len(removals), 1, commands)
        self.assertEqual(len(copies), 1, commands)
        self.assertIn("mkdir -p", commands[removals[0]])
        self.assertIn("/var/tmp/cauce-pty-agent-zeus", commands[removals[0]])
        self.assertLess(removals[0], copies[0])

    def test_control_negativo_the_copy_is_still_owned_and_locked_down_afterwards(self) -> None:
        commands = self._docker_commands()
        copy = next(index for index, line in enumerate(commands) if line.startswith("cp "))
        rest = commands[copy + 1:]
        self.assertTrue(any("chown -R 0:0" in line for line in rest), commands)
        self.assertTrue(any("chmod -R a=rX" in line for line in rest), commands)


if __name__ == "__main__":
    unittest.main()
