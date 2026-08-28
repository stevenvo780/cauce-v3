import assert from "node:assert/strict";
import { test } from "vitest";
import { measureStrictestUnits, type AgentProfile, type HechosDelAlias } from "../src/agent-profile.js";
import {
  MARCA_FIN, MARCA_INICIO, MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO,
} from "../src/marcas-de-bloque.js";
import {
  ErrorDeTopeDelArnes, FICHEROS_OPENCLAW, PREFIJO_REVISION_PERFIL, TOPES_OPENCLAW,
  ficherosDelArnes, marcaDeRevisionDelPerfil, nombresDelArnes, revisionDelPerfil,
  type FicheroGenerado,
} from "../src/ficheros-del-arnes.js";

// Tests para el generador de ficheros por arnés.

/** Un emoji fuera del BMP: 1 punto de código, 2 unidades UTF-16. */
const ASTRAL = "\u{1F389}";

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

/** El texto de un fichero del plan, por nombre. Falla si el generador no lo emitió. */
function textoDe(ficheros: readonly { nombre: string; texto: string }[], nombre: string): string {
  const encontrado = ficheros.find((fichero) => fichero.nombre === nombre);
  assert.ok(encontrado, `el generador no emitió ${nombre}`);
  return encontrado.texto;
}

// ── EL REPARTO ───────────────────────────────────────────────────────────────────────────────

test("claude recibe UN solo CLAUDE.md, y codex UN solo AGENTS.md", () => {
  const deClaude = ficherosDelArnes("claude", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(deClaude.map((f: FicheroGenerado) => f.nombre), ["CLAUDE.md"]);

  const deCodex = ficherosDelArnes("codex", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(deCodex.map((f: FicheroGenerado) => f.nombre), ["AGENTS.md"]);
});

test("el formato legacy conserva un solo salto entre owner y cuerpo", () => {
  const claude = textoDe(
    ficherosDelArnes("claude", { perfil: perfil(), hechos: hechos() }),
    "CLAUDE.md",
  );
  assert.ok(claude.includes("<!-- alias: Steven/zeus -->\n## Identidad y propósito"));
  assert.ok(!claude.includes("<!-- alias: Steven/zeus -->\n\n## Identidad y propósito"));
});

test("openclaw recibe los SIETE ficheros medidos, con esos nombres exactos", () => {
  const ficheros = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(
    ficheros.map((f: FicheroGenerado) => f.nombre),
    ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "TOOLS.md"],
  );
  // La lista exportada y lo que se emite son la MISMA cosa: una prueba contra una copia suya se
  // quedaría verde el día que el generador dejara de emitir uno.
  assert.deepEqual(ficheros.map((f: FicheroGenerado) => f.nombre), [...FICHEROS_OPENCLAW]);
  assert.deepEqual(nombresDelArnes("openclaw"), [...FICHEROS_OPENCLAW]);
});

test("un arnés desconocido no recibe ningún fichero, en vez de recibir el de otro", () => {
  assert.deepEqual(ficherosDelArnes(
    "hermes",
    { perfil: perfil(), hechos: hechos() },
    new Map([["AGENTS.md", `${MARCA_PERFIL_INICIO}\nroto`]]),
  ), []);
  assert.deepEqual(nombresDelArnes("hermes"), []);
});

test("cada cara del perfil cae en SU fichero y NO en los demás", () => {
  const ficheros = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });

  // Cada marcador aparece en el fichero que le toca...
  assert.match(textoDe(ficheros, "SOUL.md"), /PROPOSITO-SOUL/);
  assert.match(textoDe(ficheros, "IDENTITY.md"), /ROL-IDENTITY/);
  assert.match(textoDe(ficheros, "USER.md"), /HUMANO-USER/);
  assert.match(textoDe(ficheros, "AGENTS.md"), /RESPONSABILIDAD-AGENTS/);
  assert.match(textoDe(ficheros, "AGENTS.md"), /RESTRICCION-AGENTS/);
  assert.match(textoDe(ficheros, "AGENTS.md"), /REGLA-AGENTS/);
  assert.match(textoDe(ficheros, "TOOLS.md"), /HERRAMIENTA-TOOLS/);
  assert.doesNotMatch(textoDe(ficheros, "TOOLS.md"), /CAPACIDAD-TOOLS|CUOTA-TOOLS/);

  // ...y en NINGÚN otro. Éste es el control que hace la prueba capaz de dar rojo: sin él, un
  // generador que escribiera el perfil entero en los siete ficheros pasaría los asertos de arriba.
  const marcadores: ReadonlyArray<readonly [string, RegExp]> = [
    ["SOUL.md", /PROPOSITO-SOUL/], ["IDENTITY.md", /ROL-IDENTITY/], ["USER.md", /HUMANO-USER/],
    ["AGENTS.md", /RESPONSABILIDAD-AGENTS/], ["TOOLS.md", /HERRAMIENTA-TOOLS/],
  ];
  for (const [duenno, marcador] of marcadores) {
    for (const fichero of ficheros) {
      if (fichero.nombre === duenno) continue;
      assert.doesNotMatch(
        fichero.texto, marcador,
        `${marcador} se coló en ${fichero.nombre}; sólo pertenece a ${duenno}`,
      );
    }
  }
});

test("revocar permisos o cambiar destinos, cuotas y montaje NO deja una fotografía rancia en disco", () => {
  const antes = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  const despues = ficherosDelArnes("openclaw", {
    perfil: perfil(),
    hechos: hechos({
      permisos: { ruta: false, lectura: false, control: false, notificacion: false },
      destinos: ["socrates"],
      cuotas: [{ proveedor: "codex", cuenta: "otra", limite: "agotada" }],
      arnes: {
        harness: "claude", home: "/otro/home", contenedor: "otro-contenedor",
        capacidades: ["otra-capacidad"],
      },
    }),
  });

  assert.deepEqual(
    despues.map((fichero: FicheroGenerado) => [fichero.nombre, fichero.texto]),
    antes.map((fichero: FicheroGenerado) => [fichero.nombre, fichero.texto]),
  );
  for (const fichero of despues) {
    assert.doesNotMatch(
      fichero.texto,
      /kant|argos|socrates|CUOTA-TOOLS|otra-capacidad|otro-contenedor|\/otro\/home|Leer el estado/,
    );
  }
});

// ── MEMORY Y HEARTBEAT SON DEL AGENTE ────────────────────────────────────────────────────────

test("MEMORY y HEARTBEAT que YA existen se devuelven intactos byte a byte, y sin escribir", () => {
  const memoriaViva = "# Memoria\n\nlo que el agente aprendió solo\n";
  const latidoVivo = "cada 30 min miro la cola\n";
  const ficheros = ficherosDelArnes(
    "openclaw", { perfil: perfil(), hechos: hechos() },
    new Map([["MEMORY.md", memoriaViva], ["HEARTBEAT.md", latidoVivo]]),
  );

  const memoria = ficheros.find((f: FicheroGenerado) => f.nombre === "MEMORY.md");
  assert.ok(memoria);
  assert.equal(memoria.texto, memoriaViva, "MEMORY.md se modificó: es del agente, no nuestro");
  assert.equal(memoria.escribir, false, "no hay que reescribir un MEMORY.md que ya estaba");
  // La POLÍTICA declarada, y no sólo el resultado: hoy un MEMORY tratado como bloque gestionado
  // daría el mismo texto de casualidad —porque no le toca ninguna sección—, y esa casualidad se
  // acaba el día que alguien le asigne una. Lo que protege el fichero es la política, no el empate.
  assert.equal(memoria.politica, "solo-si-falta");

  const latido = ficheros.find((f: FicheroGenerado) => f.nombre === "HEARTBEAT.md");
  assert.ok(latido);
  assert.equal(latido.texto, latidoVivo);
  assert.equal(latido.escribir, false);
  assert.equal(latido.politica, "solo-si-falta");
});

test("CONTROL NEGATIVO: un MEMORY con marcas nuestras TAMPOCO se toca", () => {
  // Si el generador tratara MEMORY como «bloque gestionado», este fichero se reescribiría. La
  // política de MEMORY no es «fusionar»: es «no es mío».
  const memoriaConMarcas = `${MARCA_PERFIL_INICIO}\nviejo\n${MARCA_PERFIL_FIN}\nlo del agente\n`;
  const ficheros = ficherosDelArnes(
    "openclaw", { perfil: perfil(), hechos: hechos() },
    new Map([["MEMORY.md", memoriaConMarcas]]),
  );
  const memoria = ficheros.find((f: FicheroGenerado) => f.nombre === "MEMORY.md");
  assert.ok(memoria);
  assert.equal(memoria.texto, memoriaConMarcas);
  assert.equal(memoria.escribir, false);
  assert.equal(memoria.politica, "solo-si-falta");
});

test("MEMORY y HEARTBEAT que FALTAN se siembran vacíos, y se escriben", () => {
  const ficheros = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  for (const nombre of ["MEMORY.md", "HEARTBEAT.md"]) {
    const fichero = ficheros.find((f: FicheroGenerado) => f.nombre === nombre);
    assert.ok(fichero);
    assert.equal(fichero.escribir, true, `${nombre} falta: hay que crearlo`);
    assert.equal(fichero.politica, "solo-si-falta");
    // Vacío de CONTENIDO nuestro: ni perfil, ni bloque gestionado. Que exista el fichero es lo
    // único que aporta la siembra; lo que diga dentro es del agente.
    assert.doesNotMatch(fichero.texto, /PROPOSITO-SOUL|ROL-IDENTITY|RESPONSABILIDAD-AGENTS/);
    assert.ok(!fichero.texto.includes(MARCA_PERFIL_INICIO), `${nombre} no lleva bloque gestionado`);
  }
});

// ── EL BLOQUE GESTIONADO: lo que escribió una persona sobrevive ──────────────────────────────

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

test("regenerar sobre lo ya generado NO duplica el bloque", () => {
  const contexto = { perfil: perfil(), hechos: hechos() };
  const primera = textoDe(ficherosDelArnes("openclaw", contexto), "SOUL.md");
  const segunda = textoDe(
    ficherosDelArnes("openclaw", contexto, new Map([["SOUL.md", primera]])), "SOUL.md",
  );
  assert.equal(segunda, primera, "la segunda generación no es idéntica: el fichero se mueve solo");
  assert.equal(segunda.split(MARCA_PERFIL_INICIO).length - 1, 1, "el bloque quedó duplicado");
});

test("el bloque SELLADO del contrato no se toca: el generador sólo escribe el suyo", () => {
  // El bloque A lo escribe el adaptador y su sha es el del sobre. Si el generador lo reformateara,
  // el sello dejaría de coincidir, el sobre iría entero para siempre y no habría ningún error.
  const sellado = `${MARCA_INICIO}\nCONTRATO INTOCABLE\n${MARCA_FIN}`;
  const ficheros = ficherosDelArnes(
    "openclaw", { perfil: perfil(), hechos: hechos() },
    new Map([["AGENTS.md", `${sellado}\n\nde una persona\n`]]),
  );
  const agents = textoDe(ficheros, "AGENTS.md");
  assert.ok(agents.includes(sellado), "el bloque sellado del contrato se modificó");
  assert.ok(agents.includes("de una persona"));
});

// ── DETERMINISMO ─────────────────────────────────────────────────────────────────────────────

test("mismo perfil y mismos hechos -> los MISMOS bytes", () => {
  const uno = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  const otro = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  assert.deepEqual(uno.map((f: FicheroGenerado) => f.texto), otro.map((f: FicheroGenerado) => f.texto));
});

test("el ORDEN EN QUE SE CONSTRUYÓ el perfil no cambia un solo byte", () => {
  // `JSON.stringify` y `Object.keys` respetan el orden de inserción, así que un perfil venido de
  // un `JSON.parse` produce bytes distintos que uno construido a mano si algo depende del orden.
  const derecho: AgentProfile = {
    tenant_id: "Steven", alias: "zeus", purpose: "P", role_summary: "R", human_brief: "H",
    responsibilities: ["a"], restrictions: ["b"], tools: ["c"], operating_rules: ["d"],
  };
  const alReves = {
    operating_rules: ["d"], tools: ["c"], restrictions: ["b"], responsibilities: ["a"],
    human_brief: "H", role_summary: "R", purpose: "P", alias: "zeus", tenant_id: "Steven",
  } as AgentProfile;
  assert.deepEqual(
    ficherosDelArnes("openclaw", { perfil: derecho, hechos: hechos() }).map((f: FicheroGenerado) => f.texto),
    ficherosDelArnes("openclaw", { perfil: alReves, hechos: hechos() }).map((f: FicheroGenerado) => f.texto),
  );
});

test("CONTROL NEGATIVO del determinismo: cambiar UN campo SÍ cambia los bytes", () => {
  // Sin esta prueba, un generador que devolviera siempre la cadena vacía pasaría las dos de arriba.
  const base = ficherosDelArnes("openclaw", { perfil: perfil(), hechos: hechos() });
  const movido = ficherosDelArnes("openclaw", {
    perfil: perfil({ purpose: "OTRO proposito distinto" }), hechos: hechos(),
  });
  assert.notDeepEqual(base.map((f: FicheroGenerado) => f.texto), movido.map((f: FicheroGenerado) => f.texto));
});

// ── LOS TOPES DE OPENCLAW ────────────────────────────────────────────────────────────────────

test("un fichero que pasa de 60.000 da error CLARO, y no un fichero truncado", () => {
  const enorme = "x".repeat(TOPES_OPENCLAW.porFichero + 1);
  assert.throws(
    () => ficherosDelArnes("openclaw", {
      perfil: perfil({ purpose: enorme }), hechos: hechos(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTopeDelArnes, "el error tiene que ser identificable");
      // El fichero por su nombre, y los dos números: sin ellos el operador no sabe cuánto recortar.
      assert.equal(error.fichero, "SOUL.md");
      assert.equal(error.tope, TOPES_OPENCLAW.porFichero);
      assert.ok(error.medido > TOPES_OPENCLAW.porFichero);
      assert.match(error.message, /SOUL\.md/);
      return true;
    },
  );
});

test("el TOTAL que pasa de 150.000 da error, aunque NINGÚN fichero pase por su cuenta", () => {
  // Cada campo entra holgado en su fichero; lo que no entra es la suma. Sin el tope total esto
  // pasaría, y openclaw dejaría de cargar la persona entera sin decir por qué.
  const grande = "y".repeat(50_000);
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

test("CONTROL NEGATIVO de los topes: justo por debajo NO falla y NO se trunca", () => {
  // Si la guarda estuviera mal puesta —un `>=` donde va un `>`, o el tope medido sobre el texto
  // equivocado— esta prueba se pone roja. Y comprueba además que el texto sale ENTERO.
  const casi = "z".repeat(1_999);
  const ficheros = ficherosDelArnes("openclaw", {
    perfil: perfil({ purpose: casi }), hechos: hechos(),
  });
  const soul = textoDe(ficheros, "SOUL.md");
  assert.ok(soul.includes(casi), "el propósito salió truncado estando dentro del tope");
});

test("el tope se mide en la unidad de openclaw (UTF-16), no en bytes ni en puntos de código", () => {
  // Un emoji fuera del BMP vale 1 punto de código y 2 unidades UTF-16. openclaw cuenta como JS.
  // Medir puntos de código dejaría pasar un fichero que a openclaw no le entra.
  const mitad = Math.floor(TOPES_OPENCLAW.porFichero / 2) + 1;
  const astral = ASTRAL.repeat(mitad);
  assert.equal(measureStrictestUnits(astral), mitad * 2);
  assert.throws(
    () => ficherosDelArnes("openclaw", { perfil: perfil({ purpose: astral }), hechos: hechos() }),
    ErrorDeTopeDelArnes,
  );
});

test("claude y codex no tienen tope declarado: un perfil enorme NO se rechaza por el de openclaw", () => {
  // CONTROL NEGATIVO del alcance de la guarda: los topes son de openclaw, medidos en su config.
  // Aplicárselos a claude sería inventarle un límite que su arnés no declara.
  const enorme = "x".repeat(TOPES_OPENCLAW.porFichero + 1);
  assert.doesNotThrow(
    () => ficherosDelArnes("claude", { perfil: perfil({ purpose: enorme }), hechos: hechos() }),
  );
});

// ── EL PERFIL VACÍO ──────────────────────────────────────────────────────────────────────────

test("un perfil sin nada escrito no produce encabezados huecos", () => {
  const vacio: AgentProfile = {
    tenant_id: "Steven", alias: "argos", purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
  };
  const ficheros = ficherosDelArnes("openclaw", { perfil: vacio, hechos: hechos() });
  const soul = textoDe(ficheros, "SOUL.md");
  assert.ok(!soul.includes(MARCA_PERFIL_INICIO), "SOUL vacío no debe llevar bloque");
  assert.equal(soul.trim(), "");
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

test("un perfil vacío revisionado conserva un bloque propio acreditable", () => {
  const vacio: AgentProfile = {
    tenant_id: "Steven", alias: "zeus", purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
  };
  const claude = textoDe(
    ficherosDelArnes("claude", { perfil: vacio, hechos: hechos() }, new Map(), { revision: 8 }),
    "CLAUDE.md",
  );
  assert.equal(revisionDelPerfil(claude), 8);
  assert.match(claude, /<!-- alias: Steven\/zeus -->/u);
  assert.ok(claude.includes(MARCA_PERFIL_INICIO));
});

test("codex queda en el formato legacy porque el modo nativo todavía no lo soporta", () => {
  const codex = textoDe(
    ficherosDelArnes("codex", { perfil: perfil(), hechos: hechos() }, new Map(), { revision: 8 }),
    "AGENTS.md",
  );
  assert.ok(!codex.includes(PREFIJO_REVISION_PERFIL));
  assert.match(codex, /PROPOSITO-SOUL/u);
});

test("una revisión malformada, repetida o fuera del fichero canónico falla cerrado", () => {
  const contexto = { perfil: perfil(), hechos: hechos() };
  const cases = [
    new Map([["AGENTS.md", `${PREFIJO_REVISION_PERFIL} basura -->\n`]]),
    new Map([["AGENTS.md", `${marcaDeRevisionDelPerfil(1)}\n${marcaDeRevisionDelPerfil(1)}\n`]]),
    new Map([[
      "AGENTS.md",
      `${MARCA_PERFIL_INICIO}\n<!-- alias: Steven/zeus -->\n${marcaDeRevisionDelPerfil(1)}\n${MARCA_PERFIL_FIN}\n`,
    ]]),
    new Map([["SOUL.md", `${marcaDeRevisionDelPerfil(1)}\n${MARCA_PERFIL_INICIO}\nx\n${MARCA_PERFIL_FIN}\n`]]),
  ];
  for (const existing of cases) {
    assert.throws(() => ficherosDelArnes("openclaw", contexto, existing, { revision: 2 }));
  }
});

test("la siembra sin revisión rechaza una proyección revisionada en vez de falsear vigencia", () => {
  const contexto = { perfil: perfil(), hechos: hechos() };
  const revisionada = ficherosDelArnes("openclaw", contexto, new Map(), { revision: 4 });
  const existing = new Map(revisionada.map((file) => [file.nombre, file.texto]));
  assert.throws(
    () => ficherosDelArnes(
      "openclaw",
      { perfil: perfil({ purpose: "cambio sin revisión" }), hechos: hechos() },
      existing,
    ),
    /requires an explicit durable revision/u,
  );
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

test("la proyección rechaza CRLF antes de producir una mezcla de finales de línea", () => {
  assert.throws(
    () => ficherosDelArnes(
      "claude",
      { perfil: perfil(), hechos: hechos() },
      new Map([["CLAUDE.md", "# Manual\r\n"]]),
      { revision: 2 },
    ),
    /does not accept CR or CRLF/u,
  );
});

test("un TOOLS.md enorme que la siembra no toca no veta los ficheros que sí escribe", () => {
  const enorme = "x".repeat(TOPES_OPENCLAW.porFichero + 1);
  const existentes = new Map([["TOOLS.md", enorme]]);
  const generados = ficherosDelArnes(
    "openclaw", { perfil: perfil({ tools: [] }), hechos: hechos() }, existentes, { revision: 3 },
  );
  const tools = generados.find((f: FicheroGenerado) => f.nombre === "TOOLS.md");
  assert.ok(tools);
  assert.equal(tools.escribir, false);
  assert.equal(tools.texto, enorme);
  const soul = generados.find((f: FicheroGenerado) => f.nombre === "SOUL.md");
  assert.ok(soul, "el generador no emitió SOUL.md");
  assert.ok(soul.escribir, "SOUL.md debía escribirse aunque TOOLS.md sea enorme");
});
