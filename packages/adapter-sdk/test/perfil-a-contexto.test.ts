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
 * THE CONTEXT COMPILER: profile + harness facts -> the file text.
 *
 * What it does NOT do, and that is the point: it does not invent the wording of the contract.
 * The fixed prose —PRIMARY DUTY, protocol invariants, delegation mechanics— is tested in
 * `contexto-fijo.ts` / `textoFijoDelSobre()`; this module composes THE ALIAS'S PART, which feeds
 * the `Tu rol:` line of the identity preamble. If it prettified a single comma, the seal would stop
 * matching, the envelope would still travel whole, and the savings would be zero.
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

// ── Determinism ────────────────────────────────────────────────────────────────────────────────

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
 * NEGATIVE CONTROL of determinism: if the order of the keys of the input object changed the
 * result, this test would turn red. The SAME facts are built with the keys inserted backwards,
 * which is what a `JSON.parse` from another source would return.
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

// ── The seven faces ────────────────────────────────────────────────────────────────────────────

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
 * A header with nothing under it tells the agent the system does not know the answer, which is
 * worse than not asking. It is the same rule by which the adapter omits `Tu rol:` when the brief
 * is NULL, and the lesson from the factory SOUL.md of `iza`.
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

// ── The managed block: outside content is preserved byte for byte ──────────────────────────────

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

/** NEGATIVE CONTROL: without this care, seeding over a human file would wipe it. */
test("control negativo: sembrar sobre un fichero SIN marcas conserva todo lo que había", () => {
  const original = `${HUMANO_ANTES}texto suelto que nadie debe perder\n`;
  const sembrado = conBloqueGestionado(original, componerBloqueDePerfil(perfil(), hechos()));
  assert.ok(sembrado.includes("texto suelto que nadie debe perder"));
  assert.ok(sembrado.length > original.length);
});

// ── openclaw: field-by-field projection, NEVER the whole file ─────────────────────────────────

test("la proyección de openclaw es sólo el subárbol del alias bajo agents", () => {
  const bloque = componerBloqueDePerfil(perfil(), hechos({ arnes: { harness: "openclaw", home: "/home/dev", capacidades: [] } }));
  const fragmento = JSON.parse(proyeccionOpenclaw("zeus", bloque)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fragmento), ["agents"]);
  const agents = fragmento.agents as Record<string, unknown>;
  assert.deepEqual(Object.keys(agents), ["zeus"]);
});

/**
 * NEGATIVE CONTROL, and the one that truly matters: `openclaw.json` stores `auth` and `secrets`
 * alongside the directive. If the projection ever started emitting the whole document, this
 * turns red. We do not check "the word auth does not appear" —a whole file that does not use it
 * would pass that— but that the ONLY keys emitted are the declared ones.
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
  assert.equal(fragmento.agents.zeus?.cauce.sha256, resumirContextoFijo(bloque));
});

/** NEGATIVE CONTROL of the stable serializer: `JSON.stringify` DOES depend on order. */
test("control negativo: serializarEstable ignora el orden de claves y JSON.stringify no", () => {
  const derecho = { b: 1, a: 2 };
  const alReves = { a: 2, b: 1 };
  assert.notEqual(JSON.stringify(derecho), JSON.stringify(alReves));
  assert.equal(serializarEstable(derecho), serializarEstable(alReves));
});

// ── The coupling with the envelope, measured ───────────────────────────────────────────────────

/**
 * THE INTEGRATION CONSTRAINT, nailed down in a test that can turn red.
 *
 * The seal is the sha256 of the fixed text, and that text includes the `Tu rol:` line that comes
 * from `context.self_role`. For the file's seal to match the one the adapter computes, the SAME
 * text has to be on both sides. But the envelope's `self_role` is capped at
 * `ROLE_BRIEF_MAX_CODE_POINTS` (1,200 code points) and the profile allows 24,000 units: a rich
 * profile DOES NOT FIT in the envelope, and if the file is composed with the whole profile while
 * the envelope sends the short `role_brief`, the two sha NEVER MATCH and the trimming never kicks
 * in — the whole payload would not save a single character, and without a single visible error.
 *
 * That is why the compiler declares the cap and this test measures it. When the next phase wires
 * the profile into the envelope, either the cap of `self_role` is raised, or the compiler trims:
 * what it cannot do is be discovered in production.
 */
test("el rol compuesto declara si cabe en self_role, y lo dice midiendo", () => {
  const corto = componerBloqueDePerfil(perfil(), hechos());
  assert.ok(
    countCodePoints(corto) <= ROLE_BRIEF_MAX_CODE_POINTS,
    `un perfil típico deberia caber en self_role; mide ${String(countCodePoints(corto))}`,
  );
});

test("control negativo: un perfil que llena el presupuesto NO cabe en self_role", () => {
  const enorme = componerBloqueDePerfil(
    perfil({
      responsibilities: Array.from({ length: 20 }, (_, i) => `${"r".repeat(999)}${String(i)}`),
    }),
    hechos(),
  );
  assert.ok(countCodePoints(enorme) > ROLE_BRIEF_MAX_CODE_POINTS);
  assert.ok(countCodePoints(enorme) <= AGENT_PROFILE_LIMITS.total + 4_000);
});

// ── TWO BLOCKS: A sealed (contract) and B unsealed (profile) ──────────────────────────────────

/**
 * THE RESOLUTION OF THE CLASH THAT THE PREVIOUS TEST FOUND.
 *
 * The seal covers `textoFijoDelSobre()`, which includes `Tu rol: <role_brief>` with the always
 * short brief (<=1,200 code points). The rich profile allows 24,000 units and DOES NOT fit there.
 * Putting it inside the sealed block would make the two sha never match and the trimming never
 * kick in, without a single visible error.
 *
 * That is why they are TWO blocks in the same file: A (sealed) is the contract between
 * MARCA_INICIO/MARCA_FIN, the only thing the seal summarizes and the only thing the envelope stops
 * sending; B (unsealed) is the rich profile between MARCA_PERFIL_INICIO/MARCA_PERFIL_FIN. The
 * harness loads the WHOLE file, so the agent reads it the same, and it costs nothing per turn.
 *
 * What these tests nail down is that the two blocks are INDEPENDENT: writing one must not touch
 * the other, and —what truly matters— changing the profile MUST NOT change A's seal.
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
 * THE TEST THAT JUSTIFIES THE WHOLE DESIGN. If this turns red, the envelope trimming silently
 * stops working: the file's seal would stop matching the one the adapter computes and the whole
 * envelope would be sent again on every delivery, without anyone noticing.
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

/** Symmetric NEGATIVE CONTROL: rewriting A must not take the profile down with it. */
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

// ── The short role_brief is DERIVED from the profile ──────────────────────────────────────────

/**
 * The profile remains the single source of truth: the `role_brief` that travels in the envelope
 * —and that enters the sealed block— is derived from it and is not written separately. If both
 * were written by hand, they would desync, which is the problem this table came to solve.
 */
test("rolBreveDelPerfil sale del role_summary y NUNCA pasa el tope del sobre", () => {
  assert.equal(rolBreveDelPerfil(perfil()), perfil().role_summary);
  const largo = perfil({ role_summary: "a".repeat(AGENT_PROFILE_LIMITS.role_summary) });
  assert.ok(countCodePoints(rolBreveDelPerfil(largo) ?? "") <= ROLE_BRIEF_MAX_CODE_POINTS);
});

test("un perfil sin rol declarado da null, para que el sobre omita la línea 'Tu rol:'", () => {
  assert.equal(rolBreveDelPerfil(perfil({ role_summary: null })), null);
  assert.equal(rolBreveDelPerfil(perfil({ role_summary: "   \n\t" })), null);
});

test("la proyección recorta espacios igual que la migración y el claim del store", () => {
  assert.equal(
    rolBreveDelPerfil(perfil({ role_summary: "  rol canónico  \n" })),
    "rol canónico",
  );
});

/**
 * NEGATIVE CONTROL of the trimming: `slice(0,1200)` indexes UTF-16 units and would split an
 * emoji in half, leaving a lone surrogate that travels as U+FFFD — the agent would receive its
 * own role ending in a broken character. Trimming is done by code points.
 */
test("control negativo: recortar no parte nunca un par suplente", () => {
  const conEmojis = perfil({ role_summary: "\u{1F389}".repeat(ROLE_BRIEF_MAX_CODE_POINTS) });
  const breve = rolBreveDelPerfil(conEmojis) ?? "";
  assert.ok(countCodePoints(breve) <= ROLE_BRIEF_MAX_CODE_POINTS);
  assert.ok(!breve.includes("�"), "quedó un surrogate suelto");
  assert.equal([...breve].every((c) => c === "\u{1F389}"), true);
});
