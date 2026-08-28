#!/usr/bin/env python3
"""Pruebas para verificar que la trama de presencia del agente PTY incluye `home` y `harness`."""
from __future__ import annotations

import json
import pathlib
import re
import unittest

AGENTE = pathlib.Path(__file__).resolve().parent.parent / "cauce_pty_agent.py"
LANZADOR = pathlib.Path(__file__).resolve().parent.parent / "cauce-pty-launcher.sh"


class LaPresenciaLlevaElHome(unittest.TestCase):
    def test_la_trama_de_presencia_incluye_home(self) -> None:
        fuente = AGENTE.read_text(encoding="utf-8")
        # The frame is built with a dictionary literal inside `json.dumps`. We search for the key
        # exactly as it travels on the wire —`"home": self.bundle["home"]`— and not any `home`
        # in the file, which appears in half a dozen unrelated places.
        self.assertIn(
            '"home": self.bundle["home"]',
            fuente,
            "la presencia no publica el HOME: el gateway se queda sin hechos medidos y toda la via "
            "de documentos contesta «no medido» para siempre",
        )

    def test_el_home_viaja_junto_al_harness_en_la_misma_trama(self) -> None:
        """Los dos en la MISMA trama, o el gateway tendria la mitad de un hecho.

        `hechosDelRegistro` exige los dos y devuelve `undefined` si falta cualquiera: un hecho a
        medias hace que la consola pase de decir honestamente «no se miro» a servir un fichero
        equivocado con cara de medido. Que viajen juntos es lo que hace que esa exigencia se pueda
        cumplir alguna vez.
        """
        fuente = AGENTE.read_text(encoding="utf-8")
        indice_harness = fuente.find('"harness": self.bundle["harness"]')
        indice_home = fuente.find('"home": self.bundle["home"]')
        self.assertNotEqual(indice_harness, -1, "la presencia perdio el harness")
        self.assertNotEqual(indice_home, -1, "la presencia perdio el home")
        # Inside the same frame: no dictionary close may appear between them.
        entre = fuente[min(indice_harness, indice_home):max(indice_harness, indice_home)]
        self.assertNotIn(
            "}))",
            entre,
            "el harness y el home ya no van en la misma trama de presencia",
        )

    def test_la_trama_distingue_configuracion_de_hechos_runtime_medidos(self) -> None:
        fuente = AGENTE.read_text(encoding="utf-8")
        self.assertIn(
            '"runtime_facts_observed": bool(self.bundle["runtime_facts"])',
            fuente,
            "un bundle de rescate sin adaptador podría volver a presentarse como contexto medido",
        )

    def test_el_bundle_declara_home_como_campo_obligatorio(self) -> None:
        """Si el bundle pudiera venir sin `home`, la presencia lanzaria KeyError al conectar.

        El agente no puede arrancar sin `$HOME` -lo necesita para lanzar el pty-, asi que el campo
        ya era obligatorio; esto lo fija para que nadie lo vuelva opcional por el camino y convierta
        un dato que falta en una caida al saludar.
        """
        fuente = AGENTE.read_text(encoding="utf-8")
        campos = re.search(r'"runtime_gid",\s*"home"', fuente)
        self.assertIsNotNone(campos, "`home` ya no esta en los campos obligatorios del bundle")

    def test_el_lanzador_sigue_poniendo_home_en_el_bundle(self) -> None:
        """El otro extremo: quien ESCRIBE el bundle tiene que seguir poniendo el HOME.

        Sin esto la prueba de arriba solo comprobaria que el agente lee una clave que a lo mejor ya
        nadie escribe -verde sobre un dato que no existe-, que es el mismo defecto que persigue
        todo este trabajo con el signo cambiado.
        """
        fuente = LANZADOR.read_text(encoding="utf-8")
        self.assertIn(
            '"home": os.environ["CAUCE_PTY_BUNDLE_HOME"]',
            fuente,
            "el lanzador dejo de escribir el HOME en el bundle",
        )

    def test_control_negativo_la_trama_sigue_siendo_json_valido(self) -> None:
        """Que la clave este no sirve si la trama dejo de ser un objeto que se pueda serializar.

        No se puede importar el agente aqui -abre sockets y pty al construirse-, asi que lo que se
        comprueba es que el bloque de la presencia sigue teniendo la forma de un diccionario
        literal completo: tantas llaves abiertas como cerradas entre `encode_json(TAG_AGENT_HELLO,`
        y su cierre.
        """
        fuente = AGENTE.read_text(encoding="utf-8")
        indice = fuente.find('"home": self.bundle["home"]')
        self.assertNotEqual(indice, -1)
        inicio = fuente.rfind("encode_json(TAG_AGENT_HELLO, {", 0, indice)
        self.assertNotEqual(inicio, -1, "la presencia ya no se arma como el hello del agente")
        bloque = fuente[inicio:fuente.find("}))", indice) + 3]
        self.assertEqual(
            bloque.count("{"), bloque.count("}"),
            "el diccionario de la presencia quedo desbalanceado",
        )
        # And that the sample JSON with the same keys serializes without surprises.
        json.dumps({"harness": "claude", "home": "/home/dev", "modes": ["shell", "harness"]})


if __name__ == "__main__":
    unittest.main()
