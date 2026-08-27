from __future__ import annotations

import pathlib
import subprocess
import tempfile
import unittest

LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / "cauce-pty-launcher.sh"


def _extract_reap_function() -> str:
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index("reap_orphan_agents() {")
    end = text.index("\n}\n", start) + len("\n}\n")
    return text[start:end]


def _create_fake_docker(tmp_dir: pathlib.Path) -> pathlib.Path:
    script_path = tmp_dir / "docker"
    body = r"""#!/usr/bin/env bash
set -euo pipefail

if [[ $1 == "exec" ]]; then
  shift 2
  if [[ $1 == "sh" && $2 == "-c" ]]; then
    cmd=$3
    if [[ $cmd == *"ps -eo pid,args"* ]]; then
      printf '%s\n' "${MOCK_PROCESSES:-}" | awk -v s="cauce-pty-agent-$alias_name.py" 'index($0, s) && $2 != "awk" {print $1}'
      exit 0
    elif [[ $cmd == *"kill"* ]]; then
      pid=$(echo "$cmd" | grep -oE 'kill [0-9]+' | awk '{print $2}')
      proc_line=$(printf '%s\n' "${MOCK_PROCESSES:-}" | awk -v p="$pid" '$1 == p {print $0}')
      if [[ -n "$proc_line" && "$proc_line" == *"cauce-pty-agent-$alias_name.py"* ]]; then
        echo "$pid" >> "$KILL_LOG"
        exit 0
      fi
      exit 1
    fi
  fi
fi
exit 0
"""
    script_path.write_text(body, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


class LauncherReapTest(unittest.TestCase):
    def _run_reap(
        self,
        alias: str,
        mock_processes: str,
        *,
        container_id: str = "c0ffee123456",
    ) -> tuple[int, str, str, list[str]]:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            kill_log = tmp / "killed.log"
            _create_fake_docker(tmp)

            runner_script = f"""
alias_name={alias}
container_id={container_id}
export alias_name container_id
{_extract_reap_function()}
reap_orphan_agents
"""
            env = {
                "PATH": f"{tmp}:/usr/bin:/bin",
                "KILL_LOG": str(kill_log),
                "MOCK_PROCESSES": mock_processes,
            }
            res = subprocess.run(
                ["bash", "-c", runner_script],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            killed = kill_log.read_text(encoding="utf-8").splitlines() if kill_log.exists() else []
            return res.returncode, res.stdout, res.stderr, killed

    def test_reaps_only_matching_alias_orphans(self) -> None:
        processes = "\n".join([
            "1 /sbin/init",
            "101 /usr/bin/python3 /tmp/cauce-pty-agent-zeus.py --bundle /tmp/bundle.json",
            "102 python3 /opt/cauce-pty-agent-zeus.py",
            "201 python3 /tmp/cauce-pty-agent-kant.py --bundle /tmp/bundle.json",
            "301 python3 /tmp/cauce-pty-agent.py",
            "401 /usr/local/bin/claude",
        ])
        code, stdout, stderr, killed = self._run_reap("zeus", processes)
        self.assertEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn("cauce-pty-launcher: reaping orphan agents alias=zeus pids=101 102", stderr)
        self.assertEqual(killed, ["101", "102"])

    def test_respects_other_aliases_and_legitimate_processes(self) -> None:
        processes = "\n".join([
            "1 /sbin/init",
            "201 python3 /tmp/cauce-pty-agent-kant.py --bundle /tmp/bundle.json",
            "202 python3 /tmp/cauce-pty-agent-hermes.py",
            "301 python3 /tmp/cauce-pty-agent.py",
            "401 /usr/local/bin/claude",
            "501 /bin/bash",
        ])
        code, stdout, stderr, killed = self._run_reap("zeus", processes)
        self.assertEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "")
        self.assertEqual(killed, [])

    def test_tolerates_empty_process_list_or_no_orphans(self) -> None:
        for empty_input in ("", "1 /sbin/init", "100 /bin/sh"):
            with self.subTest(processes=empty_input):
                code, stdout, stderr, killed = self._run_reap("zeus", empty_input)
                self.assertEqual(code, 0)
                self.assertEqual(stdout, "")
                self.assertEqual(stderr, "")
                self.assertEqual(killed, [])

    def test_tolerates_process_exiting_before_kill_verification(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = pathlib.Path(raw_tmp)
            kill_log = tmp / "killed.log"
            fake_docker = tmp / "docker"
            fake_docker.write_text(r"""#!/usr/bin/env bash
if [[ $1 == "exec" ]]; then
  shift 2
  if [[ $1 == "sh" && $2 == "-c" ]]; then
    cmd=$3
    if [[ $cmd == *"ps -eo pid,args"* ]]; then
      printf '101\n'
      exit 0
    elif [[ $cmd == *"kill"* ]]; then
      # Simulate process vanished between discovery and kill
      exit 1
    fi
  fi
fi
exit 0
""", encoding="utf-8")
            fake_docker.chmod(0o755)

            runner_script = f"""
alias_name=zeus
container_id=deadbeef
export alias_name container_id
{_extract_reap_function()}
reap_orphan_agents
"""
            env = {
                "PATH": f"{tmp}:/usr/bin:/bin",
                "KILL_LOG": str(kill_log),
            }
            res = subprocess.run(
                ["bash", "-c", runner_script],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            self.assertEqual(res.returncode, 0)
            self.assertIn("cauce-pty-launcher: reaping orphan agents alias=zeus pids=101", res.stderr)
            self.assertFalse(kill_log.exists())


if __name__ == "__main__":
    unittest.main()
