#!/usr/bin/env python3
"""
Censo de configuración por alias: agrupar por INODO, nunca por ruta.

POR QUÉ ESTA PRUEBA EXISTE, y por qué en `unittest.TestCase` y no en funciones sueltas:

  * El motivo del censo está medido: `kratos` y `atlas` comparten el contenedor `ws-humanizar`,
    el usuario `dev` y el HOME `/home/dev`. Su `~/.codex/AGENTS.md` no es "un fichero parecido":
    es EL MISMO INODO (12.942 bytes en los dos). `zeus` y `argos` comparten `CLAUDE.md` igual.
    Comparar por ruta no detecta nada de eso — las rutas también son iguales, y lo serían igual
    si fueran dos ficheros distintos. Lo que decide es el inodo.
  * En `ops/tests/` hay cuatro ficheros `test_*.py` escritos con funciones sueltas al estilo
    pytest. `python3 -m unittest discover` los CARGA y ejecuta 0 pruebas de ellos, en silencio y
    con OK final. Medido hoy: la corrida dice "Ran 57 tests ... OK" y esos 57 salen de sólo 2 de
    los 6 ficheros. Esta prueba usa `unittest.TestCase` para que la corrida oficial la CUENTE.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import unittest

RAIZ = pathlib.Path(__file__).resolve().parent.parent
GUION = RAIZ / "scripts" / "censo-config-por-alias.py"

sys.path.insert(0, str(RAIZ / "scripts"))

import importlib

censo = importlib.import_module("censo-config-por-alias")


def medicion(alias: str, ruta: str, inodo: int, dispositivo: int = 64) -> dict:
    return {"alias": alias, "ruta": ruta, "inodo": inodo, "dispositivo": dispositivo}


class TestAgrupacionPorInodo(unittest.TestCase):
    def test_dos_alias_con_el_mismo_inodo_forman_un_grupo(self) -> None:
        """El caso medido en producción: kratos y atlas, mismo AGENTS.md, mismo inodo."""
        grupos = censo.agrupar_por_inodo([
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 4242),
            medicion("atlas", "/home/dev/.codex/AGENTS.md", 4242),
        ])
        self.assertEqual(len(grupos), 1)
        self.assertEqual(grupos[0]["alias"], ["atlas", "kratos"])
        self.assertEqual(grupos[0]["inodo"], 4242)
        self.assertEqual(grupos[0]["dispositivo"], 64)

    def test_alias_con_inodos_distintos_no_forman_grupo(self) -> None:
        """Misma RUTA, inodos distintos: son ficheros distintos y no hay nada que separar."""
        grupos = censo.agrupar_por_inodo([
            medicion("zeus", "/home/dev/.claude/CLAUDE.md", 11),
            medicion("socrates", "/home/dev/.claude/CLAUDE.md", 12),
        ])
        self.assertEqual(grupos, [])

    # ---------------- CONTROL NEGATIVO OBLIGATORIO ----------------
    def test_control_negativo_medir_dos_veces_al_mismo_alias_no_inventa_colision(self) -> None:
        """
        Medir DOS VECES al mismo alias no puede fabricar un grupo.

        Es el falso positivo que este censo tiene que ser incapaz de producir: si el censo se
        alimenta de una recolección que pasa dos veces por el mismo alias (dos rutas que son el
        mismo fichero, o sencillamente una lista con duplicados), agrupar por inodo "encuentra"
        dos filas con la misma clave. Si el criterio fuera "dos filas = colisión", el censo diría
        que kratos comparte fichero consigo mismo y mandaría a separar algo que ya está separado.
        Un grupo exige DOS ALIAS DISTINTOS, no dos filas.
        """
        grupos = censo.agrupar_por_inodo([
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 4242),
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 4242),
            medicion("kratos", "/home/dev/.cauce/kratos/.codex/AGENTS.md", 4242),
        ])
        self.assertEqual(grupos, [], "medir dos veces al mismo alias no es una colisión")

    def test_control_negativo_mismo_inodo_en_dispositivos_distintos_no_es_colision(self) -> None:
        """
        El número de inodo sólo es único DENTRO de un sistema de ficheros.

        Dos alias en contenedores distintos (overlay propio cada uno) pueden traer el mismo
        número de inodo sin compartir absolutamente nada. Agrupar por inodo a secas los juntaría
        y el plan de separación tocaría a un alias que no tenía ningún problema.
        """
        grupos = censo.agrupar_por_inodo([
            medicion("hegel", "/home/claw/.claude/CLAUDE.md", 777, dispositivo=64),
            medicion("midas", "/home/claw/.claude/CLAUDE.md", 777, dispositivo=65),
        ])
        self.assertEqual(grupos, [])

    def test_tres_alias_en_el_mismo_fichero_salen_en_un_solo_grupo(self) -> None:
        grupos = censo.agrupar_por_inodo([
            medicion("kant", "/home/dev/.codex/AGENTS.md", 9),
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 9),
            medicion("atlas", "/home/dev/.codex/AGENTS.md", 9),
        ])
        self.assertEqual(len(grupos), 1)
        self.assertEqual(grupos[0]["alias"], ["atlas", "kant", "kratos"])

    def test_grupos_independientes_se_reportan_por_separado(self) -> None:
        grupos = censo.agrupar_por_inodo([
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 1),
            medicion("atlas", "/home/dev/.codex/AGENTS.md", 1),
            medicion("zeus", "/home/dev/.claude/CLAUDE.md", 2),
            medicion("argos", "/home/dev/.claude/CLAUDE.md", 2),
            medicion("salva", "/home/dev/.codex/AGENTS.md", 3),
        ])
        self.assertEqual([g["alias"] for g in grupos], [["argos", "zeus"], ["atlas", "kratos"]])

    def test_el_grupo_conserva_la_ruta_medida_de_cada_alias(self) -> None:
        grupos = censo.agrupar_por_inodo([
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 5),
            medicion("atlas", "/home/dev/.codex/AGENTS.md", 5),
        ])
        self.assertEqual(grupos[0]["rutas"], {
            "atlas": ["/home/dev/.codex/AGENTS.md"],
            "kratos": ["/home/dev/.codex/AGENTS.md"],
        })


class TestValidacionDeMediciones(unittest.TestCase):
    """Falla cerrado: una medición que no se entiende no se agrupa a ojo."""

    def test_mezclar_mediciones_con_y_sin_dispositivo_es_error(self) -> None:
        """
        Media medición es peor que ninguna: si unas filas traen dispositivo y otras no, las que
        no lo traen se comparan por un criterio MÁS DÉBIL en la misma corrida, y la respuesta
        depende de cuál llegó primero.
        """
        with self.assertRaises(censo.CensoError):
            censo.agrupar_por_inodo([
                {"alias": "kratos", "ruta": "/home/dev/.codex/AGENTS.md", "inodo": 1, "dispositivo": 64},
                {"alias": "atlas", "ruta": "/home/dev/.codex/AGENTS.md", "inodo": 1},
            ])

    def test_sin_dispositivo_en_ninguna_fila_se_acepta_y_agrupa(self) -> None:
        """Una recolección vieja sin dispositivo sigue sirviendo, siempre que sea homogénea."""
        grupos = censo.agrupar_por_inodo([
            {"alias": "kratos", "ruta": "/home/dev/.codex/AGENTS.md", "inodo": 1},
            {"alias": "atlas", "ruta": "/home/dev/.codex/AGENTS.md", "inodo": 1},
        ])
        self.assertEqual(grupos[0]["alias"], ["atlas", "kratos"])
        self.assertIsNone(grupos[0]["dispositivo"])

    def test_inodo_booleano_se_rechaza(self) -> None:
        """En Python `isinstance(True, int)` es True: sin este rechazo, True valdría de inodo 1."""
        with self.assertRaises(censo.CensoError):
            censo.agrupar_por_inodo([medicion("kratos", "/home/dev/.codex/AGENTS.md", True)])  # type: ignore[arg-type]

    def test_inodo_no_entero_se_rechaza(self) -> None:
        with self.assertRaises(censo.CensoError):
            censo.agrupar_por_inodo([medicion("kratos", "/home/dev/.codex/AGENTS.md", "4242")])  # type: ignore[arg-type]

    def test_inodo_cero_o_negativo_se_rechaza(self) -> None:
        for malo in (0, -1):
            with self.assertRaises(censo.CensoError):
                censo.agrupar_por_inodo([medicion("kratos", "/home/dev/.codex/AGENTS.md", malo)])

    def test_ruta_relativa_se_rechaza(self) -> None:
        with self.assertRaises(censo.CensoError):
            censo.agrupar_por_inodo([medicion("kratos", ".codex/AGENTS.md", 1)])

    def test_alias_vacio_se_rechaza(self) -> None:
        with self.assertRaises(censo.CensoError):
            censo.agrupar_por_inodo([medicion("", "/home/dev/.codex/AGENTS.md", 1)])

    def test_campo_desconocido_se_rechaza(self) -> None:
        with self.assertRaises(censo.CensoError):
            censo.agrupar_por_inodo([
                {"alias": "kratos", "ruta": "/x/y", "inodo": 1, "dispositivo": 1, "tamano": 12942},
            ])

    def test_lista_vacia_da_cero_grupos(self) -> None:
        self.assertEqual(censo.agrupar_por_inodo([]), [])


class TestInterfazDeLinea(unittest.TestCase):
    """El guion tiene que ser usable desde el shell del ejecutor, con salida JSON estable."""

    def _correr(self, entrada: object) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(GUION)],
            input=json.dumps(entrada), capture_output=True, text=True, check=False,
        )

    def test_stdin_json_devuelve_grupos_y_codigo_1_cuando_hay_colision(self) -> None:
        """
        Código de salida 1 con colisiones: es lo que permite encadenarlo en una comprobación.
        0 significa "no queda ningún fichero compartido", que es el estado final buscado.
        """
        resultado = self._correr([
            medicion("kratos", "/home/dev/.codex/AGENTS.md", 4242),
            medicion("atlas", "/home/dev/.codex/AGENTS.md", 4242),
        ])
        self.assertEqual(resultado.returncode, 1, resultado.stderr)
        documento = json.loads(resultado.stdout)
        self.assertEqual(documento["compartidos"], 1)
        self.assertEqual(documento["grupos"][0]["alias"], ["atlas", "kratos"])

    def test_sin_colisiones_sale_con_codigo_0(self) -> None:
        resultado = self._correr([
            medicion("kratos", "/home/dev/.cauce/kratos/.codex/AGENTS.md", 1),
            medicion("atlas", "/home/dev/.cauce/atlas/.codex/AGENTS.md", 2),
        ])
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        documento = json.loads(resultado.stdout)
        self.assertEqual(documento["compartidos"], 0)
        self.assertEqual(documento["grupos"], [])

    def test_entrada_invalida_sale_con_codigo_2_y_no_imprime_grupos(self) -> None:
        """Un error de entrada NO se puede confundir con 'no hay colisiones'."""
        resultado = self._correr([{"alias": "kratos", "ruta": "/home/dev/.codex/AGENTS.md"}])
        self.assertEqual(resultado.returncode, 2)
        self.assertEqual(resultado.stdout.strip(), "")
        # El error tiene que NOMBRAR el campo que falta; "entrada inválida" a secas obliga a
        # adivinar cuál de las cuatro claves está mal en una lista de 15 alias.
        self.assertIn("inodo", resultado.stderr)

    def test_json_ilegible_sale_con_codigo_2(self) -> None:
        resultado = subprocess.run(
            [sys.executable, str(GUION)], input="{no es json", capture_output=True, text=True, check=False,
        )
        self.assertEqual(resultado.returncode, 2)
        self.assertEqual(resultado.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
