#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

RAIZ = pathlib.Path(__file__).resolve().parents[2]
GUARDIA = RAIZ / "ops/guardias/cauce-contexto-colisiones.py"
FLOTA = RAIZ / "ops/flota.json"


def cargar_guardia():
    spec = importlib.util.spec_from_file_location("cauce_contexto_colisiones", GUARDIA)
    modulo = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = modulo
    spec.loader.exec_module(modulo)
    return modulo


guardia = cargar_guardia()


def fila(harness: str, container: str, home: str = "/home/dev", enabled: bool = True) -> dict:
    return {
        "container": container, "enabled": enabled, "harness": harness, "home": home,
        "role": "agent", "room": "grp.steven", "tenant": "Steven", "user": "dev",
        "runtimeStateDirectory": f"{home}/.local/state/cauce-v3/x",
    }


def escribir_inventario(directorio: pathlib.Path, filas: dict, placement: dict | None = None) -> str:
    ruta = directorio / "flota.json"
    ruta.write_text(json.dumps({
        "schemaVersion": 3, "fleet": filas, "placement": placement or {},
        "retired": {}, "systemPrincipals": {},
    }), encoding="utf-8")
    return str(ruta)


def sembrar(arbol: pathlib.Path, container: str, ruta: str, contenido: str = "x\n") -> pathlib.Path:
    destino = arbol / container / ruta.lstrip("/")
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(contenido, encoding="utf-8")
    return destino


class GuardiaDeColisiones(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.arbol = self.dir / "arbol"
        self.estado = self.dir / "estado.json"
        self.prom = self.dir / "metricas.prom"
        self.addCleanup(self.tmp.cleanup)

    def correr(self, inventario: str) -> tuple[int, dict, str]:
        salida = io.StringIO()
        with contextlib.redirect_stdout(salida):
            codigo = guardia.main([
                "--flota", inventario, "--raiz", str(self.arbol),
                "--estado", str(self.estado), "--prometheus", str(self.prom),
            ])
        return codigo, json.loads(self.estado.read_text(encoding="utf-8")), salida.getvalue()

    def reglas(self, reporte: dict) -> dict[str, dict]:
        return {h["regla"]: h for h in reporte["hallazgos"]}

    def test_dos_alias_sobre_el_mismo_inodo_es_alerta(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "uno": fila("claude", "c1"), "dos": fila("claude", "c2"),
        })
        original = sembrar(self.arbol, "c1", "/home/dev/.claude/CLAUDE.md", "secreto-de-uno\n")
        gemelo = self.arbol / "c2/home/dev/.claude/CLAUDE.md"
        gemelo.parent.mkdir(parents=True, exist_ok=True)
        os.link(original, gemelo)

        codigo, reporte, texto = self.correr(inventario)

        self.assertEqual(codigo, 1)
        hallazgo = self.reglas(reporte)["mismo_inodo"]
        self.assertEqual(hallazgo["severidad"], "alerta")
        self.assertEqual(hallazgo["alias"], ["dos", "uno"])
        self.assertEqual(hallazgo["ruta"], "/home/dev/.claude/CLAUDE.md")
        self.assertIn("MISMO_INODO".lower(), texto)
        self.assertNotIn("secreto-de-uno", texto)
        self.assertNotIn("secreto-de-uno", json.dumps(reporte))

    def test_dos_ficheros_distintos_con_el_mismo_contenido_no_son_colision(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "uno": fila("claude", "c1"), "dos": fila("claude", "c2"),
        })
        sembrar(self.arbol, "c1", "/home/dev/.claude/CLAUDE.md", "identico\n")
        sembrar(self.arbol, "c2", "/home/dev/.claude/CLAUDE.md", "identico\n")

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 0)
        self.assertEqual(reporte["hallazgos"], [])
        self.assertEqual(reporte["contadores"], {"alerta": 0, "aviso": 0})

    def test_una_ruta_ausente_falla_cerrado_y_nombra_al_alias(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "uno": fila("claude", "c1"), "dos": fila("claude", "c2"),
        })
        sembrar(self.arbol, "c1", "/home/dev/.claude/CLAUDE.md")

        codigo, reporte, texto = self.correr(inventario)

        self.assertEqual(codigo, 1)
        ausentes = [h for h in reporte["hallazgos"] if h["regla"].endswith("_ausente")]
        self.assertEqual({h["severidad"] for h in ausentes}, {"alerta"})
        self.assertEqual({tuple(h["alias"]) for h in ausentes}, {("dos",)})
        self.assertEqual({h["regla"] for h in ausentes}, {"hogar_ausente", "raiz_ausente"})
        self.assertIn("dos", texto)

    def test_un_inodo_igual_en_hosts_distintos_no_es_colision(self) -> None:
        base = {"harness": "claude", "hogar": "/home/dev", "raiz": "/home/dev/.claude",
                "documentos": ("CLAUDE.md",)}
        en_kratos = guardia.Contexto(alias="salva", container="ws-isa", docker_host="kratos", **base)
        en_vps = guardia.Contexto(alias="zeus", container="ws-zeus", docker_host="local", **base)
        ruta = "/home/dev/.claude/CLAUDE.md"
        medida = {"estado": "ok", "canonica": ruta, "dev": 42, "ino": 7, "clase": "documento",
                  "declarada": ruta}
        medidas = {("salva", ruta): dict(medida), ("zeus", ruta): dict(medida)}

        self.assertEqual(guardia.evaluar([en_kratos, en_vps], medidas), [])

        mismo_host = guardia.Contexto(alias="zeus", container="ws-zeus", docker_host="kratos", **base)
        hallazgos = guardia.evaluar([en_kratos, mismo_host], medidas)
        self.assertEqual([h["regla"] for h in hallazgos], ["mismo_inodo"])
        self.assertEqual(hallazgos[0]["host"], "kratos")

    def test_la_sonda_alcanza_los_dos_gestores_y_el_host(self) -> None:
        sonda = guardia.SondaDeFlota()
        base = {"harness": "claude", "hogar": "/home/dev", "raiz": "/home/dev/.claude",
                "documentos": ("CLAUDE.md",)}
        en_kratos = guardia.Contexto(alias="salva", container="ws-isa", docker_host="kratos", **base)
        en_vps = guardia.Contexto(alias="zeus", container="ws-zeus", docker_host="local", **base)
        en_host = guardia.Contexto(alias="kant", container="host:kratos", docker_host="local", **base)

        self.assertEqual(sonda.comando(en_kratos, ["/x"])[:3], ["docker", "exec", "ws-isa"])
        self.assertEqual(sonda.comando(en_vps, ["/x"])[0], "ssh")
        self.assertIn(guardia.AGORA, sonda.comando(en_vps, ["/x"]))
        self.assertEqual(sonda.comando(en_host, ["/x"])[0], "python3")

if __name__ == "__main__":
    unittest.main()
