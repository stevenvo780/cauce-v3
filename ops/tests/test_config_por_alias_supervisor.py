#!/usr/bin/env python3
"""
La derivación de `CLAUDE_CONFIG_DIR` / `CODEX_HOME` por alias, dentro del supervisor.

El supervisor es bash y habla con docker, así que esta prueba no lo ejecuta entero: extrae las dos
funciones puras del fichero REAL (no una copia pegada acá, que se desincroniza sin que nadie se
entere) y las corre sueltas. El encendido de punta a punta —que el interruptor esté APAGADO por
defecto y que la variable llegue al `env -i` del adaptador— se prueba contra el docker de mentira
en `ops/tests/container-supervisor.test.mjs`.

POR QUÉ ESTAS DOS FUNCIONES EXISTEN
===================================

Hoy `kratos` y `atlas` comparten contenedor, usuario y HOME, y su `~/.codex/AGENTS.md` es el mismo
inodo. La ruta por alias es lo único que los separa, y la calculan DOS sitios: este supervisor
(que exporta la variable) y `ops/scripts/separar-config-alias.mjs` (que copia los ficheros). Si los
dos no dan exactamente lo mismo, la separación copia a un directorio y el alias lee de otro: el
alias arranca con la configuración de fábrica y no falla nada. Por eso la última prueba de este
fichero compara las dos implementaciones contra la misma entrada.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import unittest

RAIZ = pathlib.Path(__file__).resolve().parent.parent
SUPERVISOR = RAIZ / "scripts" / "container-adapter-supervisor.sh"
PLANIFICADOR = RAIZ / "scripts" / "separar-config-alias.mjs"

def _fuente_de(nombre: str) -> str:
    """La función tal como está HOY en el supervisor desplegable."""
    texto = SUPERVISOR.read_text(encoding="utf-8")
    inicio = texto.index(f"{nombre}() {{")
    fin = texto.index("\n}\n", inicio) + len("\n}\n")
    return texto[inicio:fin]


def _preludio() -> str:
    """
    Las dos guardas de las que depende la derivación, extraídas TAMBIÉN del fichero real.

    Pegar aquí una copia de `valid_alias` / `valid_absolute_path` haría que la prueba siguiera en
    verde el día que alguien las endureciera en el supervisor: estaría probando otro guion.
    """
    return "set -uo pipefail\n" + _fuente_de("valid_alias") + _fuente_de("valid_absolute_path")


def _correr(harness: str, home: str = "/home/dev", alias: str = "kratos") -> subprocess.CompletedProcess:
    guion = (
        _preludio()
        + _fuente_de("config_por_alias_variable")
        + _fuente_de("config_por_alias_directorio")
        + f'''
if variable=$(config_por_alias_variable {harness!r}) \\
   && directorio=$(config_por_alias_directorio {harness!r} {home!r} {alias!r}); then
  printf '%s=%s\\n' "$variable" "$directorio"
else
  printf 'RECHAZADO\\n'
  exit 3
fi
'''
    )
    return subprocess.run(
        ["bash", "-c", guion], capture_output=True, text=True,
        env={"PATH": "/usr/bin:/bin"}, check=False,
    )


class TestDerivacionPorAlias(unittest.TestCase):
    def test_codex_deriva_codex_home(self) -> None:
        resultado = _correr("codex")
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertEqual(resultado.stdout.strip(), "CODEX_HOME=/home/dev/.cauce/kratos/.codex")

    def test_claude_deriva_claude_config_dir(self) -> None:
        resultado = _correr("claude", alias="zeus")
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertEqual(resultado.stdout.strip(), "CLAUDE_CONFIG_DIR=/home/dev/.cauce/zeus/.claude")

    def test_kratos_y_atlas_derivan_directorios_DISTINTOS(self) -> None:
        """El trabajo entero es esto: mismo contenedor, mismo HOME, distinto directorio."""
        kratos = _correr("codex", alias="kratos").stdout.strip()
        atlas = _correr("codex", alias="atlas").stdout.strip()
        self.assertNotEqual(kratos, atlas)
        self.assertEqual(kratos, "CODEX_HOME=/home/dev/.cauce/kratos/.codex")
        self.assertEqual(atlas, "CODEX_HOME=/home/dev/.cauce/atlas/.codex")

    def test_el_home_del_contenedor_manda(self) -> None:
        """Los alias `claw*` viven en /home/claw: derivar sobre /home/dev les daría una ruta ajena."""
        resultado = _correr("claude", home="/home/claw", alias="hegel")
        self.assertEqual(resultado.stdout.strip(), "CLAUDE_CONFIG_DIR=/home/claw/.cauce/hegel/.claude")

    # ---------------- CONTROLES NEGATIVOS ----------------
    def test_control_negativo_un_arnes_sin_directorio_se_RECHAZA(self) -> None:
        """
        hermes sólo lee stdin y los openclaw no leen ~/.codex ni ~/.claude.

        Lo que no puede pasar es que devuelva cadena vacía con éxito: el supervisor exportaría
        `CODEX_HOME=` —una variable que existe y apunta a ninguna parte— y el arnés resolvería el
        directorio de fábrica sin un solo error. Tiene que FALLAR, no devolver vacío.
        """
        for harness in ("hermes", "openclaw", "opencode", "", "CODEX", "claude-code"):
            with self.subTest(harness=harness):
                resultado = _correr(harness)
                self.assertNotEqual(resultado.returncode, 0, f"{harness} no debería derivar nada")
                self.assertNotIn("=", resultado.stdout)

    def test_control_negativo_la_derivacion_no_lleva_barras_dobles_ni_travesia(self) -> None:
        salida = _correr("codex", home="/home/dev").stdout.strip()
        ruta = salida.split("=", 1)[1]
        self.assertNotIn("//", ruta)
        self.assertNotIn("/../", ruta)
        self.assertTrue(ruta.startswith("/home/dev/.cauce/"))


class TestLasDosImplementacionesCoinciden(unittest.TestCase):
    """
    El supervisor exporta la ruta y el planificador copia los ficheros a la ruta. Si divergen, la
    separación copia a un sitio y el alias lee de otro — y eso no produce ningún error: el alias
    arranca con la configuración de fábrica y parece que "se le olvidó" su identidad.
    """

    def test_el_supervisor_y_el_planificador_dan_la_MISMA_ruta(self) -> None:
        for harness, alias, home in (
            ("codex", "kratos", "/home/dev"),
            ("codex", "atlas", "/home/dev"),
            ("claude", "zeus", "/home/dev"),
            ("claude", "hegel", "/home/claw"),
        ):
            with self.subTest(alias=alias, harness=harness):
                del_shell = _correr(harness, home=home, alias=alias).stdout.strip().split("=", 1)
                planificado = subprocess.run(
                    ["node", str(PLANIFICADOR), "--alias", alias, "--home", home, "--arnes", harness],
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(planificado.returncode, 0, planificado.stderr)
                plan = json.loads(planificado.stdout)
                self.assertEqual(del_shell[1], plan["directorioDestino"])
                self.assertEqual(del_shell[0], plan["variable"])
                self.assertEqual({del_shell[0]: del_shell[1]}, plan["entorno"])


class TestLaPoliticaDeclarativaEsFailClosed(unittest.TestCase):

    def test_la_exportacion_esta_condicionada_al_interruptor(self) -> None:
        texto = SUPERVISOR.read_text(encoding="utf-8")
        self.assertIn("CONFIG_POR_ALIAS", texto)
        # La única línea que mete la variable en el entorno del adaptador tiene que estar dentro
        # del bloque del interruptor, no suelta.
        lineas = texto.splitlines()
        indices = [i for i, linea in enumerate(lineas) if "config_por_alias_directorio" in linea
                   and "environment+=" in linea]
        self.assertTrue(indices, "no se encontró la exportación de la variable por alias")
        for indice in indices:
            contexto = "\n".join(lineas[max(0, indice - 6):indice])
            self.assertIn("CONFIG[CONFIG_POR_ALIAS]", contexto,
                          "la exportación tiene que colgar del interruptor")

    def test_los_env_generados_exigen_seed_y_aislamiento_en_contenedores_multi_alias(self) -> None:
        inventario = json.loads((RAIZ / "container-aliases.json").read_text(encoding="utf-8"))["aliases"]
        cantidades: dict[str, int] = {}
        for entrada in inventario.values():
            cantidades[entrada["container"]] = cantidades.get(entrada["container"], 0) + 1
        for alias, entrada in inventario.items():
            ejemplo = RAIZ / "generated" / "container-systemd" / "configs" / f"{alias}.env.example"
            texto = ejemplo.read_text(encoding="utf-8")
            self.assertIn("CAUCE_SEMBRAR_PERFIL=1", texto, alias)
            multi = cantidades[entrada["container"]] > 1
            if multi and entrada["harness"] in {"claude", "codex"}:
                self.assertIn("CONFIG_POR_ALIAS=1", texto, alias)
            elif entrada["harness"] in {"claude", "codex"}:
                self.assertNotIn("CONFIG_POR_ALIAS=1", texto, alias)
            if multi and entrada["harness"] == "hermes":
                self.assertIn(
                    f"HERMES_HOME={entrada['home']}/.hermes/profiles/{alias}", texto, alias,
                )
            if entrada["harness"] == "openclaw":
                self.assertIn(f"OPENCLAW_WORKSPACE={entrada['workspace']}", texto, alias)


if __name__ == "__main__":
    unittest.main()
