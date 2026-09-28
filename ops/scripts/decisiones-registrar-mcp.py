#!/usr/bin/env python3
"""Registers (or removes) the `cauce-decisiones` MCP server in one harness's native config.

Dry run by default: prints the entry and how many lines change, and writes nothing. It never prints
lines of the file: neighbouring entries may hold credentials inline. `--aplicar` writes atomically,
keeps a 0600 backup next to the file and preserves its mode and owner. Run it as the harness user
inside the agent's container, with no turn in flight: the harness reloads MCP only on a new session.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import stat
import sys
import tempfile
import time
from pathlib import Path

NOMBRE = "cauce-decisiones"
TABLA = re.compile(r"^\[{1,2}[^\[\]\n]+\]{1,2}\s*(#.*)?$")


def fallar(mensaje: str) -> None:
    print(f"registrar-mcp: {mensaje}", file=sys.stderr)
    sys.exit(1)


def cabecera_toml(nombre: str) -> re.Pattern[str]:
    return re.compile(rf'^\[mcp_servers\.(?:{re.escape(nombre)}|"{re.escape(nombre)}")\]\s*(#.*)?$')


def bloque_toml(texto: str, nombre: str) -> tuple[int, int] | None:
    """Line span of `[mcp_servers.<nombre>]` up to the next table header."""
    lineas = texto.splitlines(keepends=True)
    inicio = next((i for i, linea in enumerate(lineas) if cabecera_toml(nombre).match(linea.rstrip("\n"))), None)
    if inicio is None:
        return None
    fin = next((i for i in range(inicio + 1, len(lineas)) if TABLA.match(lineas[i].rstrip("\n"))), len(lineas))
    return inicio, fin


def entrada_existente(arnes: str, texto: str, nombre: str) -> dict | None:
    if arnes in ("claude", "openclaw"):
        documento = json.loads(texto or "{}")
        servidores = documento.get("mcpServers", {}) if arnes == "claude" else documento.get("mcp", {}).get("servers", {})
        return servidores.get(nombre)
    try:
        import tomllib
    except ModuleNotFoundError:
        fallar("hace falta python >= 3.11 (tomllib) para leer la configuración TOML")
    return tomllib.loads(texto).get("mcp_servers", {}).get(nombre)


def editar_json(arnes: str, texto: str, entrada: dict | None) -> str:
    documento = json.loads(texto or "{}")
    if arnes == "claude":
        servidores = documento.setdefault("mcpServers", {})
    else:
        servidores = documento.setdefault("mcp", {}).setdefault("servers", {})
    if entrada is None:
        servidores.pop(NOMBRE, None)
    else:
        servidores[NOMBRE] = entrada
    return json.dumps(documento, indent=2, ensure_ascii=False) + "\n"


def editar_toml(arnes: str, texto: str, entrada: dict | None) -> str:
    lineas = texto.splitlines(keepends=True)
    tramo = bloque_toml(texto, NOMBRE)
    if tramo is not None:
        del lineas[tramo[0]:tramo[1]]
    while lineas and not lineas[-1].strip():
        lineas.pop()
    if lineas and not lineas[-1].endswith("\n"):
        lineas[-1] += "\n"
    if entrada is not None:
        argumentos = ",\n".join(f"    {json.dumps(valor)}" for valor in entrada["args"])
        bloque = [f"[mcp_servers.{NOMBRE}]\n", f"command = {json.dumps(entrada['command'])}\n", f"args = [\n{argumentos},\n]\n"]
        if arnes == "grok":
            bloque.append("enabled = true\n")
        lineas.extend(["\n", *bloque] if lineas else bloque)
    return "".join(lineas)


def sin_entrada(arnes: str, texto: str) -> dict:
    if arnes in ("claude", "openclaw"):
        documento = json.loads(texto or "{}")
        servidores = documento.get("mcpServers", {}) if arnes == "claude" else documento.get("mcp", {}).get("servers", {})
    else:
        import tomllib

        documento = tomllib.loads(texto)
        servidores = documento.get("mcp_servers", {})
    servidores.pop(NOMBRE, None)
    return documento


def validar(arnes: str, original: str, texto: str, entrada: dict | None) -> None:
    if sin_entrada(arnes, original) != sin_entrada(arnes, texto):
        fallar("el cambio tocaría algo más que la entrada cauce-decisiones")
    leida = entrada_existente(arnes, texto, NOMBRE)
    if entrada is None and leida is not None:
        fallar("la entrada sigue presente tras quitarla")
    if entrada is not None and (leida is None or leida.get("command") != entrada["command"] or leida.get("args") != entrada["args"]):
        fallar("la configuración resultante no contiene la entrada esperada")


def escribir(ruta: Path, texto: str) -> Path:
    metadatos = ruta.stat()
    respaldo = ruta.with_name(f"{ruta.name}.pre-{NOMBRE}.{time.strftime('%Y%m%d%H%M%S')}.{time.time_ns() % 1_000_000_000}")
    descriptor = os.open(respaldo, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as copia:
        copia.write(ruta.read_text(encoding="utf-8"))
    temporal = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=ruta.parent, prefix=f".{ruta.name}.", delete=False)
    with temporal:
        temporal.write(texto)
        temporal.flush()
        os.fsync(temporal.fileno())
    os.chmod(temporal.name, stat.S_IMODE(metadatos.st_mode))
    if os.geteuid() == 0:
        os.chown(temporal.name, metadatos.st_uid, metadatos.st_gid)
    os.replace(temporal.name, ruta)
    return respaldo


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arnes", required=True, choices=["claude", "codex", "openclaw", "grok"])
    parser.add_argument("--config", required=True, type=Path,
                        help="claude: .claude.json · codex: $CODEX_HOME/config.toml · openclaw: openclaw.json · grok: ~/.grok/config.toml")
    parser.add_argument("--bin", help="ruta absoluta de cauce-decisiones-mcp.js en la release del adaptador")
    parser.add_argument("--socket", help="ruta absoluta de mcp-emission.sock; por defecto, la del servidor `cauce` ya registrado")
    parser.add_argument("--command", help="binario de node; por defecto, el del servidor `cauce` o `node`")
    parser.add_argument("--quitar", action="store_true", help="quita la entrada (reversa)")
    parser.add_argument("--aplicar", action="store_true", help="escribe; sin esto sólo muestra el cambio")
    opciones = parser.parse_args()

    ruta: Path = opciones.config
    if ruta.is_symlink() or not ruta.is_file():
        fallar(f"{ruta} debe ser un fichero regular (no se reemplazan enlaces)")
    texto = ruta.read_text(encoding="utf-8")
    entrada = None
    if not opciones.quitar:
        cauce = entrada_existente(opciones.arnes, texto, "cauce") or {}
        argumentos_cauce = cauce.get("args") or []
        socket = opciones.socket or (argumentos_cauce[1] if len(argumentos_cauce) > 1 else None)
        if opciones.bin is None or socket is None:
            fallar("hacen falta --bin y --socket (o un servidor `cauce` registrado del que tomar el socket)")
        for valor in (opciones.bin, socket):
            if not os.path.isabs(valor):
                fallar(f"{valor} no es una ruta absoluta")
        entrada = {"command": opciones.command or cauce.get("command") or "node", "args": [opciones.bin, socket]}
        if opciones.arnes == "claude":
            entrada = {"type": "stdio", **entrada}

    editar = editar_json if opciones.arnes in ("claude", "openclaw") else editar_toml
    nuevo = editar(opciones.arnes, texto, entrada)
    validar(opciones.arnes, texto, nuevo, entrada)
    cambios = sum(1 for linea in difflib.ndiff(texto.splitlines(), nuevo.splitlines()) if linea[:1] in "+-")
    print(json.dumps(entrada, ensure_ascii=False, indent=2) if entrada is not None else f"quitar {NOMBRE}")
    print(f"{ruta}: {cambios} líneas cambian")
    if not opciones.aplicar:
        print("\nsimulación: nada escrito. Repetí con --aplicar para escribir.")
        return
    if nuevo == texto:
        return
    respaldo = escribir(ruta, nuevo)
    print(f"\nescrito {ruta}; respaldo en {respaldo}. El arnés toma el MCP en su próxima sesión.")


if __name__ == "__main__":
    main()
