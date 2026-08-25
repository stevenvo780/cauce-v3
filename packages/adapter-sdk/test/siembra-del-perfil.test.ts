import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfile, ContextoDeAlias, HechosDelAlias } from "@cauce/protocol";
import { bloqueDePerfil } from "@cauce/protocol";
import {
  directorioDelArnes, resumenDeLaSiembra, sembrarPerfilDelArnes, type DiscoDelArnes,
} from "../src/context/siembra-del-perfil.js";

/**
 * LA PIEZA QUE TOCA EL DISCO DE VERDAD.
 *
 * Todo lo anterior componía texto. Esto lo escribe dentro del contenedor de un agente que está
 * trabajando, así que lo que se prueba aquí no es «sale el texto correcto» —eso ya está probado en
 * el protocolo— sino las tres cosas que hacen daño si se tuercen:
 *
 *   · escribir cuando NO había que escribir (pisar a un compañero, o al que escribió una persona),
 *   · escribir en el sitio equivocado (el `$HOME` de otro, o el directorio de otro alias),
 *   · tumbar el saludo por no poder escribir, dejando a un alias sordo por un fichero.
 */

const HECHOS: HechosDelAlias = {
  permisos: { ruta: true, lectura: true, control: false, notificacion: true },
  cuotas: [],
  arnes: { harness: "claude", home: "/home/dev", capacidades: ["bash"] },
  destinos: ["kant"],
};

function contexto(parcial: Partial<AgentProfile> = {}, alias = "zeus"): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: "Steven", alias,
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      ...parcial,
    },
    hechos: HECHOS,
  } as ContextoDeAlias;
}

/** Un disco de mentira que además CUENTA las escrituras: «no se escribió» es media prueba. */
function disco(inicial: Record<string, string> = {}) {
  const ficheros = new Map(Object.entries(inicial));
  const escrituras: string[] = [];
  const puerto: DiscoDelArnes = {
    leer: (ruta) => ficheros.get(ruta),
    escribir: (ruta, contenido) => { ficheros.set(ruta, contenido); escrituras.push(ruta); },
  };
  return { ficheros, escrituras, puerto };
}

const ENTORNO = { HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/home/dev/.claude-zeus" };

// ── DÓNDE SE ESCRIBE ────────────────────────────────────────────────────────────────────────

test("CLAUDE_CONFIG_DIR gana sobre $HOME: es cómo dos alias del mismo contenedor se separan", () => {
  /*
   * No es una preferencia: es el mecanismo. Una prueba mía se puso roja por leer mi `CLAUDE.md` de
   * verdad justamente por no respetarlo, y en producción ignorarlo significaría que dos alias del
   * mismo contenedor se escriben encima el perfil en cada conexión.
   */
  assert.equal(directorioDelArnes("claude", ENTORNO), "/home/dev/.claude-zeus");
  assert.equal(directorioDelArnes("claude", { HOME: "/home/dev" }), "/home/dev/.claude");
});

test("codex mira CODEX_HOME, y openclaw NO adivina su espacio de trabajo", () => {
  assert.equal(directorioDelArnes("codex", { HOME: "/h", CODEX_HOME: "/otro" }), "/otro");
  assert.equal(directorioDelArnes("codex", { HOME: "/h" }), "/h/.codex");
  /*
   * El espacio de trabajo de un openclaw NO es su `$HOME`. Sin `CAUCE_OPENCLAW_WORKSPACE` no se
   * adivina: sembrar siete Markdown en el sitio equivocado es peor que no sembrar, porque el
   * agente no los lee y en cambio quedan siete ficheros huérfanos que el siguiente que mire va a
   * creer que son los buenos.
   */
  assert.equal(directorioDelArnes("openclaw", { HOME: "/h" }), undefined);
  assert.equal(directorioDelArnes("openclaw", { HOME: "/h", CAUCE_OPENCLAW_WORKSPACE: "/ws" }), "/ws");
});

test("CONTROL NEGATIVO: un arnés desconocido no tiene directorio, y sin HOME tampoco", () => {
  assert.equal(directorioDelArnes("hermes", ENTORNO), undefined);
  assert.equal(directorioDelArnes("claude", {}), undefined);
});

// ── EL INTERRUPTOR ──────────────────────────────────────────────────────────────────────────

test("APAGADO no escribe NADA, y lo dice", () => {
  /*
   * Está apagado por defecto a propósito: esto escribe dentro del contenedor de quince agentes que
   * están trabajando. Encenderlo es una decisión con fecha y con alguien mirando, no un efecto
   * secundario de desplegar una versión.
   */
  const d = disco();
  const resultado = sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico" }), {
    habilitado: false, disco: d.puerto, entorno: ENTORNO,
  });
  assert.equal(resultado.estado, "apagado");
  assert.equal(d.escrituras.length, 0);
});

test("encendido, escribe el fichero del arnés en su sitio", () => {
  const d = disco();
  const resultado = sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico de la flota" }), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO,
  });
  assert.equal(resultado.estado, "hecho");
  assert.deepEqual(d.escrituras, ["/home/dev/.claude-zeus/CLAUDE.md"]);
  const escrito = d.ficheros.get("/home/dev/.claude-zeus/CLAUDE.md") ?? "";
  assert.ok(escrito.includes("el médico de la flota"));
  assert.ok(bloqueDePerfil(escrito) !== undefined, "no quedó un bloque legible");
});

// ── LO QUE NO SE PISA ───────────────────────────────────────────────────────────────────────

test("lo que escribió una persona se conserva BYTE A BYTE", () => {
  const manual = "# Manual de zeus\n\nEsto lo escribió una persona.\n";
  const d = disco({ "/home/dev/.claude-zeus/CLAUDE.md": manual });
  sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico" }), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO,
  });
  const despues = d.ficheros.get("/home/dev/.claude-zeus/CLAUDE.md") ?? "";
  assert.ok(despues.includes("Esto lo escribió una persona."));
  assert.ok(despues.includes("el médico"));
});

test("segunda conexión con el mismo perfil: NO se reescribe el fichero", () => {
  /*
   * Un alias se reconecta muchas veces al día. Si cada saludo reescribiera el fichero, quince
   * contenedores estarían tocando el disco sin cambiar nada — y peor, cualquier vigía que mire
   * `mtime` vería actividad constante donde no la hay.
   */
  const d = disco();
  const opciones = { habilitado: true, disco: d.puerto, entorno: ENTORNO };
  sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico" }), opciones);
  assert.equal(d.escrituras.length, 1);

  const segunda = sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico" }), opciones);
  assert.equal(d.escrituras.length, 1, "reescribió un fichero que ya estaba al día");
  assert.equal(segunda.estado, "hecho");
  if (segunda.estado === "hecho") assert.equal(segunda.ficheros[0]?.estado, "ya-estaba");
});

test("el bloque de OTRO alias no se pisa, y el parte lo dice con esas palabras", () => {
  /*
   * `kratos` y `atlas` comparten `$HOME` y su `AGENTS.md` es el MISMO inodo (12.942 bytes en los
   * dos, medido). Que el parte distinga «ya estaba» de «ocupado por otro alias» no es cosmética:
   * son las dos únicas explicaciones de un alias sin perfil, y llevan a sitios opuestos.
   */
  const d = disco();
  const opciones = { habilitado: true, disco: d.puerto, entorno: { HOME: "/h", CODEX_HOME: "/compartido" } };
  sembrarPerfilDelArnes("codex", contexto({ purpose: "soy kratos" }, "kratos"), opciones);
  const trasKratos = d.ficheros.get("/compartido/AGENTS.md") ?? "";

  const resultado = sembrarPerfilDelArnes("codex", contexto({ purpose: "soy atlas" }, "atlas"), opciones);
  assert.equal(d.ficheros.get("/compartido/AGENTS.md"), trasKratos, "atlas pisó a kratos");
  assert.equal(resultado.estado, "hecho");
  if (resultado.estado === "hecho") {
    assert.equal(resultado.ficheros[0]?.estado, "ocupado-por-otro-alias");
  }
});

// ── LO QUE NO PUEDE TUMBAR EL SALUDO ────────────────────────────────────────────────────────

test("si el disco no deja escribir, lo dice y NO lanza", () => {
  /*
   * Ésta es la propiedad de la que depende que un fichero no deje a un alias sordo. El llamador es
   * el manejador del `hello_ack`: una excepción aquí corta el saludo y el agente no recibe NADA.
   */
  const puerto: DiscoDelArnes = {
    leer: () => undefined,
    escribir: () => { throw new Error("EACCES"); },
  };
  const resultado = sembrarPerfilDelArnes("claude", contexto({ purpose: "x" }), {
    habilitado: true, disco: puerto, entorno: ENTORNO,
  });
  assert.equal(resultado.estado, "hecho");
  if (resultado.estado === "hecho") {
    assert.equal(resultado.ficheros[0]?.estado, "no-se-pudo-escribir");
  }
});

test("si el disco no deja LEER, se sigue: un fichero ilegible no bloquea a los otros seis", () => {
  const escrituras: string[] = [];
  const puerto: DiscoDelArnes = {
    leer: (ruta) => { if (ruta.endsWith("SOUL.md")) throw new Error("EACCES"); return undefined; },
    escribir: (ruta) => { escrituras.push(ruta); },
  };
  const ctx = contexto({ purpose: "p", role_summary: "r", tools: ["ssh"] });
  const resultado = sembrarPerfilDelArnes("openclaw", ctx, {
    habilitado: true, disco: puerto, entorno: { HOME: "/h", CAUCE_OPENCLAW_WORKSPACE: "/ws" },
  });
  assert.equal(resultado.estado, "hecho");
  assert.ok(escrituras.some((r) => r.endsWith("IDENTITY.md")), "un fichero ilegible frenó a los demás");
});

test("un tope superado NO escribe NINGUNO de los siete", () => {
  /*
   * Una persona a medias —cuatro ficheros al día y tres no— se contradice a sí misma, y el modelo
   * no tiene forma de saber cuál creer. Es preferible no escribir nada y decirlo.
   */
  const d = disco();
  const resultado = sembrarPerfilDelArnes("openclaw", contexto({ purpose: "x".repeat(60_001) }), {
    habilitado: true, disco: d.puerto, entorno: { HOME: "/h", CAUCE_OPENCLAW_WORKSPACE: "/ws" },
  });
  assert.equal(resultado.estado, "no-entra");
  assert.equal(d.escrituras.length, 0);
  if (resultado.estado === "no-entra") assert.equal(resultado.fichero, "SOUL.md");
});

test("CONTROL NEGATIVO: un arnés sin ficheros no escribe y no es un error", () => {
  const d = disco();
  const resultado = sembrarPerfilDelArnes("hermes", contexto({ purpose: "x" }), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO,
  });
  assert.equal(resultado.estado, "sin-ficheros");
  assert.equal(d.escrituras.length, 0);
});

// ── EL PARTE ────────────────────────────────────────────────────────────────────────────────

test("el resumen nunca lleva el CONTENIDO del fichero", () => {
  /*
   * El parte va al registro, y el registro se lee, se copia y a veces se pega en un chat. El perfil
   * de un alias puede nombrar a su humano y describir cómo tratarlo. Sólo nombres y estados.
   */
  const d = disco();
  const resultado = sembrarPerfilDelArnes(
    "claude", contexto({ purpose: "SECRETO-QUE-NO-DEBE-SALIR" }),
    { habilitado: true, disco: d.puerto, entorno: ENTORNO },
  );
  const texto = resumenDeLaSiembra(resultado);
  assert.ok(!texto.includes("SECRETO-QUE-NO-DEBE-SALIR"));
  assert.ok(texto.includes("escrito"));
});

test("el resumen distingue apagado de no-se-pudo", () => {
  // Un silencio no distingue «el interruptor está apagado» de «no se pudo escribir», y son las dos
  // respuestas a la misma pregunta: por qué este alias no tiene su perfil.
  const d = disco();
  const apagado = sembrarPerfilDelArnes("claude", contexto({ purpose: "x" }), {
    habilitado: false, disco: d.puerto, entorno: ENTORNO,
  });
  assert.ok(resumenDeLaSiembra(apagado).includes("apagada"));
});
