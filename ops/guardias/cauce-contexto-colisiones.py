#!/usr/bin/env python3
"""Guard over the governance paths of the fleet: which aliases share the files that govern them.

Two aliases whose governance documents resolve to the SAME inode do not have two contexts, they
have one: writing "the CLAUDE.md of an alias" rewrites the other one's, and nothing in the console
can see it, because from a single container everything looks correct. Two aliases sharing a HOME
with different harnesses are the same accident one rename away: today they do not collide only
because their harness tables name different files.

The fleet comes from the inventory (`ops/flota.json`) and the per-harness roots and document names
from the generated contract (`ops/schemas/contexto-de-gobierno.json`), never from a table typed
here: a hand table drifts away from what the console projects and the guard then blesses a layout
nobody serves.

It reads no content. Only paths, device, inode and alias leave this process, so a governance file
holding a secret cannot leak through the report.

Where it measures: `host:` aliases on the host it runs on (kratos), containers of the kratos daemon
by `docker exec`, and the rest by `ssh` to the VPS daemon, the same two managers the rest of the
fleet tooling admits. `--raiz` replaces the whole probe with a local tree and is what the tests use.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import shlex
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

GUARDIA = "cauce-contexto-colisiones"
HOME = os.path.expanduser("~")
OPS_ROOT_ENV = "CAUCE_OPS_ROOT"
OPS_ROOT_CANDIDATES = (
    os.environ.get(OPS_ROOT_ENV),
    pathlib.Path(__file__).resolve().parents[1],
    f"{HOME}/.local/share/cauce-v3/ops",
)
INVENTARIO = "flota.json"
CONTRATO = pathlib.PurePath("schemas") / "contexto-de-gobierno.json"
LECTOR = pathlib.PurePath("scripts") / "fleet_derive.py"
AGORA = "root@100.64.0.6"
ESTADO_POR_DEFECTO = f"{HOME}/.local/state/cauce-v3/contexto-colisiones.json"
PROMETHEUS_POR_DEFECTO = f"{HOME}/.local/state/cauce-v3/contexto-colisiones.prom"
METRICA = "cauce_context_path_collisions"
ALERTA = "alerta"
AVISO = "aviso"

PROBE_SOURCE = r"""
import json
import os
import sys

medidas = {}
for path in sys.argv[1:]:
    try:
        real = os.path.realpath(path)
        info = os.stat(real)
        medidas[path] = {
            "estado": "ok", "canonica": real, "dev": info.st_dev, "ino": info.st_ino,
            "directorio": os.path.isdir(real),
        }
    except FileNotFoundError:
        medidas[path] = {"estado": "ausente"}
    except OSError as error:
        medidas[path] = {"estado": "ilegible", "detalle": type(error).__name__}
print(json.dumps(medidas))
"""


def find_ops_root(candidates: Iterable[Any]) -> pathlib.Path:
    """Return the first candidate carrying the inventory, its contract and its reader."""
    tried = []
    for candidate in candidates:
        if not candidate:
            continue
        root = pathlib.Path(candidate)
        tried.append(str(root))
        if (root / INVENTARIO).is_file() and (root / CONTRATO).is_file() and (root / LECTOR).is_file():
            return root
    raise SystemExit(
        f"{GUARDIA}: no encuentro el espejo de ops/ (flota.json, {CONTRATO} y {LECTOR}). "
        f"Probé: {', '.join(tried) or '(ningún candidato)'}. "
        f"Instalá el espejo en ~/.local/share/cauce-v3/ops o exportá {OPS_ROOT_ENV}=<ruta a ops/>."
    )


@dataclass(frozen=True)
class Contexto:
    """Where the governance of one alias lives, as the inventory and the contract declare it."""

    alias: str
    harness: str
    container: str
    docker_host: str
    hogar: str
    raiz: str
    documentos: tuple[str, ...]

    @property
    def rutas(self) -> tuple[str, ...]:
        return (self.hogar, self.raiz, *(f"{self.raiz}/{name}" for name in self.documentos))

    @property
    def nombres(self) -> frozenset[str]:
        return frozenset(self.documentos)


class InventarioInvalido(Exception):
    """The inventory or the contract cannot produce a governed path for one alias."""


def contexto_de_alias(alias: str, fila: Mapping[str, Any], placement: Mapping[str, Any],
                      contrato: Mapping[str, Any], reglas: Mapping[str, Any]) -> Contexto:
    """Project one inventory row into the paths its harness governs."""
    harness = fila.get("harness")
    arnes = (contrato.get("arneses") or {}).get(harness)
    if not isinstance(arnes, dict):
        raise InventarioInvalido(f"el arnés {harness!r} no está en el contrato de gobierno")
    hogar = fila.get("home")
    if not isinstance(hogar, str) or not hogar.startswith("/"):
        raise InventarioInvalido("la fila no declara un HOME absoluto")
    raiz_declarada = arnes.get("raiz") or {}
    bajo_home = raiz_declarada.get("por_defecto_bajo_home")
    hecho = raiz_declarada.get("hecho")
    if isinstance(bajo_home, str):
        raiz = f"{hogar}/{bajo_home}"
    elif hecho == "home":
        raiz = hogar
    else:
        plantilla = (reglas.get(harness) or {}).get("workspace")
        if not isinstance(plantilla, str):
            raise InventarioInvalido(f"el hecho {hecho!r} no tiene raíz derivable en el inventario")
        raiz = plantilla.format(alias=alias, home=hogar)
    documentos = arnes.get("documentos")
    if not isinstance(documentos, list) or not documentos:
        raise InventarioInvalido(f"el arnés {harness!r} no declara documentos de gobierno")
    contenedor = fila.get("container")
    if not isinstance(contenedor, str) or not contenedor:
        raise InventarioInvalido("la fila no declara contenedor")
    return Contexto(
        alias=alias, harness=harness, container=contenedor,
        docker_host=str((placement.get(alias) or {}).get("dockerHost", "local")),
        hogar=hogar, raiz=raiz, documentos=tuple(str(name) for name in documentos),
    )


def contextos_de_la_flota(inventario: Mapping[str, Any], contrato: Mapping[str, Any],
                          reglas: Mapping[str, Any]) -> tuple[list[Contexto], list[dict]]:
    """Derive one context per enabled alias; an alias that cannot be projected is an alert."""
    flota = inventario.get("fleet")
    if not isinstance(flota, dict) or not flota:
        raise SystemExit(f"{GUARDIA}: el inventario no declara flota")
    placement = inventario.get("placement") or {}
    contextos, hallazgos = [], []
    for alias in sorted(flota):
        fila = flota[alias]
        if not isinstance(fila, dict) or fila.get("enabled") is not True:
            continue
        try:
            contextos.append(contexto_de_alias(alias, fila, placement, contrato, reglas))
        except InventarioInvalido as error:
            hallazgos.append(hallazgo(ALERTA, "alias_no_proyectable", [alias], "-", str(error)))
    return contextos, hallazgos


def hallazgo(severidad: str, regla: str, aliases: Sequence[str], ruta: str, detalle: str,
             **extra: Any) -> dict:
    return {
        "severidad": severidad, "regla": regla, "alias": sorted(aliases), "ruta": ruta,
        "detalle": detalle, **extra,
    }


Grupo = tuple[str, int, int]


def _agrupar(medidas: Mapping[tuple[str, str], Mapping[str, Any]], clase: str,
             hosts: Mapping[str, str]) -> dict[Grupo, list[tuple[str, Mapping[str, Any]]]]:
    """Same (dev, ino) only means the same file inside one docker host: overlay devices are per kernel."""
    grupos: dict[Grupo, list[tuple[str, Mapping[str, Any]]]] = {}
    for (alias, _ruta), medida in sorted(medidas.items()):
        if medida.get("clase") != clase or medida.get("estado") != "ok":
            continue
        clave = (hosts.get(alias, "local"), medida["dev"], medida["ino"])
        grupos.setdefault(clave, []).append((alias, medida))
    return grupos


def evaluar(contextos: Sequence[Contexto],
            medidas: Mapping[tuple[str, str], Mapping[str, Any]]) -> list[dict]:
    """Judge the measured paths. Same inode is a collision; a shared HOME is the next one."""
    por_alias = {contexto.alias: contexto for contexto in contextos}
    hosts = {contexto.alias: contexto.docker_host for contexto in contextos}
    hallazgos: list[dict] = []

    ilegibles: dict[str, list[tuple[str, str]]] = {}
    for (alias, ruta), medida in sorted(medidas.items()):
        estado = medida.get("estado")
        if estado == "ilegible":
            ilegibles.setdefault(alias, []).append((ruta, str(medida.get("detalle", "sin detalle"))))
        elif estado == "ausente" and medida.get("clase") in ("hogar", "raiz"):
            hallazgos.append(hallazgo(
                ALERTA, f"{medida['clase']}_ausente", [alias], ruta,
                "el inventario declara esta ruta y en el contenedor no existe",
            ))

    for alias, rutas in sorted(ilegibles.items()):
        detalles = sorted({detalle for _, detalle in rutas})
        hallazgos.append(hallazgo(
            ALERTA, "ruta_ilegible", [alias], rutas[0][0],
            f"{len(rutas)} ruta(s) sin medir ({', '.join(detalles)}): la guardia no puede afirmar "
            "que este alias no comparte contexto",
            rutas=[ruta for ruta, _ in rutas],
        ))

    for (host, dev, ino), grupo in sorted(_agrupar(medidas, "documento", hosts).items()):
        aliases = sorted({alias for alias, _ in grupo})
        if len(aliases) < 2:
            continue
        hallazgos.append(hallazgo(
            ALERTA, "mismo_inodo", aliases, grupo[0][1]["canonica"],
            "estos alias no tienen dos contextos sino uno: escribir el de cualquiera reescribe el "
            "del otro",
            host=host, dev=dev, ino=ino, rutas=sorted({medida["declarada"] for _, medida in grupo}),
        ))

    for (host, dev, ino), grupo in sorted(_agrupar(medidas, "raiz", hosts).items()):
        aliases = sorted({alias for alias, _ in grupo})
        if len(aliases) < 2:
            continue
        nombres = [por_alias[alias].nombres for alias in aliases]
        comparten = any(a & b for i, a in enumerate(nombres) for b in nombres[i + 1:])
        hallazgos.append(hallazgo(
            ALERTA if comparten else AVISO, "misma_raiz", aliases, grupo[0][1]["canonica"],
            "una sola raíz de gobierno para varios alias: los nombres de sus documentos "
            + ("coinciden, así que ya escriben el mismo fichero" if comparten
               else "no coinciden hoy, y coincidirían con un cambio de arnés"),
            host=host, dev=dev, ino=ino,
        ))

    for (host, dev, ino), grupo in sorted(_agrupar(medidas, "hogar", hosts).items()):
        aliases = sorted({alias for alias, _ in grupo})
        arneses = sorted({por_alias[alias].harness for alias in aliases})
        if len(aliases) < 2 or len(arneses) < 2:
            continue
        hallazgos.append(hallazgo(
            AVISO, "mismo_hogar", aliases, grupo[0][1]["canonica"],
            f"un solo $HOME para varios alias: hoy no chocan sólo porque usan arneses distintos "
            f"({', '.join(arneses)})",
            host=host, dev=dev, ino=ino, arneses=arneses,
        ))
    return hallazgos


class SondaLocal:
    """Measures under a local tree, one subdirectory per container. No docker, no ssh."""

    def __init__(self, raiz: str) -> None:
        self.raiz = pathlib.Path(raiz).resolve()

    def medir(self, contexto: Contexto, rutas: Sequence[str]) -> dict[str, dict]:
        base = self.raiz / contexto.container
        medidas: dict[str, dict] = {}
        for ruta in rutas:
            destino = base / ruta.lstrip("/")
            try:
                real = pathlib.Path(os.path.realpath(destino))
                info = os.stat(real)
            except FileNotFoundError:
                medidas[ruta] = {"estado": "ausente"}
                continue
            except OSError as error:
                medidas[ruta] = {"estado": "ilegible", "detalle": type(error).__name__}
                continue
            try:
                canonica = "/" + str(real.relative_to(base))
            except ValueError:
                canonica = str(real)
            medidas[ruta] = {
                "estado": "ok", "canonica": canonica, "dev": info.st_dev, "ino": info.st_ino,
                "directorio": real.is_dir(),
            }
        return medidas


class SondaDeFlota:
    """Measures inside the namespace of each alias, through the two admitted docker managers."""

    def __init__(self, agora: str = AGORA, timeout: float = 30, docker: Sequence[str] = ("docker",)) -> None:
        self.agora = agora
        self.timeout = timeout
        self.docker = tuple(docker)

    def comando(self, contexto: Contexto, rutas: Sequence[str]) -> list[str]:
        interior = ["python3", "-c", PROBE_SOURCE, *rutas]
        if contexto.container.startswith("host:"):
            return interior
        remoto = [*self.docker, "exec", contexto.container, *interior]
        if contexto.docker_host == "kratos":
            return remoto
        return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", self.agora,
                " ".join(shlex.quote(part) for part in remoto)]

    def medir(self, contexto: Contexto, rutas: Sequence[str]) -> dict[str, dict]:
        try:
            hecho = subprocess.run(self.comando(contexto, rutas), capture_output=True, text=True,
                                   timeout=self.timeout, check=False)
            if hecho.returncode != 0:
                detalle = (hecho.stderr or "").strip().splitlines()[-1:] or [f"rc={hecho.returncode}"]
                raise OSError(detalle[0][:60])
            medidas = json.loads((hecho.stdout or "").strip().splitlines()[-1])
        except Exception as error:
            fallo = f"{type(error).__name__}: {str(error)[:50]}"
            return {ruta: {"estado": "ilegible", "detalle": fallo} for ruta in rutas}
        return {ruta: medidas.get(ruta, {"estado": "ilegible", "detalle": "sin medida"})
                for ruta in rutas}


def medir_flota(contextos: Sequence[Contexto], sonda: Any) -> dict[tuple[str, str], dict]:
    """Measure every declared path of every alias, tagging what each path is."""
    medidas: dict[tuple[str, str], dict] = {}
    for contexto in contextos:
        rutas = contexto.rutas
        crudas = sonda.medir(contexto, rutas)
        for ruta in rutas:
            if ruta == contexto.hogar:
                clase = "hogar"
            elif ruta == contexto.raiz:
                clase = "raiz"
            else:
                clase = "documento"
            medida = dict(crudas.get(ruta) or {"estado": "ilegible", "detalle": "sin medida"})
            medida["clase"] = clase
            medida["declarada"] = ruta
            medidas[(contexto.alias, ruta)] = medida
    return medidas


def informe(contextos: Sequence[Contexto], hallazgos: Sequence[dict], inventario: str) -> dict:
    contadores = {ALERTA: sum(1 for h in hallazgos if h["severidad"] == ALERTA),
                  AVISO: sum(1 for h in hallazgos if h["severidad"] == AVISO)}
    return {
        "guardia": GUARDIA,
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "inventario": inventario,
        "alias_medidos": [contexto.alias for contexto in contextos],
        "hallazgos": sorted(hallazgos, key=lambda h: (h["severidad"] != ALERTA, h["regla"], h["alias"])),
        "contadores": contadores,
    }


def texto_prometheus(contadores: Mapping[str, int]) -> str:
    lineas = [
        f"# HELP {METRICA} Rutas de gobierno compartidas por más de un alias.",
        f"# TYPE {METRICA} gauge",
    ]
    for severidad in (ALERTA, AVISO):
        lineas.append(f'{METRICA}{{severidad="{severidad}"}} {contadores.get(severidad, 0)}')
    return "\n".join(lineas) + "\n"


def escribir(ruta: str, contenido: str) -> None:
    destino = pathlib.Path(ruta)
    destino.parent.mkdir(parents=True, exist_ok=True)
    temporal = destino.with_name(destino.name + ".tmp")
    temporal.write_text(contenido, encoding="utf-8")
    os.replace(temporal, destino)


def imprimir(reporte: Mapping[str, Any]) -> None:
    for h in reporte["hallazgos"]:
        print(f"{h['severidad'].upper():<7} {h['regla']:<20} {','.join(h['alias']):<24} "
              f"{h['ruta']:<44} {h['detalle']}")
    contadores = reporte["contadores"]
    print(f"{contadores[ALERTA]} alerta(s), {contadores[AVISO]} aviso(s) sobre "
          f"{len(reporte['alias_medidos'])} alias medidos")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Colisiones de rutas de gobierno entre alias")
    parser.add_argument("--flota", help="inventario a leer (por defecto, el del espejo de ops/)")
    parser.add_argument("--raiz", help="mide sobre un árbol local <raiz>/<contenedor>/... en vez de "
                                       "entrar a los contenedores")
    parser.add_argument("--estado", default=ESTADO_POR_DEFECTO, help="documento JSON del resultado")
    parser.add_argument("--prometheus", default=PROMETHEUS_POR_DEFECTO,
                        help="fichero de métricas en formato de exposición")
    parser.add_argument("--json", action="store_true", help="imprime el informe completo en JSON")
    parser.add_argument("--agora", default=AGORA, help="destino ssh del otro demonio docker")
    args = parser.parse_args(argv)

    ops_root = find_ops_root(OPS_ROOT_CANDIDATES)
    sys.path.insert(0, str(ops_root / "scripts"))
    from fleet_derive import HARNESS_RULES

    inventario = args.flota or str(ops_root / INVENTARIO)
    contrato = json.loads((ops_root / CONTRATO).read_text(encoding="utf-8"))
    contextos, hallazgos = contextos_de_la_flota(
        json.loads(pathlib.Path(inventario).read_text(encoding="utf-8")), contrato, HARNESS_RULES,
    )
    sonda = SondaLocal(args.raiz) if args.raiz else SondaDeFlota(agora=args.agora)
    hallazgos.extend(evaluar(contextos, medir_flota(contextos, sonda)))
    reporte = informe(contextos, hallazgos, inventario)

    escribir(args.estado, json.dumps(reporte, ensure_ascii=False, indent=1) + "\n")
    escribir(args.prometheus, texto_prometheus(reporte["contadores"]))
    if args.json:
        print(json.dumps(reporte, ensure_ascii=False, indent=1))
    else:
        imprimir(reporte)
    return 1 if reporte["contadores"][ALERTA] else 0


if __name__ == "__main__":
    raise SystemExit(main())
