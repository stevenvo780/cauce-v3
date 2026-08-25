import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, ContextoDeAlias, HechosDelAlias } from "../src/agent-profile.js";
import { bloqueDePerfil, conBloqueDePerfil, sinBloqueDePerfil } from "../src/marcas-de-bloque.js";
import {
  ErrorDeTopeDelArnes, TOPES_OPENCLAW, ficherosDelArnes, type FicheroGenerado,
} from "../src/ficheros-del-arnes.js";

/**
 * SEIS DEFECTOS QUE LA SUITE DE 20 CASOS DEJABA PASAR EN VERDE.
 *
 * Los encontró una revisión adversarial el 2026-08-25, no yo, y ése es el punto: cada uno tenía
 * comentarios largos explicando la decisión correcta y ninguna prueba que la midiera. Un módulo
 * cuyos comentarios prometen más de lo que sus pruebas exigen es un módulo que va a divergir de su
 * documentación en silencio.
 *
 * Cada prueba de aquí abajo estaba en ROJO antes del arreglo correspondiente. Lo comprobé
 * revirtiendo el arreglo una por una, no razonándolo.
 */

const HECHOS: HechosDelAlias = {
  permisos: { ruta: true, lectura: true, control: false, notificacion: true },
  cuotas: [{ proveedor: "claude", cuenta: "saldantia", limite: "2% semanal" }],
  arnes: { harness: "openclaw", home: "/home/dev", contenedor: "ws-argos", capacidades: ["bash"] },
  destinos: ["kant", "zeus"],
};

function perfil(parcial: Partial<AgentProfile> = {}, alias = "argos"): AgentProfile {
  return {
    tenant_id: "Steven", alias,
    purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    ...parcial,
  };
}

function contexto(p: AgentProfile, hechos: Partial<HechosDelAlias> = {}): ContextoDeAlias {
  return { perfil: p, hechos: { ...HECHOS, ...hechos } } as ContextoDeAlias;
}

function de(ficheros: readonly FicheroGenerado[], nombre: string): FicheroGenerado {
  const f = ficheros.find((x) => x.nombre === nombre);
  assert.ok(f, `no vino ${nombre}`);
  return f;
}

// ── 1. EL BLOQUE RANCIO ─────────────────────────────────────────────────────────────────────

test("borrar un campo en la base BORRA el bloque del fichero, no lo deja rancio", () => {
  /*
   * Es el contrato entero de esta tabla: «la base es la fuente de verdad y el fichero se GENERA
   * desde ella». Si vaciar un campo desde la consola deja el texto viejo escrito Y el generador
   * contesta `escribir: false`, el sistema AFIRMA que está al día mientras el agente sigue
   * leyendo lo que alguien ya quitó. Sin error, sin aviso y sin forma de enterarse.
   */
  const conPerfil = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "reparo Cauce" })));
  const soul = de(conPerfil, "SOUL.md");
  assert.ok(soul.texto.includes("reparo Cauce"));

  // Ahora el operador vacía `purpose` en la consola y se vuelve a generar sobre lo que hay.
  const enDisco = new Map([["SOUL.md", soul.texto]]);
  const vaciado = ficherosDelArnes("openclaw", contexto(perfil({})), enDisco);
  const despues = de(vaciado, "SOUL.md");

  assert.equal(despues.escribir, true, "dijo que no había nada que escribir sobre un texto rancio");
  assert.ok(!despues.texto.includes("reparo Cauce"), "el propósito borrado sigue en el fichero");
  assert.equal(bloqueDePerfil(despues.texto), undefined, "el bloque sigue ahí");
});

test("al retirar el bloque, lo que escribió una persona se conserva byte a byte", () => {
  const manual = "# Notas de argos\n\nEsto lo escribió una persona y no es de Cauce.\n";
  const conBloque = conBloqueDePerfil(manual, "<!-- alias: Steven/argos -->\n## Identidad\n\nx");
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})), new Map([["SOUL.md", conBloque]]));
  const soul = de(generado, "SOUL.md");
  assert.ok(soul.texto.includes("Esto lo escribió una persona y no es de Cauce."));
  assert.equal(bloqueDePerfil(soul.texto), undefined);
});

test("CONTROL NEGATIVO: sobre un fichero que NUNCA tuvo bloque no se escribe nada", () => {
  // Sin esto, «retirar» podría implementarse reescribiendo siempre y el fichero de un alias sin
  // perfil recibiría una escritura por turno, en los quince contenedores, para no cambiar nada.
  const manual = "# Notas\n\nsólo texto humano\n";
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})), new Map([["SOUL.md", manual]]));
  assert.equal(de(generado, "SOUL.md").escribir, false);
  assert.equal(de(generado, "SOUL.md").texto, manual);
});

// ── 2. MEMORY.md NO ENTRA EN EL TOPE ────────────────────────────────────────────────────────

test("la memoria del agente NO cuenta para el tope: no puede bloquear la siembra de los siete", () => {
  /*
   * `MEMORY.md` es del agente, no tiene tope y CRECE — es lo que va aprendiendo. Contándolo, un
   * alias con memoria larga se queda sin poder recibir NI SU IDENTIDAD, y el error nombra a
   * `MEMORY.md`, o sea que invita al operador a podar la memoria de un compañero para desatascar
   * un despliegue. Ese borrado es irreversible desde dentro del contenedor.
   */
  const memoriaEnorme = "recuerdo. ".repeat(20_000); // ~200.000 unidades, muy por encima del total
  const enDisco = new Map([["MEMORY.md", memoriaEnorme]]);
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "reparo Cauce" })), enDisco);

  assert.equal(de(generado, "SOUL.md").escribir, true, "la memoria del agente bloqueó su identidad");
  assert.equal(de(generado, "MEMORY.md").texto, memoriaEnorme, "le tocamos la memoria");
  assert.equal(de(generado, "MEMORY.md").escribir, false);
});

test("CONTROL NEGATIVO: lo que SÍ escribimos sigue sujeto al tope", () => {
  // Si el arreglo de arriba se hubiera hecho quitando la comprobación en vez de saltando los
  // ficheros del agente, esto seguiría verde y el tope no protegería nada.
  assert.throws(
    () => ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(TOPES_OPENCLAW.porFichero + 1) }))),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes && error.fichero === "SOUL.md",
  );
});

// ── 3. LA GUARDA DE DUEÑO ───────────────────────────────────────────────────────────────────

test("no se pisa el bloque de OTRO alias: kratos y atlas comparten el mismo inodo", () => {
  /*
   * Medido el 24-ago-2026: `kratos` y `atlas` comparten `$HOME` y su `AGENTS.md` es el MISMO
   * inodo, 12.942 bytes en los dos. Sin guarda, los dos escriben en cada turno y el fichero
   * oscila entre dos identidades con `escribir: true` siempre: ninguno tiene nunca su perfil.
   * `sembrarContextoFijo` —el hermano de este módulo, para el bloque A— ya se negaba por esto.
   */
  const deKratos = ficherosDelArnes(
    "codex", contexto(perfil({ purpose: "soy kratos" }, "kratos")),
  );
  const enDisco = new Map([["AGENTS.md", de(deKratos, "AGENTS.md").texto]]);

  const deAtlas = ficherosDelArnes(
    "codex", contexto(perfil({ purpose: "soy atlas" }, "atlas")), enDisco,
  );
  const resultado = de(deAtlas, "AGENTS.md");

  assert.equal(resultado.escribir, false, "atlas pisó el bloque de kratos");
  assert.ok(resultado.texto.includes("soy kratos"));
  assert.ok(!resultado.texto.includes("soy atlas"));
});

test("CONTROL NEGATIVO: el MISMO alias sí actualiza su propio bloque", () => {
  // Una guarda que no dejara escribir a nadie también pasaría la prueba de arriba, y entonces el
  // perfil no llegaría jamás a ningún fichero.
  const primero = ficherosDelArnes("codex", contexto(perfil({ purpose: "antes" }, "kratos")));
  const enDisco = new Map([["AGENTS.md", de(primero, "AGENTS.md").texto]]);
  const segundo = ficherosDelArnes("codex", contexto(perfil({ purpose: "después" }, "kratos")), enDisco);

  assert.equal(de(segundo, "AGENTS.md").escribir, true);
  assert.ok(de(segundo, "AGENTS.md").texto.includes("después"));
});

test("CONTROL NEGATIVO: dos alias del MISMO nombre en inquilinos distintos no se confunden", () => {
  // El dueño es `inquilino/alias`, no `alias`: dos clientes pueden tener un `argos` cada uno.
  const dePablo = ficherosDelArnes("codex", contexto({
    ...perfil({ purpose: "el argos de Pablo" }, "argos"), tenant_id: "Pablo",
  }));
  const enDisco = new Map([["AGENTS.md", de(dePablo, "AGENTS.md").texto]]);
  const deSteven = ficherosDelArnes("codex", contexto(perfil({ purpose: "el argos de Steven" }, "argos")), enDisco);
  assert.equal(de(deSteven, "AGENTS.md").escribir, false);
});

// ── 4. NADA DE FICHEROS CON SÓLO MECÁNICA ───────────────────────────────────────────────────

test("un perfil SIN NADA autorado no escribe ningún fichero, tampoco en openclaw", () => {
  /*
   * Medido sobre `argos`, que el 24-ago no tenía NINGUNO de los siete ficheros: `claude` y `codex`
   * no escribían nada —`componerBloqueDePerfil` corta con `hayAutorado`— y `openclaw` escribía
   * `AGENTS.md` (417 caracteres) y `TOOLS.md` (228) con sólo mecánica dentro: permisos, contenedor,
   * alias alcanzables y cuotas. Tres arneses, dos criterios para el mismo perfil vacío.
   *
   * Es el «ruido con forma de contrato» que el propio comentario del compilador dice que se niega
   * a emitir. La prueba del perfil vacío que había sólo miraba `SOUL.md`, así que no lo veía.
   */
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})));
  for (const fichero of generado.filter((f) => f.politica === "bloque-gestionado")) {
    assert.equal(fichero.escribir, false, `${fichero.nombre} se iba a escribir sin nada autorado`);
    assert.equal(fichero.texto, "", `${fichero.nombre} lleva texto`);
  }
});

test("los ficheros del agente SÍ se crean vacíos cuando faltan, y eso no es lo mismo", () => {
  /*
   * `MEMORY.md` y `HEARTBEAT.md` van por la política `solo-si-falta`, que es una decisión distinta
   * y deliberada: crear un fichero VACÍO no le enseña nada al agente —no hay encabezado hueco que
   * leer— y `openclaw` los espera. Para `argos`, que el 24-ago no tenía ninguno de los siete, eso
   * es la diferencia entre arrancar con los ficheros que su arnés busca y arrancar sin ellos.
   *
   * Va aparte de la prueba de arriba porque son dos reglas, y meterlas en un mismo bucle haría que
   * relajar una relajara la otra sin que nadie lo notara.
   */
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})));
  for (const nombre of ["MEMORY.md", "HEARTBEAT.md"]) {
    const fichero = de(generado, nombre);
    assert.equal(fichero.politica, "solo-si-falta");
    assert.equal(fichero.escribir, true, `${nombre} no se crea cuando falta`);
    assert.equal(fichero.texto, "", `${nombre} se crea con contenido nuestro dentro`);
  }
});

test("CONTROL NEGATIVO: si el fichero del agente YA existe, no se toca ni se reescribe", () => {
  const memoria = "lo que argos aprendió\n";
  const generado = ficherosDelArnes(
    "openclaw", contexto(perfil({})), new Map([["MEMORY.md", memoria]]),
  );
  assert.equal(de(generado, "MEMORY.md").escribir, false);
  assert.equal(de(generado, "MEMORY.md").texto, memoria);
});

test("CONTROL NEGATIVO: con UNA responsabilidad, AGENTS.md sí lleva la mecánica", () => {
  /*
   * La mecánica ACOMPAÑA a lo autorado, no desaparece. Si el arreglo hubiera sido quitar los
   * permisos y la configuración del arnés del fichero, esta prueba lo caza: el agente tiene que
   * saber qué puede hacer, y decir «control: no» cuesta cuatro palabras.
   */
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ responsibilities: ["reparar Cauce"] })));
  const agents = de(generado, "AGENTS.md");
  assert.equal(agents.escribir, true);
  assert.ok(agents.texto.includes("reparar Cauce"));
  assert.ok(agents.texto.includes("control): no"), "perdió los permisos");
  assert.ok(agents.texto.includes("ws-argos"), "perdió la configuración del arnés");
});

test("CONTROL NEGATIVO: sin herramientas declaradas TOOLS.md no se escribe, con una sí", () => {
  const sin = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "algo" })));
  assert.equal(de(sin, "TOOLS.md").escribir, false);

  const con = ficherosDelArnes("openclaw", contexto(perfil({ tools: ["ssh"] })));
  const tools = de(con, "TOOLS.md");
  assert.equal(tools.escribir, true);
  assert.ok(tools.texto.includes("ssh"));
  assert.ok(tools.texto.includes("saldantia"), "perdió las cuotas");
});

// ── 5. EL TOPE SE MIDE SOBRE EL TEXTO FINAL ─────────────────────────────────────────────────

test("el tope se mide sobre el fichero ENTERO, no sólo sobre nuestro bloque", () => {
  /*
   * Es la propiedad que el comentario de `comprobarTopes` declara con todas las letras —«un bloque
   * de 10.000 dentro de un fichero que una persona ya llenó con 55.000 pasa de largo si se mide
   * sólo lo nuestro, y el que no arranca es el agente»— y que NO tenía prueba: mutando el medidor
   * para contar sólo el bloque, los 20 casos seguían en verde.
   *
   * No la tenía porque un perfil válido (tope 24.000) nunca llega solo a 60.000: la guarda SÓLO
   * puede dispararse en el caso del fichero ya lleno por una persona, que es justo el que faltaba.
   */
  const humano = "y".repeat(TOPES_OPENCLAW.porFichero - 500);
  const enDisco = new Map([["SOUL.md", humano]]);
  assert.throws(
    () => ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(1_000) })), enDisco),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes
      && error.fichero === "SOUL.md"
      && error.medido > TOPES_OPENCLAW.porFichero,
  );
});

test("CONTROL NEGATIVO: el mismo bloque en un fichero vacío NO se pasa de tope", () => {
  // Sin esto, la prueba de arriba pasaría con una guarda que rechazara cualquier bloque grande, y
  // no estaríamos midiendo «el texto final» sino «el bloque».
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(1_000) })));
  assert.equal(de(generado, "SOUL.md").escribir, true);
});

// ── 6. LA RETIRADA DEL BLOQUE, SOLA ─────────────────────────────────────────────────────────

test("sinBloqueDePerfil es idempotente y no acumula líneas en blanco", () => {
  const manual = "# Manual\n\nlo humano\n";
  const conBloque = conBloqueDePerfil(manual, "<!-- alias: Steven/argos -->\nx");
  const primera = sinBloqueDePerfil(conBloque);
  const segunda = sinBloqueDePerfil(primera);
  assert.equal(segunda, primera, "quitar dos veces no da lo mismo");
  assert.ok(primera.includes("lo humano"));
  assert.ok(!primera.includes("CAUCE:PERFIL"));
});

test("sinBloqueDePerfil no toca un fichero que no tiene bloque", () => {
  const manual = "# Manual\n\nsólo humano\n";
  assert.equal(sinBloqueDePerfil(manual), manual);
});
