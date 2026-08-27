#!/usr/bin/env python3
"""Pruebas de tolerancia a fallos transitorios en el reinicio de unidades de systemd del lanzador PTY.

Valida que la ausencia de artefactos de release resulte en códigos de salida transitorios (reintentables)
mientras que los errores de configuración permanezcan clasificados como no reintentables.
"""
from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER = AGENT_DIR / "cauce-pty-launcher.sh"
UNIT = AGENT_DIR / "systemd" / "cauce-v3-pty@.service"


def prevented_exit_codes() -> frozenset[int]:
    """Los codigos que la unit declara PERMANENTES, leidos del fichero real que se instala."""
    for line in UNIT.read_text(encoding="utf-8").splitlines():
        if line.startswith("RestartPreventExitStatus="):
            return frozenset(int(value) for value in line.split("=", 1)[1].split())
    raise AssertionError("la unit no declara RestartPreventExitStatus")


def run_launcher(directory: pathlib.Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Corre el lanzador REAL copiado a `directory`, con el entorno minimo que necesita."""
    return subprocess.run(
        [str(directory / "cauce-pty-launcher.sh"), *args],
        capture_output=True,
        text=True,
        # PATH real: docker/flock/timeout se comprueban ANTES que el artefacto, y si faltan el
        # lanzador sale por otra rama y la prueba mediria otra cosa.
        env={"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": str(directory)},
        check=False,
    )


class MissingShippedArtefactIsRetryable(unittest.TestCase):
    """Un fichero del release que no viajo NO puede dejar la unit muerta."""

    def setUp(self) -> None:
        self.prevented = prevented_exit_codes()
        # La prueba no vale nada si la unit dejo de declarar codigos permanentes.
        self.assertTrue(self.prevented, "la unit no previene ningun reinicio: la prueba seria vacua")

    def _launcher_alone(self, tmp: pathlib.Path) -> pathlib.Path:
        """El lanzador sin NINGUN artefacto al lado: el release llego a medias."""
        shutil.copy2(LAUNCHER, tmp / "cauce-pty-launcher.sh")
        return tmp

    def test_a_missing_agent_source_is_retryable(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            done = run_launcher(self._launcher_alone(pathlib.Path(raw)), "zeus")
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertNotIn(
            done.returncode,
            self.prevented,
            f"un artefacto ausente salio con {done.returncode}, que la unit trata como PERMANENTE: "
            f"las 15 unidades de PTY quedarian paradas hasta que un humano las rearme.\n{done.stderr}",
        )

    def test_control_negativo_una_config_invalida_si_es_permanente(self) -> None:
        """El control negativo: si TODO fuese transitorio esta prueba fallaria.

        Un alias que no es un alias viene del nombre de la unit (`%i`). Reintentar cada 5 s no lo
        va a arreglar nunca, asi que ese si tiene que ser permanente.
        """
        with tempfile.TemporaryDirectory() as raw:
            done = run_launcher(self._launcher_alone(pathlib.Path(raw)), "Alias-Invalido!")
        self.assertIn(
            done.returncode,
            self.prevented,
            f"un alias invalido salio con {done.returncode}, que la unit REINTENTA: "
            f"un error de configuracion se convertiria en un bucle caliente que tapa la causa.\n{done.stderr}",
        )


class EveryShippedArtefactPreflightIsTransient(unittest.TestCase):
    """Guardia estatica: la proxima comprobacion de artefacto no puede volver a poner la mina.

    La conductual de arriba solo cubre el artefacto que exista HOY. Esta lee el lanzador y exige
    que TODA comprobacion de la forma `[[ -f $X_SOURCE ... ]] || ...` termine en el helper
    transitorio. Es la que hubiera cazado el `READER_SOURCE` de la rama.
    """

    def test_source_preflights_use_the_transient_helper(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        preflights = re.findall(r"^\[\[ -f \$([A-Z_]*SOURCE).*?\]\] \|\| (\S+)", text, re.MULTILINE)
        self.assertTrue(preflights, "no se encontro ninguna comprobacion de artefacto: ¿cambio la forma?")
        for name, handler in preflights:
            self.assertEqual(
                handler,
                "die_transient",
                f"la comprobacion de {name} usa `{handler}`, que sale con un codigo permanente. "
                "Un artefacto que no viajo se arregla volviendo a desplegar, no rearmando 15 units.",
            )

    def test_control_negativo_el_helper_transitorio_no_usa_un_codigo_prevenido(self) -> None:
        """Que el helper exista no basta: tiene que salir con un codigo que la unit REINTENTE."""
        text = LAUNCHER.read_text(encoding="utf-8")
        match = re.search(r"die_transient\(\) \{.*?exit (\d+)", text, re.DOTALL)
        self.assertIsNotNone(match, "no existe el helper die_transient")
        assert match is not None
        code = int(match.group(1))
        self.assertNotIn(
            code,
            prevented_exit_codes(),
            f"die_transient sale con {code}, que la unit trata como permanente: el helper no sirve de nada",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
