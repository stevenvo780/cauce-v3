import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROFILE_LIMITS, ROLE_BRIEF_MAX_CODE_POINTS, countCodePoints, type AgentProfile,
} from "@cauce/protocol";
import {
  MARCA_FIN, MARCA_INICIO, bloqueGestionado, conBloqueGestionado, resumirContextoFijo,
} from "../src/harnesses/contexto-fijo.js";
import {
  CLAVES_PROHIBIDAS_OPENCLAW, MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO, bloqueDePerfil,
  componerBloqueDePerfil, conBloqueDePerfil, proyeccionOpenclaw, rolBreveDelPerfil,
  serializarEstable, type HechosDelAlias,
} from "../src/context/perfil-a-contexto.js";

/**
 * EL COMPILADOR DE CONTEXTO: perfil + hechos del arnés -> el texto del fichero.
 *
 * Lo que NO hace, y es el punto: no inventa la redacción del contrato. La prosa fija
 * —DEBER PRIMARIO, invariantes de protocolo, mecánicas de delegación— ya existe y está probada en
 * `contexto-fijo.ts` / `textoFijoDelSobre()`. Este módulo compone LO DEL ALIAS, que es lo que
 * alimenta la línea `Tu rol:` del preámbulo de identidad. Si embelleciera una coma de lo fijo, el
 * sello dejaría de coincidir, el sobre seguiría yendo entero y el ahorro sería cero.
 */

function perfil(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    tenant_id: "Steven",
    alias: "zeus",
    purpose: "Orquestar la flota y reparar Cauce de punta a punta.",
    role_summary: "Médico de la flota: diagnostica y repara los fallos de Cauce V3.",
    human_brief: "Su humano es Steven: sin tablas y como mucho diez líneas.",
    responsibilities: ["Diagnosticar fallos de entrega.", "Reparar sin esperar a un humano."],
    restrictions: ["Nunca tocar credenciales.", "No desplegar sin luz verde."],
    tools: ["cauce", "ssh a kratos"],
    operating_rules: ["Comprobar el efecto, nunca el nombre."],
    ...overrides,
  };
}

function hechos(overrides: Partial<HechosDelAlias> = {}): HechosDelAlias {
  return {
    permisos: { ruta: true, lectura: true, control: false, notificacion: true },
    destinos: ["kant", "argos"],
    cuotas: [{ proveedor: "claude", cuenta: "steven-max", limite: "5h/semanal" }],
    arnes: {
      harness: "claude", home: "/home/dev", contenedor: "claw-zeus",
      capacidades: ["messages.receive", "jobs.interactive"],
    },
    ...overrides,
  };
}

// ── Determinismo ─────────────────────────────────────────────────────────────────────────────

test("mismo perfil y mismos hechos producen EXACTAMENTE los mismos bytes", () => {
  const uno = componerBloqueDePerfil(perfil(), hechos());
  const dos = componerBloqueDePerfil(perfil(), hechos());
  assert.equal(uno, dos);
  assert.equal(resumirContextoFijo(uno), resumirContextoFijo(dos));
});

test("no mete fechas ni relojes: dos composiciones separadas en el tiempo son iguales", async () => {
  const antes = componerBloqueDePerfil(perfil(), hechos());
  await new Promise((listo) => setTimeout(listo, 25));
  assert.equal(componerBloqueDePerfil(perfil(), hechos()), antes);
  assert.doesNotMatch(antes, /20\d\d-\d\d-\d\d/);
});

/**
 * CONTROL NEGATIVO del determinismo: si el orden de las claves del objeto de entrada cambiara el
 * resultado, este test se pondría rojo. Se construyen los MISMOS hechos con las claves insertadas
 * al revés, que es lo que devolvería un `JSON.parse` de otra fuente.
 */
test("control negativo: el orden de inserción de las claves NO cambia el resultado", () => {
  const derecho = hechos();
  const alReves = {} as Record<string, unknown>;
  for (const clave of Object.keys(derecho).reverse()) {
    alReves[clave] = (derecho as unknown as Record<string, unknown>)[clave];
  }
  assert.equal(
    componerBloqueDePerfil(perfil(), alReves as unknown as HechosDelAlias),
    componerBloqueDePerfil(perfil(), derecho),
  );
});

test("control negativo: cambiar UNA coma cambia el sello", () => {
  const base = componerBloqueDePerfil(perfil(), hechos());
  const tocado = componerBloqueDePerfil(
    perfil({ purpose: "Orquestar la flota y reparar Cauce de punta a punta" }), hechos(),
  );
  assert.notEqual(base, tocado);
  assert.notEqual(resumirContextoFijo(base), resumirContextoFijo(tocado));
});

// ── Las siete caras ──────────────────────────────────────────────────────────────────────────

test("concentra las siete secciones cuando hay material para todas", () => {
  const texto = componerBloqueDePerfil(perfil(), hechos());
  for (const seccion of [
    "Identidad y propósito", "Rol, responsabilidades y restricciones",
    "Permisos y acceso vía Cauce", "Cuotas y límites",
    "Herramientas y capacidades", "Configuración del arnés",
    "Instrucciones fijas de funcionamiento",
  ]) {
    assert.ok(texto.includes(seccion), `falta la sección ${seccion}`);
  }
  assert.ok(texto.includes("Nunca tocar credenciales."));
  assert.ok(texto.includes("claw-zeus"));
  assert.ok(texto.includes("steven-max"));
});

/**
 * Un encabezado sin nada debajo le enseña al agente que el sistema no sabe la respuesta, que es
 * peor que no preguntar. Es la misma regla por la que el adaptador omite `Tu rol:` cuando el brief
 * es NULL, y la lección del SOUL.md de fábrica de `iza`.
 */
test("omite las secciones vacías en vez de emitir un encabezado hueco", () => {
  const texto = componerBloqueDePerfil(
    perfil({ purpose: null, tools: [], operating_rules: [] }),
    hechos({ cuotas: [], arnes: { harness: "claude", home: "/home/dev", capacidades: [] } }),
  );
  assert.ok(!texto.includes("Identidad y propósito"));
  assert.ok(!texto.includes("Cuotas y límites"));
  assert.ok(!texto.includes("Herramientas y capacidades"));
  assert.ok(!texto.includes("Instrucciones fijas de funcionamiento"));
  assert.ok(texto.includes("Rol, responsabilidades y restricciones"));
});

test("un perfil enteramente vacío produce texto vacío, no un esqueleto de encabezados", () => {
  const vacio: AgentProfile = {
    tenant_id: "Steven", alias: "mudo", purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
  };
  const texto = componerBloqueDePerfil(vacio, {
    permisos: { ruta: false, lectura: false, control: false, notificacion: false },
    destinos: [], cuotas: [],
    arnes: { harness: "codex", home: "/home/dev", capacidades: [] },
  });
  assert.equal(texto, "");
});

test("los permisos se dicen por su EFECTO, y los denegados también se nombran", () => {
  const texto = componerBloqueDePerfil(perfil(), hechos());
  assert.ok(texto.includes("control"), "un permiso denegado tiene que aparecer nombrado");
  assert.doesNotMatch(texto, /undefined|\[object Object\]/);
});

// ── El bloque gestionado: lo de fuera se conserva byte a byte ────────────────────────────────

const HUMANO_ANTES = "# CLAUDE.md de zeus\n\nEsto lo escribí yo a mano y no se toca.\n\n";
const HUMANO_DESPUES = "\n\n## Mis notas\n\nNi esto tampoco.\n";

test("respeta byte a byte el texto humano de ANTES y de DESPUÉS del bloque", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos());
  const sembrado = conBloqueGestionado(`${HUMANO_ANTES}${HUMANO_DESPUES}`, bloque);
  assert.ok(sembrado.startsWith(HUMANO_ANTES), "se perdió el texto humano de antes");
  assert.ok(sembrado.endsWith(HUMANO_DESPUES) || sembrado.includes(HUMANO_DESPUES.trim()));
  assert.equal(bloqueGestionado(sembrado), bloque.trim());
});

test("resembrar sobre un fichero ya sembrado no duplica el bloque ni toca lo humano", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos());
  const primera = conBloqueGestionado(`${HUMANO_ANTES}${HUMANO_DESPUES}`, bloque);
  const segunda = conBloqueGestionado(primera, bloque);
  assert.equal(segunda, primera, "resembrar el mismo bloque tiene que ser idempotente");
  assert.equal(segunda.split(MARCA_INICIO).length - 1, 1);
  assert.equal(segunda.split(MARCA_FIN).length - 1, 1);
  assert.ok(segunda.includes("Esto lo escribí yo a mano y no se toca."));
  assert.ok(segunda.includes("Ni esto tampoco."));
});

test("cambiar el perfil cambia SOLO el bloque; lo humano sigue igual byte a byte", () => {
  const antes = conBloqueGestionado(
    `${HUMANO_ANTES}${HUMANO_DESPUES}`, componerBloqueDePerfil(perfil(), hechos()),
  );
  const despues = conBloqueGestionado(
    antes, componerBloqueDePerfil(perfil({ purpose: "Otro propósito." }), hechos()),
  );
  assert.ok(despues.startsWith(HUMANO_ANTES));
  assert.ok(despues.includes("Ni esto tampoco."));
  assert.notEqual(bloqueGestionado(antes), bloqueGestionado(despues));
});

/** CONTROL NEGATIVO: sin este cuidado, sembrar sobre un fichero humano lo borraría. */
test("control negativo: sembrar sobre un fichero SIN marcas conserva todo lo que había", () => {
  const original = `${HUMANO_ANTES}texto suelto que nadie debe perder\n`;
  const sembrado = conBloqueGestionado(original, componerBloqueDePerfil(perfil(), hechos()));
  assert.ok(sembrado.includes("texto suelto que nadie debe perder"));
  assert.ok(sembrado.length > original.length);
});

// ── openclaw: proyección campo a campo, NUNCA el fichero entero ──────────────────────────────

test("la proyección de openclaw es sólo el subárbol del alias bajo agents", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos({ arnes: { harness: "openclaw", home: "/home/dev", capacidades: [] } }));
  const fragmento = JSON.parse(proyeccionOpenclaw("zeus", bloque)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fragmento), ["agents"]);
  const agents = fragmento["agents"] as Record<string, unknown>;
  assert.deepEqual(Object.keys(agents), ["zeus"]);
});

/**
 * CONTROL NEGATIVO, y el que de verdad importa: `openclaw.json` guarda `auth` y `secrets` junto a
 * la directiva. Si la proyección alguna vez pasara a emitir el documento entero, esto se pone
 * rojo. No se comprueba «no aparece la palabra auth» —eso lo pasaría un fichero entero que no la
 * use— sino que las ÚNICAS claves emitidas son las declaradas.
 */
test("control negativo: la proyección NUNCA emite auth ni secrets, vengan de donde vengan", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos({ arnes: { harness: "openclaw", home: "/home/dev", capacidades: [] } }));
  const texto = proyeccionOpenclaw("zeus", bloque);
  for (const prohibida of CLAVES_PROHIBIDAS_OPENCLAW) {
    assert.ok(!texto.includes(`"${prohibida}"`), `la proyección emitió ${prohibida}`);
  }
  const fragmento = JSON.parse(texto) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fragmento), ["agents"]);
});

test("la proyección de openclaw es determinista byte a byte", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos({ arnes: { harness: "openclaw", home: "/home/dev", capacidades: [] } }));
  assert.equal(proyeccionOpenclaw("zeus", bloque), proyeccionOpenclaw("zeus", bloque));
});

test("la proyección lleva el sello dentro, para poder comprobarla sin releer el perfil", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos({ arnes: { harness: "openclaw", home: "/home/dev", capacidades: [] } }));
  const fragmento = JSON.parse(proyeccionOpenclaw("zeus", bloque)) as {
    agents: Record<string, { cauce: { version: string; sha256: string } }>;
  };
  assert.equal(fragmento.agents["zeus"]?.cauce.sha256, resumirContextoFijo(bloque));
});

/** CONTROL NEGATIVO del serializador estable: `JSON.stringify` SÍ depende del orden. */
test("control negativo: serializarEstable ignora el orden de claves y JSON.stringify no", () => {
  const derecho = { b: 1, a: 2 };
  const alReves = { a: 2, b: 1 };
  assert.notEqual(JSON.stringify(derecho), JSON.stringify(alReves));
  assert.equal(serializarEstable(derecho), serializarEstable(alReves));
});

// ── El acoplamiento con el sobre, medido ─────────────────────────────────────────────────────

/**
 * LA RESTRICCIÓN DE INTEGRACIÓN, clavada en una prueba que puede dar rojo.
 *
 * El sello es el sha256 del texto fijo, y ese texto incluye la línea `Tu rol:` que sale de
 * `context.self_role`. Para que el sello del fichero coincida con el que calcula el adaptador, el
 * MISMO texto tiene que estar en los dos lados. Pero `self_role` del sobre está topado en
 * `ROLE_BRIEF_MAX_CODE_POINTS` (1.200 puntos de código) y el perfil admite 24.000 unidades: un
 * perfil rico NO CABE en el sobre, y si el fichero se compone con el perfil entero mientras el
 * sobre manda el `role_brief` corto, los dos sha NO COINCIDEN NUNCA y el recorte no se activa
 * jamás — el trabajo entero no ahorraría un solo carácter, y sin un solo error visible.
 *
 * Por eso el compilador declara el tope y esta prueba lo mide. Cuando la fase siguiente cablee el
 * perfil al sobre, o sube el tope de `self_role`, o el compilador recorta: lo que no puede es
 * descubrirse en producción.
 */
test("el rol compuesto declara si cabe en self_role, y lo dice midiendo", () => {
  const corto = componerBloqueDePerfil(perfil(), hechos());
  assert.ok(
    countCodePoints(corto) <= ROLE_BRIEF_MAX_CODE_POINTS,
    `un perfil típico deberia caber en self_role; mide ${countCodePoints(corto)}`,
  );
});

test("control negativo: un perfil que llena el presupuesto NO cabe en self_role", () => {
  const enorme = componerBloqueDePerfil(
    perfil({
      responsibilities: Array.from({ length: 20 }, (_, i) => `${"r".repeat(999)}${i}`),
    }),
    hechos(),
  );
  assert.ok(countCodePoints(enorme) > ROLE_BRIEF_MAX_CODE_POINTS);
  assert.ok(countCodePoints(enorme) <= AGENT_PROFILE_LIMITS.total + 4_000);
});

// ── DOS BLOQUES: A sellado (contrato) y B sin sellar (perfil) ────────────────────────────────

/**
 * LA RESOLUCIÓN DEL CHOQUE QUE ENCONTRÓ LA PRUEBA ANTERIOR.
 *
 * El sello cubre `textoFijoDelSobre()`, que incluye `Tu rol: <role_brief>` con el brief de
 * siempre (<=1.200 puntos de código). El perfil rico admite 24.000 unidades y NO cabe ahí. Meterlo
 * dentro del bloque sellado haría que los dos sha no coincidieran nunca y el recorte no se
 * activaría jamás, sin un solo error visible.
 *
 * Por eso son DOS bloques en el mismo fichero:
 *   A (sellado)   -> el contrato, entre MARCA_INICIO/MARCA_FIN. Es lo único que el sello resume y
 *                    lo único que el sobre deja de mandar.
 *   B (sin sellar)-> el perfil rico, entre MARCA_PERFIL_INICIO/MARCA_PERFIL_FIN. El arnés carga el
 *                    fichero ENTERO, así que el agente lo lee igual, y no cuesta nada por turno.
 *
 * Lo que estas pruebas fijan es que los dos bloques son INDEPENDIENTES: escribir uno no puede
 * tocar al otro, y —lo que de verdad importa— cambiar el perfil NO puede cambiar el sello de A.
 */

test("A y B conviven en el mismo fichero sin pisarse", () => {
  const contrato = "CONTRATO: el texto fijo del sobre, tal cual.";
  const bloqueB = componerBloqueDePerfil(perfil(), hechos());
  const conA = conBloqueGestionado(`${HUMANO_ANTES}${HUMANO_DESPUES}`, contrato);
  const conAyB = conBloqueDePerfil(conA, bloqueB);

  assert.equal(bloqueGestionado(conAyB), contrato, "el bloque A tiene que sobrevivir");
  assert.equal(bloqueDePerfil(conAyB), bloqueB.trim(), "el bloque B tiene que estar");
  assert.ok(conAyB.includes("Esto lo escribí yo a mano y no se toca."));
  assert.ok(conAyB.includes("Ni esto tampoco."));
});

/**
 * EL TEST QUE JUSTIFICA TODO EL DISEÑO. Si esto se pone rojo, el recorte del sobre deja de
 * funcionar en silencio: el sello del fichero dejaría de coincidir con el que calcula el
 * adaptador y se volvería a mandar el sobre entero en cada entrega, sin que nadie se entere.
 */
test("cambiar el PERFIL no cambia el sello del bloque sellado", () => {
  const contrato = "CONTRATO: el texto fijo del sobre, tal cual.";
  const conA = conBloqueGestionado("", contrato);
  const selloAntes = resumirContextoFijo(bloqueGestionado(conA) ?? "");

  const conB = conBloqueDePerfil(conA, componerBloqueDePerfil(perfil(), hechos()));
  const otroB = conBloqueDePerfil(
    conB, componerBloqueDePerfil(perfil({ purpose: "Un propósito completamente distinto." }), hechos()),
  );

  assert.equal(bloqueGestionado(otroB), contrato);
  assert.equal(resumirContextoFijo(bloqueGestionado(otroB) ?? ""), selloAntes);
});

/** CONTROL NEGATIVO simétrico: reescribir A no puede llevarse por delante el perfil. */
test("control negativo: resembrar el bloque A conserva el bloque B entero", () => {
  const bloqueB = componerBloqueDePerfil(perfil(), hechos());
  const partida = conBloqueDePerfil(conBloqueGestionado(HUMANO_ANTES, "CONTRATO v1"), bloqueB);
  const traAReescribirA = conBloqueGestionado(partida, "CONTRATO v2 con otra redacción");

  assert.equal(bloqueGestionado(traAReescribirA), "CONTRATO v2 con otra redacción");
  assert.equal(bloqueDePerfil(traAReescribirA), bloqueB.trim(), "el perfil se perdió al reescribir A");
  assert.ok(traAReescribirA.includes("Esto lo escribí yo a mano y no se toca."));
});

test("las marcas de A y las de B no se contienen entre sí", () => {
  for (const a of [MARCA_INICIO, MARCA_FIN]) {
    for (const b of [MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN]) {
      assert.ok(!a.includes(b) && !b.includes(a), `las marcas ${a} y ${b} se solapan`);
    }
  }
});

test("escribir el bloque B es idempotente", () => {
  const bloqueB = componerBloqueDePerfil(perfil(), hechos());
  const una = conBloqueDePerfil(HUMANO_ANTES, bloqueB);
  assert.equal(conBloqueDePerfil(una, bloqueB), una);
  assert.equal(una.split(MARCA_PERFIL_INICIO).length - 1, 1);
});

// ── El role_brief corto se DERIVA del perfil ─────────────────────────────────────────────────

/**
 * El perfil sigue siendo la única fuente de verdad: el `role_brief` que viaja en el sobre —y que
 * entra en el bloque sellado— se deriva de él y no se escribe aparte. Si se escribieran los dos a
 * mano, se desincronizarían, que es el problema que esta tabla vino a resolver.
 */
test("rolBreveDelPerfil sale del role_summary y NUNCA pasa el tope del sobre", () => {
  assert.equal(rolBreveDelPerfil(perfil()), perfil().role_summary);
  const largo = perfil({ role_summary: "a".repeat(AGENT_PROFILE_LIMITS.role_summary) });
  assert.ok(countCodePoints(rolBreveDelPerfil(largo) ?? "") <= ROLE_BRIEF_MAX_CODE_POINTS);
});

test("un perfil sin rol declarado da null, para que el sobre omita la línea 'Tu rol:'", () => {
  assert.equal(rolBreveDelPerfil(perfil({ role_summary: null })), null);
});

/**
 * CONTROL NEGATIVO del recorte: `slice(0,1200)` indexa unidades UTF-16 y partiría un emoji por la
 * mitad, dejando un surrogate suelto que viaja como U+FFFD — el agente recibiría su propio rol
 * terminado en un carácter roto. Se recorta por puntos de código.
 */
test("control negativo: recortar no parte nunca un par suplente", () => {
  const conEmojis = perfil({ role_summary: "\u{1F389}".repeat(ROLE_BRIEF_MAX_CODE_POINTS) });
  const breve = rolBreveDelPerfil(conEmojis) ?? "";
  assert.ok(countCodePoints(breve) <= ROLE_BRIEF_MAX_CODE_POINTS);
  assert.ok(!breve.includes("�"), "quedó un surrogate suelto");
  assert.equal([...breve].every((c) => c === "\u{1F389}"), true);
});
