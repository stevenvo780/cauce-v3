#!/usr/bin/env python3
"""El helper de runtime corre DENTRO del contenedor desde la copia que hace el supervisor.

Tras partirlo en módulos hermanos, el supervisor copiaba sólo el fichero de entrada y todo
arranque de alias moría con ModuleNotFoundError; fake-docker convierte `docker cp` en no-op, así
que la suite del supervisor no podía verlo. Esta prueba copia a un directorio vacío exactamente
lo que el supervisor declara copiar y ejecuta el helper desde allí.

Run: python3 ops/tests/test_container_runtime_copy.py
"""
from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
SUPERVISOR = OPS / "scripts/container-adapter-supervisor.sh"
RUNTIME_DIR = OPS / "container-runtime"
ENTRY = "cauce-container-runtime.py"


def declared_modules() -> list[str]:
    match = re.search(r"^RUNTIME_HELPER_MODULES=\(([^)]*)\)", SUPERVISOR.read_text(encoding="utf-8"), re.M)
    if match is None:
        raise AssertionError("the supervisor does not declare RUNTIME_HELPER_MODULES")
    return match.group(1).split()


def run_from_copy(files: list[str]) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as control, tempfile.TemporaryDirectory() as bundle:
        for name in files:
            shutil.copy2(RUNTIME_DIR / name, pathlib.Path(control) / name)
        (pathlib.Path(bundle) / "a.txt").write_text("x", encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-B", str(pathlib.Path(control) / ENTRY), "bundle-digest", bundle],
            capture_output=True, text=True, check=False, timeout=60,
        )


class RuntimeHelperCopy(unittest.TestCase):
    def test_the_declared_copy_set_runs_on_its_own(self) -> None:
        result = run_from_copy([ENTRY, *declared_modules()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^sha256:[0-9a-f]{64}$")

    def test_every_sibling_module_is_declared(self) -> None:
        siblings = sorted(path.name for path in RUNTIME_DIR.glob("cauce_container_*.py"))
        self.assertEqual(sorted(declared_modules()), siblings)

    def test_control_negative_the_entry_alone_does_not_run(self) -> None:
        result = run_from_copy([ENTRY])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ModuleNotFoundError", result.stderr)


if __name__ == "__main__":
    unittest.main()
