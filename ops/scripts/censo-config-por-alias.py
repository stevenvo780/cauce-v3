#!/usr/bin/env python3
"""
Censo de configuración por alias: qué alias comparten FÍSICAMENTE un fichero de configuración.

CRITERIO DE INODO
=================

La identificación de ficheros compartidos se realiza mediante (dispositivo, inodo)
en lugar de por ruta para determinar si múltiples alias apuntan a los mismos datos
en disco.

LO QUE ESTE GUION NO HACE
=========================

No mide. Recibe mediciones ya tomadas (`stat -c '%d %i'` o equivalente) y las agrupa. Separar la
medición del criterio es deliberado: la medición hay que tomarla dentro de cada contenedor, y este
guion tiene que poder probarse sin contenedor ninguno.

ENTRADA
=======

JSON por stdin (o `--entrada fichero`): una lista de mediciones

    [{"alias": "kratos", "ruta": "/home/dev/.codex/AGENTS.md", "inodo": 4242, "dispositivo": 64}]

`dispositivo` es opcional pero TODO O NADA (ver `_clave_de_identidad`).

SALIDA
======

JSON por stdout. Código de salida: 0 = ningún fichero compartido, 1 = hay grupos compartidos,
2 = la entrada no se entiende. El 2 existe para que un error de entrada NUNCA se lea como "no hay
colisiones".
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any, Iterable

CAMPOS_OBLIGATORIOS = ("alias", "ruta", "inodo")
CAMPOS_ADMITIDOS = frozenset(CAMPOS_OBLIGATORIOS) | {"dispositivo"}


class CensoError(ValueError):
    """La entrada no se entiende. Nunca se agrupa a ojo: se falla cerrado."""


def _entero_positivo(valor: Any, etiqueta: str) -> int:
    # `isinstance(True, int)` es True en Python. Sin este rechazo explícito, un `true` en el JSON
    # entraría como inodo 1 y agruparía a cualquiera que de verdad tenga el inodo 1.
    if isinstance(valor, bool) or not isinstance(valor, int):
        raise CensoError(f"{etiqueta} tiene que ser un entero, no {type(valor).__name__}")
    if valor <= 0:
        raise CensoError(f"{etiqueta} tiene que ser un entero positivo, llegó {valor}")
    return valor


def _ruta_absoluta(valor: Any, etiqueta: str) -> str:
    if not isinstance(valor, str) or not valor.startswith("/") or "//" in valor:
        raise CensoError(f"{etiqueta} tiene que ser una ruta absoluta canónica")
    camino = pathlib.PurePosixPath(valor)
    if str(camino) != valor or ".." in camino.parts or "." in camino.parts:
        raise CensoError(f"{etiqueta} tiene que ser una ruta absoluta canónica")
    return valor


def _validar(medicion: Any, indice: int) -> dict[str, Any]:
    if not isinstance(medicion, dict):
        raise CensoError(f"la medición {indice} tiene que ser un objeto")
    sobrantes = set(medicion) - CAMPOS_ADMITIDOS
    if sobrantes:
        raise CensoError(f"la medición {indice} trae campos desconocidos: {sorted(sobrantes)}")
    for campo in CAMPOS_OBLIGATORIOS:
        if campo not in medicion:
            raise CensoError(f"la medición {indice} no trae el campo {campo}")
    alias = medicion["alias"]
    if not isinstance(alias, str) or not alias.strip():
        raise CensoError(f"la medición {indice} tiene un alias vacío o no textual")
    validada: dict[str, Any] = {
        "alias": alias,
        "ruta": _ruta_absoluta(medicion["ruta"], f"la medición {indice}: ruta"),
        "inodo": _entero_positivo(medicion["inodo"], f"la medición {indice}: inodo"),
    }
    if "dispositivo" in medicion:
        validada["dispositivo"] = _entero_positivo(
            medicion["dispositivo"], f"la medición {indice}: dispositivo"
        )
    return validada


def _clave_de_identidad(mediciones: list[dict[str, Any]]) -> bool:
    """
    ¿Se compara por (dispositivo, inodo) o sólo por inodo? Y exige que sea homogéneo.

    El número de inodo sólo es único DENTRO de un sistema de ficheros. Dos alias en contenedores
    distintos —cada uno con su propio overlay— pueden traer el mismo número sin compartir nada.
    Agrupar por inodo a secas los declararía compartidos y mandaría a separar a un alias sano.

    Mezclar filas con y sin dispositivo es peor que no tenerlo: en la MISMA corrida unas se
    comparan por un criterio fuerte y otras por uno débil, y qué sale depende de cuál llegó
    primero. Se rechaza.
    """
    con = sum(1 for m in mediciones if "dispositivo" in m)
    if con and con != len(mediciones):
        raise CensoError(
            "las mediciones mezclan filas con y sin 'dispositivo': el inodo sólo es único dentro "
            "de un sistema de ficheros, así que o lo traen todas o no lo trae ninguna"
        )
    return con == len(mediciones) and con > 0


def agrupar_por_inodo(mediciones: Iterable[Any]) -> list[dict[str, Any]]:
    """
    Devuelve los grupos de alias que comparten físicamente un fichero.

    Un grupo exige DOS ALIAS DISTINTOS. Dos filas con la misma clave y el mismo alias NO son una
    colisión: son el mismo alias medido dos veces (dos rutas que resuelven al mismo fichero, o una
    lista con duplicados). Contar filas en vez de alias distintos haría que el censo declarara que
    `kratos` comparte fichero consigo mismo.
    """
    validadas = [_validar(m, i) for i, m in enumerate(mediciones)]
    usa_dispositivo = _clave_de_identidad(validadas)

    cubos: dict[tuple[int | None, int], dict[str, list[str]]] = {}
    for m in validadas:
        clave = (m["dispositivo"] if usa_dispositivo else None, m["inodo"])
        rutas = cubos.setdefault(clave, {})
        destino = rutas.setdefault(m["alias"], [])
        if m["ruta"] not in destino:
            destino.append(m["ruta"])

    grupos: list[dict[str, Any]] = []
    for (dispositivo, inodo), rutas in cubos.items():
        if len(rutas) < 2:
            continue
        grupos.append({
            "dispositivo": dispositivo,
            "inodo": inodo,
            "alias": sorted(rutas),
            "rutas": {alias: sorted(rutas[alias]) for alias in sorted(rutas)},
        })
    grupos.sort(key=lambda g: (g["alias"][0], g["inodo"]))
    return grupos


def _leer(origen: str | None) -> Any:
    texto = pathlib.Path(origen).read_text(encoding="utf-8") if origen else sys.stdin.read()
    try:
        return json.loads(texto)
    except json.JSONDecodeError as error:
        raise CensoError(f"la entrada no es JSON válido: {error}") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Agrupa alias que comparten fichero por inodo")
    parser.add_argument("--entrada", help="fichero JSON con las mediciones (por defecto: stdin)")
    argumentos = parser.parse_args(argv)
    try:
        documento = _leer(argumentos.entrada)
        if not isinstance(documento, list):
            raise CensoError("la entrada tiene que ser una lista de mediciones")
        grupos = agrupar_por_inodo(documento)
    except CensoError as error:
        # Nada por stdout: un error de entrada no puede leerse nunca como "no hay colisiones".
        print(f"censo: {error}", file=sys.stderr)
        return 2
    json.dump({"compartidos": len(grupos), "grupos": grupos}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 1 if grupos else 0


if __name__ == "__main__":
    sys.exit(main())
