#!/usr/bin/env python3
"""La auditoría de blobs informa lo caducado sin borrar archivos ni filas."""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

import purgar_blobs  # noqa: E402

AHORA = dt.datetime(2026, 9, 5, 12, 0, tzinfo=dt.timezone.utc)
VIVO = "a" * 64
CADUCADO = "b" * 64
HUERFANO = "c" * 64
RECIENTE_SIN_FILA = "d" * 64
SIN_FICHERO = "e" * 64


def _tocar(directorio: pathlib.Path, nombre: str, hace_dias: int) -> None:
    ruta = directorio / nombre
    ruta.write_bytes(b"x")
    momento = (AHORA - dt.timedelta(days=hace_dias)).timestamp()
    os.utime(ruta, (momento, momento))


class PurgaDeBlobs(unittest.TestCase):
    def test_analiza_filas_de_psql_y_descarta_lo_malformado(self) -> None:
        filas = purgar_blobs.analizar_filas(
            f"{VIVO}\t2026-09-05 11:00:00+00\n{CADUCADO}\t2026-07-01T00:00:00+00:00\nbasura\t2026-01-01\n{HUERFANO}\tno-es-fecha\n"
        )
        self.assertEqual(set(filas), {VIVO, CADUCADO})
        self.assertEqual(filas[CADUCADO].year, 2026)

    def test_planifica_sin_tocar_nada(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directorio = pathlib.Path(raw)
            for nombre, dias in ((VIVO, 1), (CADUCADO, 45), (HUERFANO, 60), (RECIENTE_SIN_FILA, 2)):
                _tocar(directorio, nombre, dias)
            filas = {
                VIVO: AHORA - dt.timedelta(days=1),
                CADUCADO: AHORA - dt.timedelta(days=45),
                SIN_FICHERO: AHORA - dt.timedelta(days=3),
            }
            plan = purgar_blobs.planificar(filas, purgar_blobs.ficheros_en_disco(directorio), AHORA, 30)
            self.assertEqual(plan, {"caducados": [CADUCADO], "huerfanos": [HUERFANO], "sin_fichero": [SIN_FICHERO]})
            self.assertTrue((directorio / CADUCADO).exists())

    def test_la_cli_informa_y_rechaza_aplicar_sin_borrar(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directorio = pathlib.Path(raw)
            _tocar(directorio, CADUCADO, 45)
            entrada = f"{CADUCADO}\t{(AHORA - dt.timedelta(days=45)).isoformat()}\n"
            import contextlib
            import io

            sys.stdin = io.StringIO(entrada)
            salida = io.StringIO()
            with contextlib.redirect_stdout(salida):
                self.assertEqual(purgar_blobs.main(["--dir", str(directorio), "--desde-stdin"]), 0)
            self.assertIn("caducados: 1", salida.getvalue())
            self.assertTrue((directorio / CADUCADO).exists())
            sys.stdin = io.StringIO(entrada)
            error = io.StringIO()
            with contextlib.redirect_stderr(error):
                self.assertEqual(purgar_blobs.main(["--dir", str(directorio), "--desde-stdin", "--aplicar"]), 2)
            self.assertIn("purga deshabilitada", error.getvalue())
            self.assertTrue((directorio / CADUCADO).exists())


if __name__ == "__main__":
    unittest.main()
