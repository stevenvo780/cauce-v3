/**
 * Parche sobre openclaw: una compactación fallida no puede llevarse la respuesta del turno.
 *
 * `runCliTurnCompactionLifecycle(...)` se llamaba SIN proteger, mientras que la persistencia del
 * transcript —tres líneas más arriba, en el mismo bloque— sí tiene su `try/catch` con `log.warn`.
 * Si la compactación tiraba, la excepción se llevaba el turno entero: la respuesta ya estaba
 * calculada y pagada, y no se entregaba nunca. Se ve como un agente que trabaja y no contesta.
 *
 * Es software de terceros: el archivo se reescribe en cada instalación de openclaw y el nombre del
 * bundle es un hash que cambia con la versión. Ver ops/patches/README.md.
 *
 * Uso: OPENCLAW_DIST=/ruta/al/bundle.js node openclaw-turn-compaction-guard.mjs
 * Imprime una sola palabra en stdout: `aplicado` o `ya-aplicado`. Cualquier otra cosa es un fallo
 * y sale distinto de 0.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DEFAULT_DIST = "/usr/lib/node_modules/openclaw/dist/agent-command-DimMXeog.js";
const target = process.env.OPENCLAW_DIST ?? DEFAULT_DIST;

/** El punto de anclaje: la llamada desprotegida, tal cual la emite el bundler. */
const ANCHOR = "if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) sessionEntry = "
  + "await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({";
const GUARDED = "if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) try { sessionEntry = "
  + "await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({";
/** Marca de que el parche ya está puesto. Es lo mismo que busca la comprobación del README. */
const MARK = "Turn compaction failed for";
const RESCUE = "} catch (error) { log.warn(`Turn compaction failed for ${sessionKey ?? sessionId}: "
  + "${error instanceof Error ? error.message : String(error)}`); }";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const original = readFileSync(target, "utf8");
if (original.includes(MARK)) {
  process.stdout.write("ya-aplicado\n");
  process.exit(0);
}
if (!original.includes(ANCHOR)) {
  fail(`no encuentro la llamada sin proteger en ${target}: revisá si openclaw ya lo arregló (ops/patches/README.md)`);
}
if (original.split(ANCHOR).length !== 2) {
  fail(`la llamada aparece más de una vez en ${target}: el parche a ciegas no es seguro`);
}

/**
 * El `catch` va después del `});` que cierra la llamada, no en la primera línea que empiece igual:
 * el objeto de argumentos tiene sus propias llaves y cortar por la primera coincidencia dejaría el
 * archivo sintácticamente roto. Se busca desde el ancla hacia adelante.
 */
const start = original.indexOf(ANCHOR);
const closing = original.indexOf("\n\t\t\t\t});\n", start);
if (closing === -1) fail(`no encuentro el cierre de la llamada en ${target}`);
const after = closing + "\n\t\t\t\t});\n".length;

const patched = `${original.slice(0, start)}${GUARDED}${original.slice(start + ANCHOR.length, after)}\t\t\t\t${RESCUE}\n${original.slice(after)}`;

/**
 * Se comprueba el EFECTO, no que el reemplazo haya "funcionado": un bundle roto deja al agente sin
 * arrancar, y eso es peor que el fallo que vinimos a arreglar. Se valida antes de escribir.
 */
const stamp = new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15);
// La extensión del temporal NO es cosmética: `node --check` deduce el dialecto del nombre, y con
// cualquier otro sufijo falla con ERR_UNKNOWN_FILE_EXTENSION antes de mirar el contenido. El
// bundle de openclaw es ESM, así que `.mjs`.
const scratch = `${target}.parche-${stamp}.mjs`;
writeFileSync(scratch, patched, "utf8");
try {
  execFileSync(process.execPath, ["--check", scratch], { stdio: "pipe" });
} catch (error) {
  rmSync(scratch, { force: true });
  fail(`el archivo parcheado no es JavaScript válido, no se aplicó nada: ${error instanceof Error ? error.message : String(error)}`);
}

copyFileSync(target, `${target}.bak-${stamp}`);
writeFileSync(target, patched, "utf8");
rmSync(scratch, { force: true });
process.stdout.write("aplicado\n");
