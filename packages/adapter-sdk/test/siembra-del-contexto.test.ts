import assert from "node:assert/strict";
import test from "node:test";
import {
  bloqueGestionado,
  conBloqueGestionado,
  sembrarContextoFijo,
} from "../src/harnesses/contexto-fijo.js";

/*
 * LA SIEMBRA, y las dos veces que tiene que negarse.
 *
 * Sin siembra el sello no coincide nunca y el recorte del sobre no ocurre jamás en producción:
 * todo el trabajo quedaría en una prueba verde y una flota pagando 8.000 caracteres por entrega.
 *
 * Pero sembrar es escribir en el fichero de otro, y hay dos casos donde escribir hace daño:
 *   1. El fichero es de un alias que comparte `$HOME` (kratos/atlas: mismo inodo, medido).
 *   2. El interruptor está apagado — mientras no se haya decidido encenderlo, no se toca nada.
 */

function io(inicial: string | undefined, habilitado = true) {
  const estado = { contenido: inicial, escrituras: 0 };
  return {
    estado,
    io: {
      habilitado,
      leer: (_r: string) => {
        if (estado.contenido === undefined) throw new Error("ENOENT");
        return estado.contenido;
      },
      escribir: (_r: string, contenido: string) => {
        estado.contenido = contenido;
        estado.escrituras += 1;
      },
    },
  };
}

const FIJO = "CONTRATO DE ZEUS v1";

test("sobre un fichero que no existe, siembra y deja el bloque legible", () => {
  const { estado, io: puerto } = io(undefined);
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "sembrado");
  assert.equal(bloqueGestionado(estado.contenido ?? ""), FIJO);
});

test("sobre un fichero con texto humano, siembra SIN tocar lo humano", () => {
  const manual = "# Manual de zeus\n\nEsto lo escribió una persona.\n";
  const { estado, io: puerto } = io(manual);
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "sembrado");
  assert.ok(estado.contenido?.includes("Esto lo escribió una persona."));
  assert.equal(bloqueGestionado(estado.contenido ?? ""), FIJO);
});

test("si el contrato cambia, la siembra se niega en vez de pisar a ciegas", () => {
  /*
   * Desde dentro del contenedor no se puede distinguir «el contrato cambió» de «este fichero es
   * de otro alias». El daño de las dos opciones NO es simétrico: pisar de más deja a dos alias
   * oscilando entre dos identidades en cada turno; pisar de menos sólo cuesta un sobre entero,
   * que es exactamente lo de hoy. Ante la duda, no se pisa.
   */
  const { estado, io: puerto } = io(conBloqueGestionado("", "CONTRATO VIEJO"));
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "ocupado-por-otro-alias");
  assert.equal(estado.escrituras, 0, "pisó un bloque ajeno");
  assert.equal(bloqueGestionado(estado.contenido ?? ""), "CONTRATO VIEJO");
});

test("sembrar dos veces seguidas no escribe dos veces", () => {
  const { estado, io: puerto } = io("");
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "sembrado");
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "ya-estaba");
  assert.equal(estado.escrituras, 1, "reescribió un fichero que ya estaba al día");
});

// ── CONTROLES NEGATIVOS ─────────────────────────────────────────────────────────────────────

test("CONTROL NEGATIVO: apagado, no escribe NADA", () => {
  const { estado, io: puerto } = io("# Manual\n", false);
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "apagado");
  assert.equal(estado.escrituras, 0);
  assert.equal(estado.contenido, "# Manual\n");
});

test("CONTROL NEGATIVO: sin ruta -openclaw, hermes- no escribe NADA", () => {
  const { estado, io: puerto } = io("");
  assert.equal(sembrarContextoFijo(undefined, FIJO, puerto), "sin-ruta");
  assert.equal(estado.escrituras, 0);
});

test("CONTROL NEGATIVO: si el disco no deja escribir, lo dice y no rompe el turno", () => {
  const puerto = {
    habilitado: true,
    leer: () => "",
    escribir: () => {
      throw new Error("EACCES");
    },
  };
  assert.equal(sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto), "no-se-pudo-escribir");
});

test("CONTROL NEGATIVO: el que siembra es el mismo que resume, o el sello no serviría", () => {
  /*
   * Esta es la propiedad de la que cuelga todo: lo que se escribe tiene que ser BYTE A BYTE lo
   * que después se resume. Si alguien embelleciera el bloque al escribirlo, el sello no
   * coincidiría nunca y el sobre iría entero para siempre — sin dar ningún error.
   */
  const { estado, io: puerto } = io(undefined);
  sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto);
  assert.equal(bloqueGestionado(estado.contenido ?? ""), FIJO);
});
