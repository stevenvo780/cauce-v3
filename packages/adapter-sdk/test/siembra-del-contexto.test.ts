import assert from "node:assert/strict";
import test from "node:test";
import {
  bloqueGestionado,
  conBloqueGestionado,
  sembrarContextoFijo,
} from "../src/harnesses/contexto-fijo.js";

/*
 * THE SEEDING, and the two times it has to refuse.
 *
 * Without seeding the stamp never matches and the envelope trim never happens in production:
 * all the work would be a green test and a fleet paying 8,000 characters per delivery.
 *
 * But seeding means writing into someone else's file, and there are two cases where writing
 * causes damage: (1) the file belongs to an alias that shares `$HOME` (kratos/atlas: same
 * inode, measured); (2) the switch is off — until turning it on has been decided, nothing is touched.
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
   * From inside the container one cannot tell "the contract changed" apart from "this file
   * belongs to another alias". The damage of the two options is NOT symmetric: overwriting
   * too much leaves two aliases oscillating between two identities each turn; overwriting too
   * little only costs one whole envelope, which is exactly today's state. When in doubt, do not overwrite.
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

// ── NEGATIVE CONTROLS ─────────────────────────────────────────────────────────────────────

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
   * This is the property everything hangs from: what is written must be BYTE FOR BYTE what is
   * later resumed. If anyone beautified the block while writing it, the stamp would never
   * match and the envelope would go whole forever — without giving any error.
   */
  const { estado, io: puerto } = io(undefined);
  sembrarContextoFijo("/x/CLAUDE.md", FIJO, puerto);
  assert.equal(bloqueGestionado(estado.contenido ?? ""), FIJO);
});
