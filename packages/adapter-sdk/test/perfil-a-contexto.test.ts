import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROFILE_LIMITS, ROLE_BRIEF_MAX_CODE_POINTS, countCodePoints, type AgentProfile,
} from "@cauce/protocol";
import {
  MARCA_FIN, MARCA_INICIO, bloqueGestionado, conBloqueGestionado, resumirContextoFijo,
} from "../src/harnesses/contexto-fijo.js";
import {
  CLAVES_PROHIBIDAS_OPENCLAW, componerRolDelPerfil, proyeccionOpenclaw, serializarEstable,
  type HechosDelArnes,
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
    responsibilities: ["Diagnosticar fallos de entrega.", "Reparar sin esperar a un humano."],
    restrictions: ["Nunca tocar credenciales.", "No desplegar sin luz verde."],
    tools: ["cauce", "ssh a kratos"],
    operating_rules: ["Comprobar el efecto, nunca el nombre."],
    ...overrides,
  };
}

function hechos(overrides: Partial<HechosDelArnes> = {}): HechosDelArnes {
  return {
    harness: "claude",
    home: "/home/dev",
    permisos: { ruta: true, lectura: true, control: false, notificacion: true },
    destinos: ["kant", "argos"],
    cuotas: [{ proveedor: "claude", cuenta: "steven-max", limite: "5h/semanal" }],
    capacidades: ["messages.receive", "jobs.interactive"],
    contenedor: "claw-zeus",
    ...overrides,
  };
}

// ── Determinismo ─────────────────────────────────────────────────────────────────────────────

test("mismo perfil y mismos hechos producen EXACTAMENTE los mismos bytes", () => {
  const uno = componerRolDelPerfil(perfil(), hechos());
  const dos = componerRolDelPerfil(perfil(), hechos());
  assert.equal(uno, dos);
  assert.equal(resumirContextoFijo(uno), resumirContextoFijo(dos));
});

test("no mete fechas ni relojes: dos composiciones separadas en el tiempo son iguales", async () => {
  const antes = componerRolDelPerfil(perfil(), hechos());
  await new Promise((listo) => setTimeout(listo, 25));
  assert.equal(componerRolDelPerfil(perfil(), hechos()), antes);
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
    componerRolDelPerfil(perfil(), alReves as unknown as HechosDelArnes),
    componerRolDelPerfil(perfil(), derecho),
  );
});

test("control negativo: cambiar UNA coma cambia el sello", () => {
  const base = componerRolDelPerfil(perfil(), hechos());
  const tocado = componerRolDelPerfil(
    perfil({ purpose: "Orquestar la flota y reparar Cauce de punta a punta" }), hechos(),
  );
  assert.notEqual(base, tocado);
  assert.notEqual(resumirContextoFijo(base), resumirContextoFijo(tocado));
});

// ── Las siete caras ──────────────────────────────────────────────────────────────────────────

test("concentra las siete secciones cuando hay material para todas", () => {
  const texto = componerRolDelPerfil(perfil(), hechos());
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
  const texto = componerRolDelPerfil(
    perfil({ purpose: null, tools: [], operating_rules: [] }),
    hechos({ cuotas: [], capacidades: [] }),
  );
  assert.ok(!texto.includes("Identidad y propósito"));
  assert.ok(!texto.includes("Cuotas y límites"));
  assert.ok(!texto.includes("Herramientas y capacidades"));
  assert.ok(!texto.includes("Instrucciones fijas de funcionamiento"));
  assert.ok(texto.includes("Rol, responsabilidades y restricciones"));
});

test("un perfil enteramente vacío produce texto vacío, no un esqueleto de encabezados", () => {
  const vacio: AgentProfile = {
    tenant_id: "Steven", alias: "mudo", purpose: null, role_summary: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
  };
  const texto = componerRolDelPerfil(vacio, {
    harness: "codex", home: "/home/dev",
    permisos: { ruta: false, lectura: false, control: false, notificacion: false },
    destinos: [], cuotas: [], capacidades: [], contenedor: undefined,
  });
  assert.equal(texto, "");
});

test("los permisos se dicen por su EFECTO, y los denegados también se nombran", () => {
  const texto = componerRolDelPerfil(perfil(), hechos());
  assert.ok(texto.includes("control"), "un permiso denegado tiene que aparecer nombrado");
  assert.doesNotMatch(texto, /undefined|\[object Object\]/);
});

// ── El bloque gestionado: lo de fuera se conserva byte a byte ────────────────────────────────

const HUMANO_ANTES = "# CLAUDE.md de zeus\n\nEsto lo escribí yo a mano y no se toca.\n\n";
const HUMANO_DESPUES = "\n\n## Mis notas\n\nNi esto tampoco.\n";

test("respeta byte a byte el texto humano de ANTES y de DESPUÉS del bloque", () => {
  const bloque = componerRolDelPerfil(perfil(), hechos());
  const sembrado = conBloqueGestionado(`${HUMANO_ANTES}${HUMANO_DESPUES}`, bloque);
  assert.ok(sembrado.startsWith(HUMANO_ANTES), "se perdió el texto humano de antes");
  assert.ok(sembrado.endsWith(HUMANO_DESPUES) || sembrado.includes(HUMANO_DESPUES.trim()));
  assert.equal(bloqueGestionado(sembrado), bloque.trim());
});

test("resembrar sobre un fichero ya sembrado no duplica el bloque ni toca lo humano", () => {
  const bloque = componerRolDelPerfil(perfil(), hechos());
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
    `${HUMANO_ANTES}${HUMANO_DESPUES}`, componerRolDelPerfil(perfil(), hechos()),
  );
  const despues = conBloqueGestionado(
    antes, componerRolDelPerfil(perfil({ purpose: "Otro propósito." }), hechos()),
  );
  assert.ok(despues.startsWith(HUMANO_ANTES));
  assert.ok(despues.includes("Ni esto tampoco."));
  assert.notEqual(bloqueGestionado(antes), bloqueGestionado(despues));
});

/** CONTROL NEGATIVO: sin este cuidado, sembrar sobre un fichero humano lo borraría. */
test("control negativo: sembrar sobre un fichero SIN marcas conserva todo lo que había", () => {
  const original = `${HUMANO_ANTES}texto suelto que nadie debe perder\n`;
  const sembrado = conBloqueGestionado(original, componerRolDelPerfil(perfil(), hechos()));
  assert.ok(sembrado.includes("texto suelto que nadie debe perder"));
  assert.ok(sembrado.length > original.length);
});

// ── openclaw: proyección campo a campo, NUNCA el fichero entero ──────────────────────────────

test("la proyección de openclaw es sólo el subárbol del alias bajo agents", () => {
  const bloque = componerRolDelPerfil(perfil(), hechos({ harness: "openclaw" }));
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
  const bloque = componerRolDelPerfil(perfil(), hechos({ harness: "openclaw" }));
  const texto = proyeccionOpenclaw("zeus", bloque);
  for (const prohibida of CLAVES_PROHIBIDAS_OPENCLAW) {
    assert.ok(!texto.includes(`"${prohibida}"`), `la proyección emitió ${prohibida}`);
  }
  const fragmento = JSON.parse(texto) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fragmento), ["agents"]);
});

test("la proyección de openclaw es determinista byte a byte", () => {
  const bloque = componerRolDelPerfil(perfil(), hechos({ harness: "openclaw" }));
  assert.equal(proyeccionOpenclaw("zeus", bloque), proyeccionOpenclaw("zeus", bloque));
});

test("la proyección lleva el sello dentro, para poder comprobarla sin releer el perfil", () => {
  const bloque = componerRolDelPerfil(perfil(), hechos({ harness: "openclaw" }));
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
  const corto = componerRolDelPerfil(perfil(), hechos());
  assert.ok(
    countCodePoints(corto) <= ROLE_BRIEF_MAX_CODE_POINTS,
    `un perfil típico deberia caber en self_role; mide ${countCodePoints(corto)}`,
  );
});

test("control negativo: un perfil que llena el presupuesto NO cabe en self_role", () => {
  const enorme = componerRolDelPerfil(
    perfil({
      responsibilities: Array.from({ length: 20 }, (_, i) => `${"r".repeat(999)}${i}`),
    }),
    hechos(),
  );
  assert.ok(countCodePoints(enorme) > ROLE_BRIEF_MAX_CODE_POINTS);
  assert.ok(countCodePoints(enorme) <= AGENT_PROFILE_LIMITS.total + 4_000);
});
