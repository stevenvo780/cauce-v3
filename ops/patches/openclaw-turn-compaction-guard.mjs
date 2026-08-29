/**
 * Patch over openclaw: a failed compaction must not take down the turn's response.
 *
 * `runCliTurnCompactionLifecycle(...)` was called UNPROTECTED, while the transcript persistence
 * — three lines above, in the same block — already has its `try/catch` with `log.warn`. If the
 * compaction threw, the exception took the whole turn: the response was already computed and
 * paid for, and was never delivered. It looks like an agent that works and never answers.
 *
 * This is third-party software: the file is rewritten on every openclaw install and the bundle
 * name is a hash that changes with the version. See ops/patches/README.md.
 *
 * Use: OPENCLAW_DIST=/path/to/bundle.js node openclaw-turn-compaction-guard.mjs
 * Prints a single word on stdout: `applied` or `already-applied`. Anything else is a failure and
 * exits non-zero.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DEFAULT_DIST = "/usr/lib/node_modules/openclaw/dist/agent-command-DimMXeog.js";
const target = process.env.OPENCLAW_DIST ?? DEFAULT_DIST;

/** Anchor point: the unprotected call, exactly as emitted by the bundler. */
const ANCHOR = "if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) sessionEntry = "
  + "await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({";
const GUARDED = "if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) try { sessionEntry = "
  + "await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({";
/** Mark that the patch is already in place. It's what the README check looks for. */
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
 * The `catch` goes after the `});` that closes the call, not on the first line that starts the
 * same way: the arguments object has its own braces and cutting at the first match would leave
 * the file syntactically broken. We search forward from the anchor.
 */
const start = original.indexOf(ANCHOR);
const closing = original.indexOf("\n\t\t\t\t});\n", start);
if (closing === -1) fail(`no encuentro el cierre de la llamada en ${target}`);
const after = closing + "\n\t\t\t\t});\n".length;

const patched = `${original.slice(0, start)}${GUARDED}${original.slice(start + ANCHOR.length, after)}\t\t\t\t${RESCUE}\n${original.slice(after)}`;

/**
 * We check the EFFECT, not that the replacement "worked": a broken bundle leaves the agent unable
 * to start, which is worse than the failure we came to fix. We validate before writing.
 */
const stamp = new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15);
// The temp file's extension is NOT cosmetic: `node --check` infers the dialect from the name,
// and with any other suffix it fails with ERR_UNKNOWN_FILE_EXTENSION before inspecting the content.
// The openclaw bundle is ESM, so `.mjs`.
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
