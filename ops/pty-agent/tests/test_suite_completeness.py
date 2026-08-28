#!/usr/bin/env python3
"""La suite tiene que CARGAR todos sus ficheros, y eso se cuenta, no se supone.

`python3 -m unittest discover` desde `ops/pty-agent/` respondia «Ran 0 tests» y salia 0: un verde
perfecto con 74 pruebas al lado sin ejecutarse jamas. El sintoma de esa clase de fallo es
justamente que no hay sintoma — nadie ve un rojo, ve un OK.

Por eso la guardia no mira si el descubrimiento "funciona": compara el conjunto de modulos que la
corrida CARGO contra los ficheros `test_*.py` que hay en el disco. Si alguno no se carga —por un
paquete sin `__init__.py`, por un ImportError silencioso o por un patron que no lo cubre— esta
prueba nombra el fichero que falta.
"""
from __future__ import annotations

import pathlib
import unittest

TESTS_DIR = pathlib.Path(__file__).resolve().parent


def _loaded_module_names(suite: unittest.TestSuite, seen: set[str]) -> set[str]:
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            _loaded_module_names(item, seen)
        else:
            seen.add(type(item).__module__.rsplit(".", 1)[-1])
    return seen


class SuiteLoadsEveryFile(unittest.TestCase):
    def test_discovery_loads_every_test_file_on_disk(self) -> None:
        on_disk = {path.stem for path in TESTS_DIR.glob("test_*.py")}
        self.assertIn("test_suite_completeness", on_disk, "la prueba no se encuentra a si misma")

        discovered = _loaded_module_names(
            unittest.TestLoader().discover(str(TESTS_DIR), top_level_dir=str(TESTS_DIR.parent)),
            set(),
        )
        missing = on_disk - discovered
        self.assertFalse(
            missing,
            f"el descubrimiento no cargo estos ficheros de prueba: {sorted(missing)}. "
            "Estan escritos y no se ejecutan, asi que su verde no significa nada.",
        )

    def test_control_negativo_un_fichero_inexistente_no_aparece_cargado(self) -> None:
        """Control negativo: si `discovered` viniera lleno de cualquier cosa, esto lo delata."""
        discovered = _loaded_module_names(
            unittest.TestLoader().discover(str(TESTS_DIR), top_level_dir=str(TESTS_DIR.parent)),
            set(),
        )
        self.assertNotIn("test_fichero_que_no_existe", discovered)
        # And it MUST have loaded something: an empty set would satisfy the test above
        # only if the disk were also empty, but it is not.
        self.assertGreater(len(discovered), 1, "el descubrimiento no cargo practicamente nada")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
