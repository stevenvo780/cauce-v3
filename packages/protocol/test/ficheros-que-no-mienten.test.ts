import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, ContextoDeAlias, HechosDelAlias } from "../src/agent-profile.js";
import { bloqueDePerfil, conBloqueDePerfil, sinBloqueDePerfil } from "../src/marcas-de-bloque.js";
import {
  ErrorDeTopeDelArnes, TOPES_OPENCLAW, ficherosDelArnes, type FicheroGenerado,
} from "../src/ficheros-del-arnes.js";

// Tests de verificación de consistencia en generación y actualización de ficheros de arnés.

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
  return { perfil: p, hechos: { ...HECHOS, ...hechos } };
}

function de(ficheros: readonly FicheroGenerado[], nombre: string): FicheroGenerado {
  const f = ficheros.find((x) => x.nombre === nombre);
  assert.ok(f, `no vino ${nombre}`);
  return f;
}

// ── 1. Retiro de bloques desactualizados ─────────────────────────────────────

test("borrar un campo en la base BORRA el bloque del fichero, no lo deja rancio", () => {
  const conPerfil = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "reparo Cauce" })));
  const soul = de(conPerfil, "SOUL.md");
  assert.ok(soul.texto.includes("reparo Cauce"));

  // Se vacía purpose y se vuelve a generar sobre el contenido existente.
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
  const manual = "# Notas\n\nsólo texto humano\n";
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})), new Map([["SOUL.md", manual]]));
  assert.equal(de(generado, "SOUL.md").escribir, false);
  assert.equal(de(generado, "SOUL.md").texto, manual);
});

// ── 2. MEMORY.md en el cálculo de topes ──────────────────────────────────────

test("la memoria del agente NO cuenta para el tope: no puede bloquear la siembra de los siete", () => {
  const memoriaEnorme = "recuerdo. ".repeat(20_000); // ~200.000 unidades
  const enDisco = new Map([["MEMORY.md", memoriaEnorme]]);
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "reparo Cauce" })), enDisco);

  assert.equal(de(generado, "SOUL.md").escribir, true, "la memoria del agente bloqueó su identidad");
  assert.equal(de(generado, "MEMORY.md").texto, memoriaEnorme, "le tocamos la memoria");
  assert.equal(de(generado, "MEMORY.md").escribir, false);
});

test("CONTROL NEGATIVO: lo que SÍ escribimos sigue sujeto al tope", () => {
  assert.throws(
    () => ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(TOPES_OPENCLAW.porFichero + 1) }))),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes && error.fichero === "SOUL.md",
  );
});

// ── 3. Guarda de pertenencia de bloque ───────────────────────────────────────

test("no se pisa el bloque de OTRO alias: aliases con home compartido", () => {
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
  const primero = ficherosDelArnes("codex", contexto(perfil({ purpose: "antes" }, "kratos")));
  const enDisco = new Map([["AGENTS.md", de(primero, "AGENTS.md").texto]]);
  const segundo = ficherosDelArnes("codex", contexto(perfil({ purpose: "después" }, "kratos")), enDisco);

  assert.equal(de(segundo, "AGENTS.md").escribir, true);
  assert.ok(de(segundo, "AGENTS.md").texto.includes("después"));
});

test("un perfil vacío de OTRO alias no retira el bloque administrado del dueño", () => {
  const deKratos = ficherosDelArnes(
    "codex", contexto(perfil({ purpose: "soy kratos" }, "kratos")),
  );
  const antes = de(deKratos, "AGENTS.md").texto;
  const enDisco = new Map([["AGENTS.md", antes]]);

  const atlasVacio = de(
    ficherosDelArnes("codex", contexto(perfil({}, "atlas")), enDisco),
    "AGENTS.md",
  );
  assert.equal(atlasVacio.escribir, false, "atlas intentó retirar el bloque de kratos");
  assert.equal(atlasVacio.texto, antes);
  assert.ok(atlasVacio.texto.includes("soy kratos"));

  const kratosVacio = de(
    ficherosDelArnes("codex", contexto(perfil({}, "kratos")), enDisco),
    "AGENTS.md",
  );
  assert.equal(kratosVacio.escribir, true, "el dueño no pudo retirar su bloque");
  assert.equal(bloqueDePerfil(kratosVacio.texto), undefined);
});

test("CONTROL NEGATIVO: dos alias del MISMO nombre en inquilinos distintos no se confunden", () => {
  const dePablo = ficherosDelArnes("codex", contexto({
    ...perfil({ purpose: "el argos de Pablo" }, "argos"), tenant_id: "Pablo",
  }));
  const enDisco = new Map([["AGENTS.md", de(dePablo, "AGENTS.md").texto]]);
  const deSteven = ficherosDelArnes("codex", contexto(perfil({ purpose: "el argos de Steven" }, "argos")), enDisco);
  assert.equal(de(deSteven, "AGENTS.md").escribir, false);
});

// ── 4. Generación sin campos autorados ───────────────────────────────────────

test("un perfil SIN NADA autorado no escribe ningún fichero, tampoco en openclaw", () => {
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})));
  for (const fichero of generado.filter((f) => f.politica === "bloque-gestionado")) {
    assert.equal(fichero.escribir, false, `${fichero.nombre} se iba a escribir sin nada autorado`);
    assert.equal(fichero.texto, "", `${fichero.nombre} lleva texto`);
  }
});

test("los ficheros del agente SÍ se crean vacíos cuando faltan, y eso no es lo mismo", () => {
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

test("CONTROL NEGATIVO: con UNA responsabilidad, AGENTS.md sólo lleva reglas autoradas", () => {
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ responsibilities: ["reparar Cauce"] })));
  const agents = de(generado, "AGENTS.md");
  assert.equal(agents.escribir, true);
  assert.ok(agents.texto.includes("reparar Cauce"));
  assert.ok(!agents.texto.includes("control): no"), "congeló permisos dinámicos");
  assert.ok(!agents.texto.includes("ws-argos"), "congeló el montaje dinámico");
});

test("CONTROL NEGATIVO: sin herramientas declaradas TOOLS.md no se escribe, con una sí", () => {
  const sin = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "algo" })));
  assert.equal(de(sin, "TOOLS.md").escribir, false);

  const con = ficherosDelArnes("openclaw", contexto(perfil({ tools: ["ssh"] })));
  const tools = de(con, "TOOLS.md");
  assert.equal(tools.escribir, true);
  assert.ok(tools.texto.includes("ssh"));
  assert.ok(!tools.texto.includes("saldantia"), "congeló las cuotas dinámicas");
});

// ── 5. Medición de topes sobre texto consolidado ─────────────────────────────

test("el tope se mide sobre el fichero ENTERO, no sólo sobre nuestro bloque", () => {
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
