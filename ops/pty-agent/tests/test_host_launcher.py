"""El launcher nativo acredita el proceso de systemd antes de abrir un canal."""
import json
import os
import pwd
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "pty-agent/cauce-pty-host-launcher.sh"


class NativeHostLauncher(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.uid = pwd.getpwnam("nobody").pw_uid if os.geteuid() == 0 else os.geteuid()
        self.gid = pwd.getpwuid(self.uid).pw_gid
        self.home = self.base / "home"
        self.config = self.base / "config"
        self.pki = self.base / "pki/hostprobe"
        for directory in (self.home / ".codex", self.config, self.pki, self.base / "bin", self.base / "dist/src/bin"):
            directory.mkdir(parents=True, exist_ok=True)
        self.adapter = self.base / "dist/src/bin/codex.js"
        self.adapter.write_text("import time\ntime.sleep(120)\n")
        for name in ("client.crt", "client.key", "ca.crt"):
            (self.pki / name).write_text("-----BEGIN TEST MATERIAL-----\n")
            (self.pki / name).chmod(0o600)
        (self.pki / "alias-key.hex").write_text("ab" * 32)
        (self.pki / "alias-key.hex").chmod(0o400)
        self.write_config()
        for path in (self.base, *self.base.rglob("*")):
            if path.is_dir():
                path.chmod(0o700)
            if os.geteuid() == 0:
                os.chown(path, self.uid, self.gid)
        env = {**os.environ, "CAUCE_ALIAS": "hostprobe", "CAUCE_TENANT": "Steven", "HOME": str(self.home),
               "CAUCE_SHARED_SESSION": "1", "CAUCE_SHARED_SESSION_WORKSPACE": str(self.home)}
        self.process = subprocess.Popen(["python3", str(self.adapter)], env=env, cwd=self.home, **self.credentials())
        systemctl = self.base / "bin/systemctl"
        systemctl.write_text(f"#!/bin/sh\nprintf '%s\\n' '{self.process.pid}'\n")
        tmux = self.base / "bin/tmux"
        tmux.write_text(f"#!/bin/sh\nprintf '%s\\n' 'hostprobe|codex|0|1|{self.home}'\n")
        for path in (systemctl, tmux):
            path.chmod(0o755)
            if os.geteuid() == 0:
                os.chown(path, self.uid, self.gid)

    def credentials(self):
        return {"user": self.uid, "group": self.gid, "extra_groups": []} if os.geteuid() == 0 else {}

    def write_config(self, alias="hostprobe", tenant="Steven"):
        path = self.config / f"{alias}.env"
        path.write_text(f"TENANT_ID={tenant}\nADAPTER_UNIT=cauce-v3-host-hostprobe.service\n"
                        f"RELAY_HOST=127.0.0.1\nRELAY_PORT=1\nPKI_DIR={self.pki}\n"
                        f"ALIAS_KEY_FILE={self.pki}/alias-key.hex\n")
        path.chmod(0o600)
        if os.geteuid() == 0:
            os.chown(path, self.uid, self.gid)

    def launch(self, alias="hostprobe"):
        return subprocess.run(["bash", str(LAUNCHER), "--preflight-only", alias], capture_output=True, text=True,
                              cwd=self.home, env={**os.environ, "CAUCE_PTY_RELEASE_ROOT": str(ROOT),
                              "CAUCE_PTY_HOST_CONFIG_ROOT": str(self.config), "PATH": f"{self.base}/bin:{os.environ['PATH']}"},
                              **self.credentials())

    def tearDown(self):
        self.process.terminate()
        self.process.wait(timeout=5)
        self.temp.cleanup()

    def test_preflight_measures_the_running_adapter_without_connecting_to_relay(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed["status"], "ready")
        self.assertEqual(observed["runtime_uid"], self.uid)
        self.assertEqual(observed["profile"], str(self.home / ".codex"))
        self.assertEqual(observed["workspace"], str(self.home))

    def test_another_alias_cannot_use_the_unit_process(self):
        self.write_config(alias="other")
        result = self.launch("other")
        self.assertEqual(result.returncode, 78)
        self.assertIn("does not accredit", result.stderr)

    def test_another_tenant_cannot_use_the_unit_process(self):
        self.write_config(tenant="Miguel")
        result = self.launch()
        self.assertEqual(result.returncode, 78)
        self.assertIn("tenant", result.stderr)
