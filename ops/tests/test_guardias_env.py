#!/usr/bin/env python3
"""Missing private guard variables must name themselves and must not kill the monitor."""
from __future__ import annotations

import configparser
import contextlib
import importlib.machinery
import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
GUARD = ROOT / "ops/guardias"
REPAIR = GUARD / "cauce-v3-medico-monitor-reparacion-lib.py"
MONITOR = GUARD / "cauce-v3-medico-monitor"
CRED = GUARD / "cred-guard.py"
AI_LIVE = GUARD / "cauce-ai-live"
EVIDENCE = ROOT / "ops/instances/hospital/praxis-supervision-evidence.py"
DEPLOY = ROOT / "deploy/decisiones/desplegar.sh"
CLI = ROOT / "ops/cli/cauce"
USER_ENV = "%h/.config/cauce/guardias.env"
HOSPITAL_ENV = "/etc/cauce-v3-hospital/guardias.env"


def _unit(path: pathlib.Path) -> configparser.SectionProxy:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(path, encoding="utf-8")
    return parser["Service"]


def _exec_repair(namespace: dict) -> None:
    exec(compile(REPAIR.read_text(encoding="utf-8"), str(REPAIR), "exec"), namespace)


class GuardEnvironmentTests(unittest.TestCase):
    def test_units_point_at_a_private_env_file_outside_the_repo(self) -> None:
        cred = _unit(GUARD / "systemd/cred-guard.service")
        kratos = _unit(GUARD / "systemd/cauce-cred-guard-kratos.service")
        doctor = _unit(GUARD / "systemd/cauce-v3-medico-monitor.service")
        live = _unit(GUARD / "systemd/cauce-ai-live.service")
        praxis = _unit(ROOT / "ops/instances/hospital/praxis-supervision.service")
        self.assertEqual(cred["EnvironmentFile"], USER_ENV)
        self.assertEqual(kratos["EnvironmentFile"], USER_ENV)
        self.assertEqual(doctor["EnvironmentFile"], "-" + USER_ENV)
        self.assertEqual(live["EnvironmentFile"], "-" + USER_ENV)
        self.assertEqual(praxis["EnvironmentFile"], HOSPITAL_ENV)
        for service in (cred, kratos, doctor, live, praxis):
            self.assertNotIn("CAUCE_CRED_GUARD_TARGETS=", service.get("Environment", ""))
            self.assertNotIn("CAUCE_OWNER_TELEGRAM_CHAT_ID=", service.get("Environment", ""))

    def test_cred_guard_names_the_missing_variable(self) -> None:
        env = os.environ.copy()
        env.pop("CAUCE_CRED_GUARD_TARGETS", None)
        env.pop("CAUCE_CRED_GUARD_ESTADO", None)
        result = subprocess.run(
            [sys.executable, str(CRED)],
            env=env, capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("falta CAUCE_CRED_GUARD_TARGETS", result.stderr)

    def test_decisions_deploy_names_the_missing_variable(self) -> None:
        env = {key: value for key, value in os.environ.items() if key != "CAUCE_DECISIONES_SMOKE_PKI"}
        missing = subprocess.run(
            ["bash", str(DEPLOY), "estado"],
            env=env, capture_output=True, text=True, timeout=20, check=False,
        )
        self.assertEqual(missing.returncode, 1)
        self.assertIn("falta CAUCE_DECISIONES_SMOKE_PKI", missing.stderr)
        env["CAUCE_DECISIONES_SMOKE_PKI"] = ""
        empty = subprocess.run(
            ["bash", str(DEPLOY), "estado"],
            env=env, capture_output=True, text=True, timeout=20, check=False,
        )
        self.assertEqual(empty.returncode, 1)
        self.assertIn("falta CAUCE_DECISIONES_SMOKE_PKI", empty.stderr)

    def test_remote_user_names_the_missing_or_invalid_variable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = self._cauce(tmp, None)
            self.assertEqual(missing.returncode, 2, missing.stderr)
            self.assertIn("falta CAUCE_REMOTE_USER", missing.stderr)
            self.assertFalse((pathlib.Path(tmp) / "ssh.log").exists())
            invalid = self._cauce(tmp, "NOPE")
            self.assertEqual(invalid.returncode, 2, invalid.stderr)
            self.assertIn("CAUCE_REMOTE_USER invalido", invalid.stderr)
            self.assertFalse((pathlib.Path(tmp) / "ssh.log").exists())

    def test_codex_home_names_the_variable_and_keeps_the_generic_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {
            "XDG_DATA_HOME": tmp,
            "CAUCE_AI_USAGE_LIVE_DIR": str(pathlib.Path(tmp) / "usage"),
            "CAUCE_AI_LIVE_CUENTAS": str(pathlib.Path(tmp) / "usage" / "accounts.json"),
        }):
            os.environ.pop("CODEX_HOME", None)
            base = pathlib.Path(tmp) / "cauce-ai-live"
            base.mkdir()
            (base / "cdp.py").write_text("abre = None\nclass Pagina:\n    pass\n", encoding="utf-8")
            loader = importlib.machinery.SourceFileLoader("cauce_ai_live_env", str(AI_LIVE))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            assert spec is not None
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                home = module.resolve_codex_home()
            self.assertIn("falta CODEX_HOME", stderr.getvalue())
            self.assertEqual(home, os.path.expanduser("~/.codex"))
            with mock.patch.dict(os.environ, {"CODEX_HOME": "/var/lib/cauce/codex"}):
                quiet = io.StringIO()
                with contextlib.redirect_stderr(quiet):
                    self.assertEqual(module.resolve_codex_home(), "/var/lib/cauce/codex")
                self.assertNotIn("falta CODEX_HOME", quiet.getvalue())

    def test_praxis_names_the_missing_chat_and_keeps_the_error_code(self) -> None:
        spec = importlib.util.spec_from_file_location("praxis_env_evidence", EVIDENCE)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class State:
            class SupervisionError(Exception):
                def __init__(self, code: str) -> None:
                    super().__init__(code)
                    self.code = code

        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=False), contextlib.redirect_stderr(stderr):
            os.environ.pop("CAUCE_OWNER_TELEGRAM_CHAT_ID", None)
            with self.assertRaises(State.SupervisionError) as caught:
                module.owner_conversation_id(State)
        self.assertEqual(caught.exception.code, "owner_conversation_unconfigured")
        self.assertIn("falta CAUCE_OWNER_TELEGRAM_CHAT_ID", stderr.getvalue())

    def test_monitor_logs_a_missing_chat_and_keeps_running(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = pathlib.Path(tmp) / "bitacora.log"
            stderr = io.StringIO()
            namespace = {
                "__name__": "__main__",
                "os": os,
                "sys": sys,
                "ESTADO_DIR": tmp,
                "BITACORA_LOG": str(log),
            }
            with mock.patch.dict(os.environ, {}, clear=False), contextlib.redirect_stderr(stderr):
                os.environ.pop("CAUCE_OWNER_TELEGRAM_CHAT_ID", None)
                _exec_repair(namespace)
                namespace["kept_running"] = True
            self.assertTrue(namespace["kept_running"])
            self.assertIn("falta CAUCE_OWNER_TELEGRAM_CHAT_ID", stderr.getvalue())
            self.assertIn("falta CAUCE_OWNER_TELEGRAM_CHAT_ID", log.read_text(encoding="utf-8"))
            self.assertIn(
                '_cargar_lib("cauce-v3-medico-monitor-reparacion-lib.py")',
                MONITOR.read_text(encoding="utf-8"),
            )

    def test_monitor_does_not_log_when_imported_or_when_the_chat_is_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = pathlib.Path(tmp) / "bitacora.log"
            stderr = io.StringIO()
            with mock.patch.dict(os.environ, {}, clear=False), contextlib.redirect_stderr(stderr):
                os.environ.pop("CAUCE_OWNER_TELEGRAM_CHAT_ID", None)
                _exec_repair({
                    "__name__": "medico_monitor_tokens",
                    "os": os,
                    "sys": sys,
                    "ESTADO_DIR": tmp,
                    "BITACORA_LOG": str(log),
                })
            self.assertEqual(stderr.getvalue(), "")
            self.assertFalse(log.exists())
            with mock.patch.dict(os.environ, {"CAUCE_OWNER_TELEGRAM_CHAT_ID": "1000000001"}), \
                    contextlib.redirect_stderr(stderr):
                _exec_repair({
                    "__name__": "__main__",
                    "os": os,
                    "sys": sys,
                    "ESTADO_DIR": tmp,
                    "BITACORA_LOG": str(log),
                })
            self.assertEqual(stderr.getvalue(), "")
            self.assertFalse(log.exists())

    def test_notice_names_the_missing_chat_without_calling_transport(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            namespace = {
                "__name__": "repair_test",
                "os": os,
                "sys": sys,
                "json": __import__("json"),
                "ESTADO_DIR": tmp,
                "BITACORA_LOG": str(pathlib.Path(tmp) / "bitacora.log"),
                "PLANTILLA_AVISO": "chat = os.environ['CAUCE_OWNER_TELEGRAM_CHAT_ID']\n",
                "notice_identity": lambda: ("acme", "zeus"),
                "sh": lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")),
            }
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CAUCE_OWNER_TELEGRAM_CHAT_ID", None)
                _exec_repair(namespace)
                self.assertEqual(namespace["avisar"]("hola"), (False, "falta CAUCE_OWNER_TELEGRAM_CHAT_ID"))
            namespace["notice_identity"] = lambda: None
            self.assertEqual(namespace["avisar"]("hola"), (False, "OUT_OF_SCOPE_NOTICE"))
            seen: dict[str, str] = {}

            def capture(_host, _command, entrada=None, timeout=90):
                seen["entrada"] = entrada or ""
                return 0, "enviado", ""

            namespace["notice_identity"] = lambda: ("acme", "zeus")
            namespace["sh"] = capture
            with mock.patch.dict(os.environ, {"CAUCE_OWNER_TELEGRAM_CHAT_ID": "1000000001"}):
                self.assertEqual(namespace["avisar"]("hola"), (True, "stderr_chars=0"))
            self.assertIn("1000000001", seen["entrada"])
            self.assertIn("CAUCE_OWNER_TELEGRAM_CHAT_ID", seen["entrada"])

    def test_operation_doc_lists_obligatory_variables_and_the_reinstall_warning(self) -> None:
        text = (ROOT / "docs/operacion.md").read_text(encoding="utf-8")
        start = text.index("### Guardias: variables obligatorias")
        end = text.index("**Regla de orden con el plano PTY**", start)
        section = text[start:end]
        for name in (
            "CAUCE_CRED_GUARD_TARGETS",
            "CAUCE_OWNER_TELEGRAM_CHAT_ID",
            "CAUCE_DECISIONES_SMOKE_PKI",
            "CAUCE_REMOTE_USER",
            "CODEX_HOME",
        ):
            self.assertIn(name, section)
        self.assertIn("reinstalar", section)
        self.assertIn("1000000001", section)
        self.assertIn("/etc/cauce-v3-hospital/guardias.env", section)
        self.assertIn("%h/.config/cauce/guardias.env", section)
        self.assertIn("~/.config/cauce-v3/", section)
        self.assertIn("0600", section)
        self.assertIn("usuario que ejecuta la unit", section)
        self.assertNotIn("/home/", section)
        self.assertNotIn("/datos/", section)

    def _cauce(self, tmp: str, remote_user: str | None) -> subprocess.CompletedProcess[str]:
        root = pathlib.Path(tmp)
        home = root / "cli-home"
        bindir = root / "bin"
        scripts = home / ".local/share/cauce-v3/ops/scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        bindir.mkdir(exist_ok=True)
        (scripts / "container-alias-query.py").write_text(
            "import sys\n"
            "if '--runtime-key' in sys.argv:\n"
            "    print(sys.argv[1])\n"
            "    raise SystemExit(0)\n"
            "raise SystemExit('unexpected')\n",
            encoding="utf-8",
        )
        config = home / ".config/cauce-v3"
        config.mkdir(parents=True, exist_ok=True)
        (config / "alias-host.tsv").write_text("fixture\tvps\n", encoding="utf-8")
        marker = root / "ssh.log"
        (bindir / "getent").write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = passwd ]; then\n"
            f"  printf '%s\\n' 'tester:x:{os.getuid()}:{os.getgid()}::{home}:/bin/sh'\n"
            "  exit 0\n"
            "fi\n"
            "exec /usr/bin/getent \"$@\"\n",
            encoding="utf-8",
        )
        (bindir / "ssh").write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' called >> {marker}\n"
            "exit 0\n",
            encoding="utf-8",
        )
        os.chmod(bindir / "getent", 0o755)
        os.chmod(bindir / "ssh", 0o755)
        env = os.environ.copy()
        env.pop("CAUCE_FLEET_RUNTIME_STATE", None)
        if remote_user is None:
            env.pop("CAUCE_REMOTE_USER", None)
        else:
            env["CAUCE_REMOTE_USER"] = remote_user
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        env["HOME"] = str(home)
        return subprocess.run(
            ["bash", str(CLI), "fixture", "estado"],
            env=env, capture_output=True, text=True, timeout=20, check=False,
        )


if __name__ == "__main__":
    unittest.main()
