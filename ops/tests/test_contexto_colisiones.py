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

    def test_un_hogar_para_dos_arneses_distintos_es_aviso(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "atlas": fila("codex", "ws-humanizar"), "kratos": fila("claude", "ws-humanizar"),
        })
        sembrar(self.arbol, "ws-humanizar", "/home/dev/.codex/AGENTS.md")
        sembrar(self.arbol, "ws-humanizar", "/home/dev/.claude/CLAUDE.md")

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 0)
        hallazgo = self.reglas(reporte)["mismo_hogar"]
        self.assertEqual(hallazgo["severidad"], "aviso")
        self.assertEqual(hallazgo["alias"], ["atlas", "kratos"])
        self.assertEqual(hallazgo["ruta"], "/home/dev")
        self.assertEqual(hallazgo["arneses"], ["claude", "codex"])
        self.assertNotIn("mismo_inodo", self.reglas(reporte))

    def test_un_hogar_para_dos_alias_del_mismo_arnes_es_alerta(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "uno": fila("claude", "ws-humanizar"), "dos": fila("claude", "ws-humanizar"),
        })
        sembrar(self.arbol, "ws-humanizar", "/home/dev/.claude/CLAUDE.md")

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 1)
        reglas = self.reglas(reporte)
        self.assertEqual(reglas["misma_raiz"]["severidad"], "alerta")
        self.assertEqual(reglas["misma_raiz"]["alias"], ["dos", "uno"])
        self.assertEqual(reglas["mismo_inodo"]["alias"], ["dos", "uno"])
        self.assertNotIn("mismo_hogar", reglas)

    def test_hogares_distintos_con_arneses_distintos_no_avisan(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "uno": fila("codex", "c1", home="/home/dev"),
            "dos": fila("claude", "c2", home="/home/claw"),
        })
        sembrar(self.arbol, "c1", "/home/dev/.codex/AGENTS.md")
        sembrar(self.arbol, "c2", "/home/claw/.claude/CLAUDE.md")

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 0)
        self.assertEqual(reporte["hallazgos"], [])
        self.assertEqual(reporte["alias_medidos"], ["dos", "uno"])

    def test_openclaw_gobierna_su_espacio_no_el_home(self) -> None:
        inventario = escribir_inventario(self.dir, {"gaia": fila("openclaw", "c1", home="/home/claw")})
        for nombre in ("SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md",
                       "AGENTS.md", "TOOLS.md"):
            sembrar(self.arbol, "c1", f"/home/claw/clawd/{nombre}")

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 0)
        self.assertEqual(reporte["hallazgos"], [])

    def test_las_raices_salen_del_contrato_no_de_una_tabla_a_mano(self) -> None:
        sys.path.insert(0, str(RAIZ / "ops/scripts"))
        from fleet_derive import HARNESS_RULES

        contrato = json.loads(
            (RAIZ / "ops/schemas/contexto-de-gobierno.json").read_text(encoding="utf-8"),
        )
        inventario = {"fleet": {
            "c": fila("claude", "c1"), "x": fila("codex", "c2"),
            "h": fila("hermes", "c3"), "o": fila("openclaw", "c4", home="/home/claw"),
        }, "placement": {}}

        contextos, hallazgos = guardia.contextos_de_la_flota(inventario, contrato, HARNESS_RULES)

        self.assertEqual(hallazgos, [])
        raices = {contexto.alias: contexto.raiz for contexto in contextos}
        self.assertEqual(raices, {
            "c": "/home/dev/.claude", "x": "/home/dev/.codex", "h": "/home/dev",
            "o": "/home/claw/clawd",
        })
        documentos = {contexto.alias: contexto.documentos for contexto in contextos}
        self.assertEqual(documentos["c"], ("CLAUDE.md",))
        self.assertIn("SOUL.md", documentos["o"])

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

    def test_una_ruta_ilegible_falla_cerrado(self) -> None:
        contexto = guardia.Contexto(
            alias="salva", harness="claude", container="ws-isa", docker_host="kratos",
            hogar="/home/dev", raiz="/home/dev/.claude", documentos=("CLAUDE.md",),
        )
        medidas = {
            ("salva", "/home/dev/.claude/CLAUDE.md"): {
                "estado": "ilegible", "detalle": "PermissionError", "clase": "documento",
                "declarada": "/home/dev/.claude/CLAUDE.md",
            },
        }

        hallazgos = guardia.evaluar([contexto], medidas)

        self.assertEqual(len(hallazgos), 1)
        self.assertEqual(hallazgos[0]["severidad"], "alerta")
        self.assertEqual(hallazgos[0]["regla"], "ruta_ilegible")
        self.assertEqual(hallazgos[0]["alias"], ["salva"])
        self.assertIn("PermissionError", hallazgos[0]["detalle"])

    def test_una_sonda_que_no_corre_deja_todas_las_rutas_ilegibles(self) -> None:
        contexto = guardia.Contexto(
            alias="iza", harness="claude", container="claw-iza", docker_host="kratos",
            hogar="/home/claw", raiz="/home/claw/.claude", documentos=("CLAUDE.md",),
        )
        sonda = guardia.SondaDeFlota(docker=("/bin/false",))

        medidas = sonda.medir(contexto, contexto.rutas)

        self.assertEqual({m["estado"] for m in medidas.values()}, {"ilegible"})
        self.assertEqual(set(medidas), set(contexto.rutas))

    def test_un_contenedor_inalcanzable_deja_un_solo_hallazgo_por_alias(self) -> None:
        contexto = guardia.Contexto(
            alias="iza", harness="openclaw", container="claw-iza", docker_host="kratos",
            hogar="/home/claw", raiz="/home/claw/clawd", documentos=("SOUL.md", "AGENTS.md"),
        )
        medidas = guardia.medir_flota([contexto], guardia.SondaDeFlota(docker=("/bin/false",)))

        hallazgos = guardia.evaluar([contexto], medidas)

        self.assertEqual(len(hallazgos), 1)
        self.assertEqual(hallazgos[0]["regla"], "ruta_ilegible")
        self.assertEqual(hallazgos[0]["severidad"], "alerta")
        self.assertEqual(hallazgos[0]["alias"], ["iza"])
        self.assertEqual(sorted(hallazgos[0]["rutas"]), sorted(contexto.rutas))

    def test_un_arnes_fuera_del_contrato_no_se_proyecta_en_silencio(self) -> None:
        inventario = escribir_inventario(self.dir, {"raro": fila("opencode", "c1")})

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 1)
        hallazgo = self.reglas(reporte)["alias_no_proyectable"]
        self.assertEqual(hallazgo["alias"], ["raro"])
        self.assertEqual(reporte["alias_medidos"], [])

    def test_un_alias_apagado_no_se_mide(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "uno": fila("claude", "c1"), "dormido": fila("claude", "c1", enabled=False),
        })
        sembrar(self.arbol, "c1", "/home/dev/.claude/CLAUDE.md")

        codigo, reporte, _ = self.correr(inventario)

        self.assertEqual(codigo, 0)
        self.assertEqual(reporte["alias_medidos"], ["uno"])

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

    def test_las_metricas_cuentan_por_severidad(self) -> None:
        inventario = escribir_inventario(self.dir, {
            "atlas": fila("codex", "ws-humanizar"), "kratos": fila("claude", "ws-humanizar"),
        })
        sembrar(self.arbol, "ws-humanizar", "/home/dev/.codex/AGENTS.md")
        sembrar(self.arbol, "ws-humanizar", "/home/dev/.claude/CLAUDE.md")

        self.correr(inventario)

        texto = self.prom.read_text(encoding="utf-8")
        self.assertIn('cauce_context_path_collisions{severidad="alerta"} 0', texto)
        self.assertIn('cauce_context_path_collisions{severidad="aviso"} 1', texto)

    def test_la_flota_real_se_proyecta_entera(self) -> None:
        sys.path.insert(0, str(RAIZ / "ops/scripts"))
        from fleet_derive import HARNESS_RULES

        inventario = json.loads(FLOTA.read_text(encoding="utf-8"))
        contrato = json.loads(
            (RAIZ / "ops/schemas/contexto-de-gobierno.json").read_text(encoding="utf-8"),
        )

        contextos, hallazgos = guardia.contextos_de_la_flota(inventario, contrato, HARNESS_RULES)

        self.assertEqual(hallazgos, [])
        activos = [a for a, f in inventario["fleet"].items() if f.get("enabled") is True]
        self.assertEqual(len(contextos), len(activos))
        for contexto in contextos:
            self.assertTrue(contexto.raiz.startswith(contexto.hogar))
            self.assertTrue(contexto.documentos)


if __name__ == "__main__":
    unittest.main()
