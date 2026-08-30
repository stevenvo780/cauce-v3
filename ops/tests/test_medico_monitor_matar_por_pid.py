#!/usr/bin/env python3
"""Regression test: `matar_por_pid` must never kill the adapter's own HOST-side `docker
exec` client, only the actual turn bridge. RE_PUENTE/RE_PUENTE_NATIVO are unanchored
`.search()`, so a client whose argv carries a bridge path as DATA (one argument among many)
matches them too; without an identity guard beyond that regex, the client -- and with it the
whole adapter connection -- gets killed instead of the stuck turn.

Everything here is synthetic: no real PID, no real docker, no real subprocess. `sh()` is
replaced with a fake that answers only the exact commands the fix is allowed to issue, and
records every one of them so a wrongly-issued `kill` on the guarded PID fails the test loudly
instead of silently.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import pathlib
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "guardias" / "cauce-v3-medico-monitor"
_loader = importlib.machinery.SourceFileLoader("medico_monitor", str(SCRIPT))
_spec = importlib.util.spec_from_file_location("medico_monitor", SCRIPT, loader=_loader)
assert _spec and _spec.loader
MODULE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MODULE)

# The real turn bridge: what the doctor MUST be able to kill.
PID_PUENTE = 4242
CMD_PUENTE = (
    "node /opt/cauce-v3-adapter/kratos/releases/rel1/packages/adapter-sdk/dist/bridge/"
    "hermes-stdin-bridge.py --alias kratos"
)

# The supervisor's own `docker exec` client for the SAME alias. Its argv carries, as ONE of
# its own arguments (an --init-starttime-adjacent env value), a bridge path as DATA -- exactly
# the shape that makes an unanchored `RE_PUENTE.search()` false-positive on it. This is the
# literal cmdline shape systemd tracks as the unit's MainPID (container-adapter-supervisor.sh
# does `exec docker exec ...`).
PID_CLIENTE = 1001
CMD_CLIENTE = (
    "docker exec -i --user 0 abc123def /usr/bin/python3 "
    "/opt/cauce-v3-adapter/kratos/cauce-container-runtime.py guard-exec --init-starttime 111 "
    "/usr/bin/env -i "
    "CAUCE_HERMES_SOURCE_DIR=/opt/cauce-v3-adapter/kratos/releases/rel1/packages/adapter-sdk/"
    "dist/bridge/hermes-stdin-bridge.py "
    "/usr/bin/python3 /opt/cauce-v3-adapter/kratos/cauce-container-runtime.py run "
    "--alias kratos --state /state --control-dir /control --runtime-uid 1000 --runtime-gid 1000 "
    "--container-id abc123def --generation 1 --bundle /bundle --bundle-digest sha256:deadbeef "
    "/opt/cauce-v3-adapter/kratos/releases/rel1/packages/adapter-sdk/dist/src/bin/codex.js"
)

CONTENEDOR = "abc123def"
PID_INTERNO_PUENTE = 77

# Second alias sharing the SAME container as kratos (e.g. ws-humanizar hosts both atlas and
# kratos): its bridge must never be picked when the caller asked for kratos.
ALIAS_VECINO = "atlas"
PID_INTERNO_PUENTE_VECINO = 88
CMD_PUENTE_VECINO = (
    "node /opt/cauce-v3-adapter/atlas/releases/rel1/packages/adapter-sdk/dist/bridge/"
    "hermes-stdin-bridge.py --alias atlas"
)


class FakeSh:
    """Records every command issued and answers only what this fix is allowed to ask."""

    def __init__(self, cmdlines, ps_contenedor=""):
        self.cmdlines = dict(cmdlines)  # pid -> cmdline (host /proc)
        self.ps_contenedor = ps_contenedor  # `docker exec <c> ps -eo pid,args` output
        self.alive = set(self.cmdlines)  # pids still present in /proc
        # Every PID the fake `ps` reports starts alive, not just PID_INTERNO_PUENTE: a
        # two-bridge container must be able to keep the neighbor alive while its own dies.
        self.alive_contenedor = set()
        for linea in ps_contenedor.split("\n"):
            partes = linea.strip().split(None, 1)
            if partes and partes[0].isdigit():
                self.alive_contenedor.add(int(partes[0]))
        self.calls = []

    def __call__(self, host, comando, entrada=None, timeout=90):
        self.calls.append((host, comando))
        if comando.startswith("tr '\\0' ' ' < /proc/"):
            pid = int(comando.split("/proc/")[1].split("/cmdline")[0])
            if pid not in self.alive:
                return 1, "", ""
            return 0, self.cmdlines.get(pid, ""), ""
        if comando.startswith("test -d /proc/"):
            pid = int(comando.split("/proc/")[1])
            return (0, "", "") if pid in self.alive else (1, "", "")
        if comando.startswith("kill -TERM ") or comando.startswith("kill -KILL "):
            pid = int(comando.rsplit(" ", 1)[1])
            self.alive.discard(pid)
            return 0, "", ""
        if comando.startswith(f"docker exec {CONTENEDOR} ps -eo pid,args"):
            return 0, self.ps_contenedor, ""
        if comando.startswith(f"docker exec {CONTENEDOR} test -d /proc/"):
            pid = int(comando.rsplit("/", 1)[1])
            return (0, "", "") if pid in self.alive_contenedor else (1, "", "")
        if comando.startswith(f"docker exec {CONTENEDOR} kill -TERM ") or \
           comando.startswith(f"docker exec {CONTENEDOR} kill -KILL "):
            pid = int(comando.rsplit(" ", 1)[1])
            self.alive_contenedor.discard(pid)
            return 0, "", ""
        if comando == "sleep 10" or comando == "sleep 5" or comando == "sleep 20":
            return 0, "", ""
        raise AssertionError(f"unexpected command issued: {comando!r}")

    def kill_calls(self):
        return [c for h, c in self.calls if "kill -" in c]


class TestEsSupervisorNoPuente(unittest.TestCase):
    def test_docker_exec_client_is_recognized(self):
        self.assertTrue(MODULE.es_supervisor_no_puente(CMD_CLIENTE))

    def test_real_bridge_is_not_recognized(self):
        self.assertFalse(MODULE.es_supervisor_no_puente(CMD_PUENTE))

    def test_bridge_path_alone_does_not_trip_it(self):
        # A bridge cmdline embedding nothing supervisor-shaped must stay untouched by the guard.
        self.assertFalse(MODULE.es_supervisor_no_puente(
            "node /opt/cauce-v3-adapter/iza/releases/r9/packages/adapter-sdk/dist/bridge/"
            "openclaw-stdin-bridge.mjs"))


class TestMatarPorPid(unittest.TestCase):
    def test_docker_exec_client_is_never_killed_on_host(self):
        """RED before the fix: RE_PUENTE.search() matched CMD_CLIENTE (the bridge path is
        embedded as one of its own arguments), so `matar_por_pid` sent it TERM then KILL."""
        fake = FakeSh({PID_CLIENTE: CMD_CLIENTE})
        with mock.patch.object(MODULE, "sh", fake):
            ok, motivo = MODULE.matar_por_pid("vps", PID_CLIENTE, CMD_CLIENTE)
        self.assertFalse(ok)
        self.assertIn("no se toca", motivo)
        self.assertEqual(fake.kill_calls(), [],
                         "the docker exec client received a kill signal")
        self.assertIn(PID_CLIENTE, fake.alive, "the supervisor's own PID was killed")

    def test_real_bridge_process_is_killed(self):
        """The actual turn bridge, with no supervisor signature in its cmdline, must still
        be killed exactly as before the fix."""
        fake = FakeSh({PID_PUENTE: CMD_PUENTE})
        with mock.patch.object(MODULE, "sh", fake):
            ok, motivo = MODULE.matar_por_pid("vps", PID_PUENTE, CMD_PUENTE)
        self.assertTrue(ok, motivo)
        self.assertIn(PID_PUENTE, [int(c.rsplit(" ", 1)[1]) for c in fake.kill_calls()])
        self.assertNotIn(PID_PUENTE, fake.alive)

    def test_reused_pid_that_no_longer_matches_is_left_alone(self):
        fake = FakeSh({PID_PUENTE: "sshd: someone@pts/3"})
        with mock.patch.object(MODULE, "sh", fake):
            ok, motivo = MODULE.matar_por_pid("vps", PID_PUENTE, CMD_PUENTE)
        self.assertFalse(ok)
        self.assertIn("cambio de identidad", motivo)
        self.assertEqual(fake.kill_calls(), [])

    def test_client_with_known_container_falls_back_inside(self):
        """When the alias's container is known, a supervisor-shaped host PID must not just
        be refused -- the doctor must find and kill the REAL bridge from inside the
        container instead, by a PID read from the container's own process table."""
        ps_contenedor = "\n".join([
            "  1 /usr/bin/python3 /control/cauce-container-runtime.py run --alias kratos x",
            f"{PID_INTERNO_PUENTE:4d} node /opt/cauce-v3-adapter/kratos/releases/rel1/packages/adapter-sdk/dist/"
            "bridge/hermes-stdin-bridge.py --alias kratos",
        ])
        fake = FakeSh({PID_CLIENTE: CMD_CLIENTE}, ps_contenedor=ps_contenedor)
        with mock.patch.object(MODULE, "sh", fake):
            ok, motivo = MODULE.matar_por_pid(
                "vps", PID_CLIENTE, CMD_CLIENTE, contenedor=CONTENEDOR, alias="kratos")
        self.assertTrue(ok, motivo)
        # The host PID (the client) was never signaled.
        self.assertIn(PID_CLIENTE, fake.alive)
        for _, comando in fake.calls:
            self.assertNotIn(f"kill -TERM {PID_CLIENTE}", comando)
            self.assertNotIn(f"kill -KILL {PID_CLIENTE}", comando)
        # The in-container bridge PID was, via `docker exec ... kill`.
        self.assertNotIn(PID_INTERNO_PUENTE, fake.alive_contenedor)
        dentro = [c for _, c in fake.calls if c.startswith(f"docker exec {CONTENEDOR} kill")]
        self.assertTrue(dentro)
        self.assertTrue(all(str(PID_INTERNO_PUENTE) in c for c in dentro))

    def test_two_bridges_same_container_only_matching_alias_dies(self):
        """ws-humanizar-shaped case: a single container hosts TWO aliases' bridges. Without
        the alias check, the unqualified path match in RE_PUENTE picks whichever bridge
        appears first in `ps` -- here that would be atlas, the WRONG one for a kratos repair."""
        ps_contenedor = "\n".join([
            "  1 /usr/bin/python3 /control/cauce-container-runtime.py run --alias kratos x",
            f"{PID_INTERNO_PUENTE_VECINO:4d} {CMD_PUENTE_VECINO}",
            f"{PID_INTERNO_PUENTE:4d} node /opt/cauce-v3-adapter/kratos/releases/rel1/packages/adapter-sdk/dist/"
            "bridge/hermes-stdin-bridge.py --alias kratos",
        ])
        fake = FakeSh({PID_CLIENTE: CMD_CLIENTE}, ps_contenedor=ps_contenedor)
        with mock.patch.object(MODULE, "sh", fake):
            ok, motivo = MODULE.matar_por_pid(
                "vps", PID_CLIENTE, CMD_CLIENTE, contenedor=CONTENEDOR, alias="kratos")
        self.assertTrue(ok, motivo)
        self.assertNotIn(PID_INTERNO_PUENTE, fake.alive_contenedor)
        self.assertIn(PID_INTERNO_PUENTE_VECINO, fake.alive_contenedor,
                     "the neighbor alias's bridge was killed instead of kratos's")
        dentro = [c for _, c in fake.calls if c.startswith(f"docker exec {CONTENEDOR} kill")]
        self.assertTrue(all(str(PID_INTERNO_PUENTE_VECINO) not in c for c in dentro))


if __name__ == "__main__":
    unittest.main()
