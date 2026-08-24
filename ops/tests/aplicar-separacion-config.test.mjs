#!/usr/bin/env node
/**
 * Ejecutor de la separación de configuración por alias.
 *
 * QUÉ TIENE QUE PROBAR ESTA SUITE
 * ===============================
 *
 * Que el ejecutor comprueba POR EFECTO y no por código de salida de `cp`. `cp` devuelve 0 con el
 * fichero que importa sin copiar (porque estaba en otra ruta, porque el plan lo nombró mal, porque
 * el origen no existía). Un ejecutor que se crea su propio `cp` declara éxito y deja al alias sin
 * MCP: no falla, arranca igual y se queda mudo de capacidades.
 *
 * Los tres controles negativos son los que le dan valor a las tres comprobaciones:
 *
 *   * Un destino cuyo testigo es un ENLACE DURO al origen tiene todos los ficheros en su sitio y
 *     no está separado de nada. Si la comprobación de inodo no pudiera fallar aquí, sería adorno.
 *   * Un destino sin `.claude.json` tiene el directorio, el CLAUDE.md y todo lo demás. Es
 *     exactamente el estado que ya se pagó una vez.
 *   * Un plan con borrados tiene que ser RECHAZADO: el origen es la reversa.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planificarSeparacion } from "../scripts/separar-config-alias.mjs";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
const ejecutor = path.join(scripts, "aplicar-separacion-config.sh");
const censo = path.join(scripts, "censo-config-por-alias.py");

/**
 * Reproduce el reparto medido en producción: dos alias, un contenedor, un HOME, y el fichero de
 * configuración COMPARTIDO — el mismo inodo, no dos copias. El enlace duro es la forma exacta de
 * reproducirlo en un directorio temporal.
 */
function fleteCompartido({ arnes = "codex", testigo = "AGENTS.md", conClaudeJson = false } = {}) {
  const raiz = mkdtempSync(path.join(os.tmpdir(), "cauce-separar-"));
  const home = path.join(raiz, "home");
  const directorio = arnes === "codex" ? ".codex" : ".claude";
  mkdirSync(path.join(home, directorio), { recursive: true });
  const compartido = path.join(home, directorio, testigo);
  writeFileSync(compartido, "identidad compartida por dos alias\n");
  // La credencial vive dentro del directorio: se copia con él y por eso el plan lo advierte.
  writeFileSync(path.join(home, directorio, arnes === "codex" ? "auth.json" : ".credentials.json"), "{}\n");
  if (conClaudeJson) {
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { "cloud-offload": {}, "ai-usage": {} } }, null, 2),
    );
  }
  return { raiz, home, compartido };
}

function correr(argumentos, entrada) {
  return spawnSync("bash", [ejecutor, ...argumentos], { encoding: "utf8", input: entrada });
}

function aplicar(plan, extra = []) {
  return correr(["--plan", "-", ...extra], JSON.stringify(plan));
}

function identidad(ruta) {
  const s = statSync(ruta);
  return `${s.dev}:${s.ino}`;
}

// ---------------------------------------------------------------------------
// El camino feliz, comprobado por EFECTO.
// ---------------------------------------------------------------------------

test("aplica el plan de codex y el testigo deja de compartir inodo con el alias que compartía", (t) => {
  const { raiz, home, compartido } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });

  const antes = identidad(compartido);
  const resultado = aplicar(plan, ["--comparar-con", compartido]);
  assert.equal(resultado.status, 0, `${resultado.stdout}\n${resultado.stderr}`);

  const nuevo = path.join(plan.directorioDestino, "AGENTS.md");
  assert.notEqual(identidad(nuevo), antes, "si el inodo coincide, atlas seguiría leyendo a kratos");
  assert.equal(readFileSync(nuevo, "utf8"), "identidad compartida por dos alias\n", "el contenido viaja");
  // El origen es la reversa: sigue exactamente donde estaba, con su inodo intacto.
  assert.equal(identidad(compartido), antes, "el ejecutor NO puede tocar el origen");
});

test("el .claude.json llega al destino con sus MCP dentro", (t) => {
  const { raiz, home } = fleteCompartido({ arnes: "claude", testigo: "CLAUDE.md", conClaudeJson: true });
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "zeus", home, arnes: "claude" });

  const resultado = aplicar(plan);
  assert.equal(resultado.status, 0, `${resultado.stdout}\n${resultado.stderr}`);

  const destino = path.join(plan.directorioDestino, ".claude.json");
  const documento = JSON.parse(readFileSync(destino, "utf8"));
  assert.deepEqual(Object.keys(documento.mcpServers), ["cloud-offload", "ai-usage"]);
  // El ejecutor tiene que DECIR cuántos MCP llegaron: "existe" no distingue un fichero con los
  // servidores de un `{}` que arranca igual y deja al alias sin herramientas.
  assert.match(resultado.stdout, /2/u);
  assert.match(resultado.stdout, /mcpServers|MCP/u);
});

test("informa siempre de cómo se revierte, también cuando sale bien", (t) => {
  const { raiz, home } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });
  const resultado = aplicar(plan);
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /CODEX_HOME/u);
  assert.match(resultado.stdout, new RegExp(plan.directorioDestino.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

// ---------------------------------------------------------------------------
// CONTROL NEGATIVO 1: la comprobación de inodo TIENE que poder fallar.
// ---------------------------------------------------------------------------

test("CONTROL NEGATIVO: un destino enlazado duro al origen se RECHAZA aunque tenga todo dentro", (t) => {
  const { raiz, home, compartido } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });

  // Se fabrica a mano el estado que un ejecutor crédulo daría por bueno: el directorio existe, el
  // testigo está dentro, `cp` habría devuelto 0... y es EL MISMO FICHERO. Nada se separó.
  mkdirSync(plan.directorioDestino, { recursive: true });
  linkSync(compartido, path.join(plan.directorioDestino, "AGENTS.md"));
  assert.equal(
    identidad(path.join(plan.directorioDestino, "AGENTS.md")),
    identidad(compartido),
    "premisa del control: el fixture comparte inodo de verdad",
  );

  const resultado = correr(["--plan", "-", "--comparar-con", compartido, "--solo-verificar"], JSON.stringify(plan));
  assert.notEqual(resultado.status, 0, "un enlace duro NO es una separación");
  const salida = `${resultado.stdout}${resultado.stderr}`;
  assert.match(salida, /inodo/iu);
  // Al fallar tiene que decir cómo se vuelve atrás, y decirlo con la ORDEN concreta: "revertí el
  // cambio" obliga a reconstruir de memoria qué directorio se creó y qué variable se puso.
  assert.match(salida, /CÓMO SE REVIERTE/u, "al fallar tiene que decir cómo se vuelve atrás");
  assert.match(salida, new RegExp(`rm -rf ${plan.directorioDestino.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.match(salida, /CODEX_HOME/u, "y qué variable hay que quitar");
});

test("CONTROL NEGATIVO: el enlace duro se detecta AUNQUE no se pase --comparar-con", (t) => {
  /**
   * Esta prueba existe porque la de arriba no bastaba, y se descubrió MATANDO la implementación.
   *
   * Al quitar la comprobación de inodo contra el origen, la suite seguía en verde: el fixture
   * anterior pasa `--comparar-con` apuntando al MISMO fichero del origen, así que la otra
   * comprobación lo tapaba. La comprobación contra el origen no la ejercitaba nadie — era una
   * línea que no podía dar rojo.
   *
   * `--comparar-con` es opcional, y el caso normal (separar un alias sin acordarse de nombrar al
   * vecino) tiene que detectar igual que el "destino" es el mismo fichero de siempre.
   */
  const { raiz, home, compartido } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });

  mkdirSync(plan.directorioDestino, { recursive: true });
  linkSync(compartido, path.join(plan.directorioDestino, "AGENTS.md"));

  const resultado = correr(["--plan", "-", "--solo-verificar"], JSON.stringify(plan));
  assert.notEqual(resultado.status, 0, "sin --comparar-con la separación falsa tiene que detectarse igual");
  assert.match(`${resultado.stdout}${resultado.stderr}`, /comparte inodo con el origen/u);
});

test("dice EN VOZ ALTA cuando no se comprobó contra el alias que compartía", (t) => {
  // Un informe que calla lo que NO midió se lee como si lo hubiera medido todo.
  const { raiz, home } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });
  const resultado = aplicar(plan);
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /NO se comprobó contra el alias que compartía/u);
});

// ---------------------------------------------------------------------------
// CONTROL NEGATIVO 2: el .claude.json ausente — el fallo que ya se pagó.
// ---------------------------------------------------------------------------

test("CONTROL NEGATIVO: destino completo pero SIN .claude.json se rechaza", (t) => {
  const { raiz, home } = fleteCompartido({ arnes: "claude", testigo: "CLAUDE.md", conClaudeJson: true });
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "zeus", home, arnes: "claude" });

  // Directorio copiado entero y CLAUDE.md en su sitio: todo lo que se ve "funciona". Falta el
  // fichero cuya ausencia no produce ni un error de arranque.
  mkdirSync(plan.directorioDestino, { recursive: true });
  writeFileSync(path.join(plan.directorioDestino, "CLAUDE.md"), "identidad propia\n");

  const resultado = correr(["--plan", "-", "--solo-verificar"], JSON.stringify(plan));
  assert.notEqual(resultado.status, 0, "sin .claude.json el alias pierde todos sus MCP en silencio");
  assert.match(`${resultado.stdout}${resultado.stderr}`, /\.claude\.json/u);
});

test("CONTROL NEGATIVO: un .claude.json que no es JSON válido se rechaza", (t) => {
  const { raiz, home } = fleteCompartido({ arnes: "claude", testigo: "CLAUDE.md", conClaudeJson: true });
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "zeus", home, arnes: "claude" });
  mkdirSync(plan.directorioDestino, { recursive: true });
  writeFileSync(path.join(plan.directorioDestino, "CLAUDE.md"), "identidad propia\n");
  // Un truncamiento a medias existe, pesa y no sirve: el CLI arranca sin MCP igual que si faltara.
  writeFileSync(path.join(plan.directorioDestino, ".claude.json"), '{"mcpServers": {"cloud');

  const resultado = correr(["--plan", "-", "--solo-verificar"], JSON.stringify(plan));
  assert.notEqual(resultado.status, 0, "que exista no basta: tiene que ser legible");
});

// ---------------------------------------------------------------------------
// CONTROL NEGATIVO 3: el origen es la reversa y no se toca.
// ---------------------------------------------------------------------------

test("CONTROL NEGATIVO: un plan con borrados se RECHAZA antes de tocar el disco", (t) => {
  const { raiz, home, compartido } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });
  const envenenado = { ...plan, borrados: [plan.directorioOrigen] };

  const resultado = aplicar(envenenado);
  assert.notEqual(resultado.status, 0, "el origen es la reversa: ningún plan puede borrarlo");
  assert.match(`${resultado.stdout}${resultado.stderr}`, /borrado/iu);
  assert.equal(statSync(compartido).isFile(), true, "el origen sigue intacto");
  assert.throws(() => statSync(plan.directorioDestino), "no puede haber quedado nada a medias");
});

test("un origen obligatorio ausente detiene el plan ANTES de copiar nada", (t) => {
  // El caso real: un alias claude sin `.claude.json` en el home. Copiar el directorio y descubrirlo
  // después deja al alias apuntando a un sitio sin MCP. Se para antes y se dice cuál falta.
  const { raiz, home } = fleteCompartido({ arnes: "claude", testigo: "CLAUDE.md", conClaudeJson: false });
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "zeus", home, arnes: "claude" });

  const resultado = aplicar(plan);
  assert.notEqual(resultado.status, 0);
  assert.match(`${resultado.stdout}${resultado.stderr}`, /\.claude\.json/u);
  assert.throws(() => statSync(plan.directorioDestino), "no se copió nada");
});

test("no pisa un destino que ya existe salvo que se pida --rehacer", (t) => {
  const { raiz, home } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const plan = planificarSeparacion({ alias: "kratos", home, arnes: "codex" });
  mkdirSync(plan.directorioDestino, { recursive: true });
  writeFileSync(path.join(plan.directorioDestino, "AGENTS.md"), "algo que ya estaba\n");

  const primero = aplicar(plan, ["--comparar-con", path.join(home, ".codex/AGENTS.md")]);
  assert.notEqual(primero.status, 0, "pisar en silencio un destino existente destruye trabajo ajeno");

  const segundo = aplicar(plan, ["--comparar-con", path.join(home, ".codex/AGENTS.md"), "--rehacer"]);
  assert.equal(segundo.status, 0, `${segundo.stdout}\n${segundo.stderr}`);
  assert.equal(readFileSync(path.join(plan.directorioDestino, "AGENTS.md"), "utf8"), "identidad compartida por dos alias\n");
});

// ---------------------------------------------------------------------------
// El lazo con el censo: la prueba de que el trabajo QUEDÓ hecho.
// ---------------------------------------------------------------------------

test("tras separar los dos alias, el censo por inodo deja de ver el grupo compartido", (t) => {
  const { raiz, home, compartido } = fleteCompartido();
  t.after(() => rmSync(raiz, { recursive: true, force: true }));

  // ANTES: kratos y atlas medidos sobre el fichero compartido de verdad. El censo tiene que verlo.
  const antes = ["kratos", "atlas"].map((alias) => ({
    alias, ruta: compartido, inodo: statSync(compartido).ino, dispositivo: statSync(compartido).dev,
  }));
  const censoAntes = spawnSync("python3", [censo], { encoding: "utf8", input: JSON.stringify(antes) });
  assert.equal(censoAntes.status, 1, "la premisa del fixture: hoy comparten fichero");
  assert.equal(JSON.parse(censoAntes.stdout).grupos[0].alias.join(","), "atlas,kratos");

  for (const alias of ["kratos", "atlas"]) {
    const plan = planificarSeparacion({ alias, home, arnes: "codex" });
    const resultado = aplicar(plan, ["--comparar-con", compartido]);
    assert.equal(resultado.status, 0, `${alias}: ${resultado.stdout}\n${resultado.stderr}`);
  }

  // DESPUÉS: se vuelve a MEDIR sobre el disco real, no se supone.
  const despues = ["kratos", "atlas"].map((alias) => {
    const ruta = path.join(home, ".cauce", alias, ".codex/AGENTS.md");
    const s = statSync(ruta);
    return { alias, ruta, inodo: s.ino, dispositivo: s.dev };
  });
  const censoDespues = spawnSync("python3", [censo], { encoding: "utf8", input: JSON.stringify(despues) });
  assert.equal(censoDespues.status, 0, `todavía comparten: ${censoDespues.stdout}`);
  assert.equal(JSON.parse(censoDespues.stdout).compartidos, 0);
});
