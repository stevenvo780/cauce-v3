#!/usr/bin/env python3
"""Auditoría del almacén de blobs del gateway (migración 042, PUT/GET /v3/blobs).

Un blob que nadie leyó en N días se informa como candidato. Un fichero sin fila se informa como
huérfano y una fila sin fichero también se informa. No se borra mientras GET y PUT puedan competir.
Las filas llegan por `psql` (--psql) o por stdin (--desde-stdin) como `sha256<TAB>last_used_at`.
"""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import re
import shlex
import subprocess
import sys

HEX_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def analizar_filas(texto: str) -> dict[str, dt.datetime]:
    filas: dict[str, dt.datetime] = {}
    for linea in texto.splitlines():
        partes = linea.strip().split("\t")
        if len(partes) != 2 or not HEX_SHA256.match(partes[0]):
            continue
        marca = partes[1].strip().replace(" ", "T")
        try:
            momento = dt.datetime.fromisoformat(marca)
        except ValueError:
            continue
        if momento.tzinfo is None:
            momento = momento.replace(tzinfo=dt.timezone.utc)
        anterior = filas.get(partes[0])
        if anterior is None or momento > anterior:
            filas[partes[0]] = momento
    return filas


def ficheros_en_disco(directorio: pathlib.Path) -> dict[str, dt.datetime]:
    encontrados: dict[str, dt.datetime] = {}
    for entrada in directorio.iterdir():
        if not entrada.is_file() or not HEX_SHA256.match(entrada.name):
            continue
        encontrados[entrada.name] = dt.datetime.fromtimestamp(entrada.stat().st_mtime, tz=dt.timezone.utc)
    return encontrados


def planificar(
    filas: dict[str, dt.datetime],
    disco: dict[str, dt.datetime],
    ahora: dt.datetime,
    dias: int,
) -> dict[str, list[str]]:
    """Devuelve qué borrar y qué informar; no toca nada."""
    corte = ahora - dt.timedelta(days=dias)
    caducados = sorted(sha for sha, usado in filas.items() if usado < corte)
    huerfanos = sorted(sha for sha, mtime in disco.items() if sha not in filas and mtime < corte)
    sin_fichero = sorted(sha for sha in filas if sha not in disco)
    return {"caducados": caducados, "huerfanos": huerfanos, "sin_fichero": sin_fichero}


def sql_filas(psql: str) -> str:
    consulta = "SELECT sha256, MAX(last_used_at) FROM blobs GROUP BY sha256"
    return subprocess.run(
        [*shlex.split(psql), "-c", consulta], check=True, capture_output=True, text=True
    ).stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True, type=pathlib.Path)
    parser.add_argument("--dias", type=int, default=30)
    parser.add_argument("--psql", help="orden psql en modo -tA; p. ej. 'docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -tA'")
    parser.add_argument("--desde-stdin", action="store_true", help="leer sha256<TAB>last_used_at de stdin en vez de psql")
    parser.add_argument("--aplicar", action="store_true", help="reservado hasta coordinar la purga con GET y PUT")
    args = parser.parse_args(argv)
    if args.aplicar:
        print("purga deshabilitada: falta coordinación segura con GET y PUT", file=sys.stderr)
        return 2
    if not args.dir.is_dir():
        print(f"no existe el directorio {args.dir}", file=sys.stderr)
        return 2
    if args.desde_stdin:
        filas = analizar_filas(sys.stdin.read())
    elif args.psql:
        filas = analizar_filas(sql_filas(args.psql))
    else:
        print("hace falta --psql o --desde-stdin", file=sys.stderr)
        return 2
    ahora = dt.datetime.now(tz=dt.timezone.utc)
    plan = planificar(filas, ficheros_en_disco(args.dir), ahora, args.dias)
    for clave in ("caducados", "huerfanos", "sin_fichero"):
        print(f"{clave}: {len(plan[clave])}")
    print("auditoría solamente: nada borrado")
    return 0


if __name__ == "__main__":
    sys.exit(main())
