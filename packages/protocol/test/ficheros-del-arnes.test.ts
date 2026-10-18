import assert from "node:assert/strict";
import { test } from "vitest";
import {
  measureStrictestUnits, type AgentProfile, type HechosDelAlias,
} from "../src/agent-profile.js";
import {
  MARCA_FIN, MARCA_INICIO, MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO,
} from "../src/marcas-de-bloque.js";
import {
  ErrorDeTopeDelArnes, FICHEROS_OPENCLAW, PREFIJO_REVISION_PERFIL,
  PRESUPUESTOS_DE_CONTEXTO, TOPES_OPENCLAW, ficherosDelArnes,
  harnessDocumentPaths, marcaDeRevisionDelPerfil, nombresDelArnes, revisionDelPerfil,
  verifyManagedContextEdit, type FicheroGenerado,
} from "../src/ficheros-del-arnes.js";

// Tests for the per-harness file generator.

function perfil(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    tenant_id: "Steven",
    alias: "zeus",
    purpose: "PROPOSITO-SOUL: existe para sostener la flota en pie.",
    role_summary: "ROL-IDENTITY: médico de la flota.",
    human_brief: "HUMANO-USER: Steven. Sin tablas, máximo diez líneas.",
    responsibilities: ["RESPONSABILIDAD-AGENTS: diagnosticar entregas muertas."],
    restrictions: ["RESTRICCION-AGENTS: nunca tocar credenciales."],
    tools: ["HERRAMIENTA-TOOLS: cauce"],
    operating_rules: ["REGLA-AGENTS: comprobar el efecto, nunca el nombre."],
    ...overrides,
  };
}

function hechos(overrides: Partial<HechosDelAlias> = {}): HechosDelAlias {
  return {
    permisos: { ruta: true, lectura: true, control: false, notificacion: true },
    destinos: ["kant", "argos"],
    cuotas: [{ proveedor: "claude", cuenta: "CUOTA-TOOLS-steven", limite: "40% en la ventana semanal" }],
    arnes: {
      harness: "openclaw", home: "/home/claw", contenedor: "claw-zeus",
      capacidades: ["CAPACIDAD-TOOLS-artifacts"],
    },
    ...overrides,
  };
}

/** The text of a plan file, by name. Fails if the generator did not emit it. */
function textoDe(ficheros: readonly { nombre: string; texto: string }[], nombre: string): string {
  const encontrado = ficheros.find((fichero) => fichero.nombre === nombre);
  assert.ok(encontrado, `el generador no emitió ${nombre}`);
  return encontrado.texto;
}

// ── THE CAST ──────────────────────────────────────────────────────────────────────────────────

test("claude recibe UN solo CLAUDE.md, y codex UN solo AGENTS.md", () => {
  const deClaude = ficherosDelArnes("claude", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(deClaude.map((f: FicheroGenerado) => f.nombre), ["CLAUDE.md"]);

  const deCodex = ficherosDelArnes("codex", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(deCodex.map((f: FicheroGenerado) => f.nombre), ["AGENTS.md"]);
});

test("openclaw recibe los SIETE ficheros medidos, con esos nombres exactos", () => {
  const ficheros = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(
    ficheros.map((f: FicheroGenerado) => f.nombre),
    ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "TOOLS.md"],
  );
  // The exported list and what is emitted are the SAME thing: a test against a copy of itself
  // would stay green the day the generator stopped emitting one.
  assert.deepEqual(ficheros.map((f: FicheroGenerado) => f.nombre), [...FICHEROS_OPENCLAW]);
  assert.deepEqual(nombresDelArnes("openclaw"), [...FICHEROS_OPENCLAW]);
});

test("cada cara del perfil cae en SU fichero y NO en los demás", () => {
  const ficheros = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });

  // Each marker appears in the file that owns it...
  assert.match(textoDe(ficheros, "SOUL.md"), /PROPOSITO-SOUL/);
  assert.match(textoDe(ficheros, "IDENTITY.md"), /ROL-IDENTITY/);
  assert.match(textoDe(ficheros, "USER.md"), /HUMANO-USER/);
  assert.match(textoDe(ficheros, "AGENTS.md"), /RESPONSABILIDAD-AGENTS/);
  assert.match(textoDe(ficheros, "AGENTS.md"), /RESTRICCION-AGENTS/);
  assert.match(textoDe(ficheros, "AGENTS.md"), /REGLA-AGENTS/);
  assert.match(textoDe(ficheros, "TOOLS.md"), /HERRAMIENTA-TOOLS/);
  assert.doesNotMatch(textoDe(ficheros, "TOOLS.md"), /CAPACIDAD-TOOLS|CUOTA-TOOLS/);

  // ...and in NO other one. This is the control that makes the test able to fail: without it, a
  // generator that wrote the whole profile in the seven files would pass the assertions above.
  const marcadores: readonly (readonly [string, RegExp])[] = [
    ["SOUL.md", /PROPOSITO-SOUL/], ["IDENTITY.md", /ROL-IDENTITY/], ["USER.md", /HUMANO-USER/],
    ["AGENTS.md", /RESPONSABILIDAD-AGENTS/], ["TOOLS.md", /HERRAMIENTA-TOOLS/],
  ];
  for (const [duenno, marcador] of marcadores) {
    for (const fichero of ficheros) {
      if (fichero.nombre === duenno) continue;
      assert.doesNotMatch(
        fichero.texto, marcador,
        `${String(marcador)} se coló en ${fichero.nombre}; sólo pertenece a ${duenno}`,
      );
    }
  }
});

// ── THE MANAGED BLOCK: what a person wrote survives ──────────────────────────────────────────

test("lo que escribió una persona sobrevive byte a byte, antes y después del bloque", () => {
  const humano = "# Mi SOUL a mano\n\nesto lo escribí yo\n";
  const cola = "\n\ny esto también es mío\n";
  const ficheros = ficherosDelArnes(
    "openclaw", { perfil: perfil(), hechos: hechos() },
    new Map([["SOUL.md", `${humano}${cola}`]]),
  );
  const soul = textoDe(ficheros, "SOUL.md");
  assert.ok(soul.includes(humano), "se perdió el texto humano del principio");
  assert.ok(soul.includes(cola.trim()), "se perdió el texto humano del final");
  assert.match(soul, /PROPOSITO-SOUL/);
});

test("el editor manual sólo puede cambiar bytes fuera de los bloques gestionados", () => {
  const current = [
    "# Manual anterior",
    MARCA_INICIO,
    "contrato sellado",
    MARCA_FIN,
    marcaDeRevisionDelPerfil(7),
    MARCA_PERFIL_INICIO,
    "perfil proyectado",
    MARCA_PERFIL_FIN,
    "cola anterior",
    "",
  ].join("\n");
  const proposed = current
    .replace("# Manual anterior", "# Manual nuevo")
    .replace("cola anterior", "cola nueva");

  assert.deepEqual(verifyManagedContextEdit(current, proposed), { allowed: true });
});

test("el editor manual rechaza cambios byte a byte en contexto, perfil y revisión", () => {
  const current = [
    MARCA_INICIO,
    "contrato sellado",
    MARCA_FIN,
    marcaDeRevisionDelPerfil(7),
    MARCA_PERFIL_INICIO,
    "perfil proyectado",
    MARCA_PERFIL_FIN,
    "",
  ].join("\n");
  const cases = [
    ["contrato sellado", "contrato alterado", "managed_fixed_context_changed"],
    ["perfil proyectado", "perfil alterado", "managed_profile_changed"],
    [marcaDeRevisionDelPerfil(7), marcaDeRevisionDelPerfil(8), "managed_profile_revision_changed"],
  ] as const;

  for (const [from, to, conflict] of cases) {
    assert.deepEqual(
      verifyManagedContextEdit(current, current.replace(from, to)),
      { allowed: false, conflict },
    );
  }
});

// ── THE OPENCLAW CAPS ─────────────────────────────────────────────────────────────────────────

test("un fichero que pasa de 60.000 da error CLARO, y no un fichero truncado", () => {
  const enorme = "x".repeat(TOPES_OPENCLAW.porFichero + 1);
  assert.throws(
    () => ficherosDelArnes("openclaw", {
      perfil: perfil({ purpose: enorme }), hechos: hechos(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTopeDelArnes, "el error tiene que ser identificable");
      // The file by name, and the two numbers: without them the operator does not know how much to trim.
      assert.equal(error.fichero, "SOUL.md");
      assert.equal(error.tope, TOPES_OPENCLAW.porFichero);
      assert.ok(error.medido > TOPES_OPENCLAW.porFichero);
      assert.match(error.message, /SOUL\.md/);
      return true;
    },
  );
});

test("el TOTAL que pasa del tope da error, aunque NINGÚN fichero pase por su cuenta", () => {
  // Each field fits comfortably in its file; what does not fit is the sum. Without the total cap
  // this would pass, and openclaw would stop loading the whole person without saying why.
  const grande = "y".repeat(Math.floor(TOPES_OPENCLAW.porFichero * 0.8));
  assert.throws(
    () => ficherosDelArnes("openclaw", {
      perfil: perfil({ purpose: grande, role_summary: grande, human_brief: grande }),
      hechos: hechos(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTopeDelArnes);
      assert.equal(error.fichero, "total");
      assert.equal(error.tope, TOPES_OPENCLAW.total);
      assert.ok(error.medido > TOPES_OPENCLAW.total);
      return true;
    },
  );
});

test("codex se mide en BYTES UTF-8, y el hecho medido por alias manda sobre el defecto", () => {
  const acentos = "á".repeat(20_000);
  assert.equal(measureStrictestUnits(acentos), 20_000);
  assert.equal(Buffer.byteLength(acentos, "utf8"), 40_000);
  assert.equal(PRESUPUESTOS_DE_CONTEXTO.codex.unit, "utf8_bytes");
  assert.equal(PRESUPUESTOS_DE_CONTEXTO.codex.porFichero, 32 * 1_024);

  const contexto = { perfil: perfil({ purpose: acentos }), hechos: hechos() };
  assert.throws(() => ficherosDelArnes("codex", contexto), ErrorDeTopeDelArnes);
  assert.doesNotThrow(() => ficherosDelArnes("codex", contexto, new Map(), {
    topes: { unit: "utf8_bytes", porFichero: 64 * 1_024 },
  }));
});

test("las rutas de gobierno salen de UNA tabla; un hecho declarado no canónico falla cerrado", () => {
  assert.deepEqual(harnessDocumentPaths("claude", { home: "/home/dev" }), ["/home/dev/.claude/CLAUDE.md"]);
  assert.deepEqual(
    harnessDocumentPaths("claude", { home: "/home/dev", claudeConfigDir: "/home/dev/.claude-zeus" }),
    ["/home/dev/.claude-zeus/CLAUDE.md"],
  );
  assert.deepEqual(harnessDocumentPaths("codex", { home: "/h" }), ["/h/.codex/AGENTS.md"]);
  assert.deepEqual(harnessDocumentPaths("codex", { home: "/h", codexHome: "/otro" }), ["/otro/AGENTS.md"]);
  assert.deepEqual(harnessDocumentPaths("hermes", { home: "/home/dev" }), ["/home/dev/AGENTS.md"]);
  assert.deepEqual(
    harnessDocumentPaths("openclaw", { home: "/h", openclawWorkspace: "/ws" }),
    FICHEROS_OPENCLAW.map((nombre) => `/ws/${nombre}`),
  );

  assert.deepEqual(harnessDocumentPaths("openclaw", { home: "/h" }), []);
  assert.deepEqual(harnessDocumentPaths("hermes", {}), []);
  assert.deepEqual(harnessDocumentPaths("claude", { home: "/home/dev", claudeConfigDir: "relativo" }), []);
  assert.deepEqual(harnessDocumentPaths("openclaw", { openclawWorkspace: "/ws/../escape" }), []);
  assert.deepEqual(harnessDocumentPaths("opencode", { home: "/h" }), []);
});

test("la proyección revisionada escribe y reemplaza una sola revisión en el fichero canónico", () => {
  const contexto = { perfil: perfil(), hechos: hechos() };
  const legacy = ficherosDelArnes("openclaw", contexto);
  assert.ok(legacy.every((file) => !file.texto.includes(PREFIJO_REVISION_PERFIL)));

  const revisionDos = ficherosDelArnes(
    "openclaw", contexto,
    new Map([
      ["AGENTS.md", "# Manual humano\n"],
      ["MEMORY.md", "memoria privada\n"],
      ["HEARTBEAT.md", "latido privado\n"],
    ]),
    { revision: 2 },
  );
  const agentsDos = textoDe(revisionDos, "AGENTS.md");
  assert.equal(revisionDelPerfil(agentsDos), 2);
  assert.equal(agentsDos.split(PREFIJO_REVISION_PERFIL).length - 1, 1);
  assert.match(
    agentsDos,
    new RegExp(`${marcaDeRevisionDelPerfil(2)}\\n${MARCA_PERFIL_INICIO}`, "u"),
  );

  const existentes = new Map(revisionDos.map((file) => [file.nombre, file.texto]));
  const revisionTres = ficherosDelArnes("openclaw", contexto, existentes, { revision: 3 });
  const agentsTres = textoDe(revisionTres, "AGENTS.md");
  assert.equal(revisionDelPerfil(agentsTres), 3);
  assert.ok(!agentsTres.includes(marcaDeRevisionDelPerfil(2)));
  assert.ok(agentsTres.includes("# Manual humano"));
  assert.equal(textoDe(revisionTres, "MEMORY.md"), "memoria privada\n");
  assert.equal(textoDe(revisionTres, "HEARTBEAT.md"), "latido privado\n");
  for (const file of revisionTres) {
    if (file.nombre !== "AGENTS.md") assert.ok(!file.texto.includes(PREFIJO_REVISION_PERFIL));
  }
});

test("la proyección rechaza bloques incompletos, duplicados, no alineados y solapados", () => {
  const perfilPropio = `${MARCA_PERFIL_INICIO}\n<!-- alias: Steven/zeus -->\n${MARCA_PERFIL_FIN}`;
  const fijo = `${MARCA_INICIO}\ncontrato\n${MARCA_FIN}`;
  const topologias = [
    `${MARCA_PERFIL_INICIO}\n<!-- alias: Steven/zeus -->`,
    `${perfilPropio}\n${perfilPropio}\n`,
    `manual${perfilPropio}`,
    `${MARCA_INICIO}\n${MARCA_PERFIL_INICIO}\n${MARCA_FIN}\n${MARCA_PERFIL_FIN}\n`,
    `${MARCA_PERFIL_INICIO}\n${MARCA_INICIO}\n${MARCA_PERFIL_FIN}\n${MARCA_FIN}\n`,
    `${MARCA_INICIO}\n${perfilPropio}\n${MARCA_FIN}\n`,
    `${MARCA_PERFIL_INICIO}\n${fijo}\n${MARCA_PERFIL_FIN}\n`,
  ];
  for (const text of topologias) {
    assert.throws(() => ficherosDelArnes(
      "openclaw",
      { perfil: perfil(), hechos: hechos() },
      new Map([["AGENTS.md", text]]),
      { revision: 2 },
    ));
  }
});

test("los campos autorados no pueden inyectar delimitadores reservados", () => {
  const delimiters = [
    MARCA_PERFIL_INICIO,
    MARCA_PERFIL_FIN,
    MARCA_INICIO,
    MARCA_FIN,
    PREFIJO_REVISION_PERFIL,
  ];
  for (const delimiter of delimiters) {
    assert.throws(() => ficherosDelArnes(
      "openclaw",
      { perfil: perfil({ purpose: delimiter }), hechos: hechos() },
      new Map(),
      { revision: 2 },
    ));
  }
});
