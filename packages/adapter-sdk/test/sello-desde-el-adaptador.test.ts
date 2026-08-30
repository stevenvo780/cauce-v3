import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { conBloqueDePerfil } from "@cauce/protocol";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import { conBloqueGestionado } from "../src/harnesses/contexto-fijo.js";
import {
  HarnessAdapter,
  PRIMARY_DUTY_HEADER,
  textoFijoDelSobre,
  type HarnessRequestContext,
} from "../src/harnesses/shared.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";

/*
 * THE END-TO-END TEST OF THE TRIM, inside the real adapter.
 *
 * The other sello tests measure individual functions. This one assembles a real `HarnessAdapter`,
 * gives it a `HOME` with a seeded instructions file, and looks at what reaches the harness via
 * stdin. It is the only one that can assert that the trim HAPPENS on the path used in
 * production, not only that the function that decides it returns `true`.
 */

function contexto(alias: string): HarnessRequestContext {
  return {
    self_alias: alias,
    sender_alias: "argos",
    tenant_id: "Steven",
    room_id: "grp.steven",
    channel: "telegram",
    agent_message: true,
    message_type: "agent.message",
    routing_targets: [{ tenant_id: "Steven", alias: "kant", online: true }],
    self_role: `Sos ${alias}.`,
  };
}

/** A runner that executes nothing: it just stores the stdin that would have been sent to the harness. */
function runnerEspia(): { runner: CommandRunner; visto: string[] } {
  const visto: string[] = [];
  const runner: CommandRunner = {
    async run(request: CommandRunRequest): Promise<CommandRunResult> {
      visto.push(request.stdin);
      // The shape emitted by `claude --print --output-format json`: the structured result goes
      // INSIDE `result`. Hand-fabricating it here is what allows using the real `claude` harness,
      // which is the only one that resolves an instructions-file path.
      return {
        stdout: JSON.stringify({
          type: "result",
          session_id: "sesion-de-prueba",
          result: JSON.stringify({ reply: "ok", messages: [], status: "done", retryable: false, artifacts: [] }),
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      };
    },
  };
  return { runner, visto };
}

async function correrUnTurno(home: string, alias: string): Promise<string> {
  const estado = mkdtempSync(join(tmpdir(), "cauce-sello-estado-"));
  const { runner, visto } = runnerEspia();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await DurableStore.open(estado),
  });
  const homePrevio = process.env.HOME;
  /*
   * `CLAUDE_CONFIG_DIR` WINS over `HOME`, and that is not a test detail: it is exactly the
   * mechanism by which each alias gets its own configuration directory when they share `$HOME`.
   * If it is not isolated here, the test reads the real `CLAUDE.md` of whoever runs it —it
   * happened to me— and fails for the wrong reason.
   */
  const configPrevio = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    await adapter.execute({
      prompt: "Revisa el gateway.",
      context: contexto(alias),
      timeoutMs: 30_000,
      signal: AbortSignal.timeout(30_000),
    });
  } finally {
    if (homePrevio === undefined) delete process.env.HOME;
    else process.env.HOME = homePrevio;
    if (configPrevio === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configPrevio;
    rmSync(estado, { recursive: true, force: true });
  }
  return visto[0] ?? "";
}

test("con el CLAUDE.md sembrado, el adaptador NO le manda el bloque fijo al arnés", async () => {
  const home = mkdtempSync(join(tmpdir(), "cauce-home-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const fijo = textoFijoDelSobre(contexto("zeus"));
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      conBloqueGestionado("# Manual de zeus\n\nEsto lo escribió una persona.\n", fijo),
      "utf8",
    );

    const stdin = await correrUnTurno(home, "zeus");
    assert.ok(!stdin.includes(PRIMARY_DUTY_HEADER), "el bloque fijo viajó igual teniéndolo el fichero");
    assert.match(stdin, /contexto Cauce v/u, "no quedó la referencia al contrato ya cargado");
    assert.ok(stdin.includes("Revisa el gateway."), "se perdió el pedido");
    assert.ok(stdin.length < 3_000, `el sobre midió ${String(stdin.length)}: no se recortó`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── CONTROLES NEGATIVOS ─────────────────────────────────────────────────────────────────────

test("CONTROL NEGATIVO: sin fichero sembrado, el adaptador manda el sobre ENTERO", async () => {
  const home = mkdtempSync(join(tmpdir(), "cauce-home-vacio-"));
  try {
    const stdin = await correrUnTurno(home, "zeus");
    assert.ok(stdin.includes(PRIMARY_DUTY_HEADER), "se recortó sin que el fichero dijera nada");
    assert.ok(stdin.length > 5_000, `el sobre midió ${String(stdin.length)}: parece recortado`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CONTROL NEGATIVO: con el fichero de OTRO alias, el sobre va ENTERO", async () => {
  /*
   * The real case of `kratos` and `atlas`, which share `$HOME` and whose file is the SAME inode.
   * If the sello did not depend on the alias, one's manual would accredit the other's contract.
   */
  const home = mkdtempSync(join(tmpdir(), "cauce-home-compartido-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      conBloqueGestionado("", textoFijoDelSobre(contexto("kratos"))),
      "utf8",
    );
    const stdin = await correrUnTurno(home, "atlas");
    assert.ok(stdin.includes(PRIMARY_DUTY_HEADER), "el fichero de kratos acreditó el contrato de atlas");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CONTROL NEGATIVO: un fichero sin bloque gestionado NO recorta nada", async () => {
  const home = mkdtempSync(join(tmpdir(), "cauce-home-sinbloque-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Un manual sin nada de Cauce\n", "utf8");
    const stdin = await correrUnTurno(home, "zeus");
    assert.ok(stdin.includes(PRIMARY_DUTY_HEADER));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("con la siembra ENCENDIDA, el segundo turno ya va recortado", async () => {
  /*
   * This is what makes the saving happen in production without a maintenance window: the first
   * turn after an upgrade writes the block and sends the whole envelope; from the second one
   * onward it is trimmed. It heals itself.
   */
  const home = mkdtempSync(join(tmpdir(), "cauce-home-siembra-"));
  const previo = process.env.CAUCE_SEMBRAR_CONTEXTO;
  process.env.CAUCE_SEMBRAR_CONTEXTO = "1";
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    /*
     * MEASURED: it already trims on the FIRST turn, not the second. Seeding happens before the
     * envelope is assembled, and on the headless path the harness process starts after writing:
     * it reads the freshly-seeded file in that very invocation. I expected two turns and it is zero.
     */
    const primero = await correrUnTurno(home, "zeus");
    assert.ok(!primero.includes(PRIMARY_DUTY_HEADER), "no recortó ni siquiera tras sembrar");
    assert.ok(existsSync(join(home, ".claude", "CLAUDE.md")), "no escribió el fichero");
    const segundo = await correrUnTurno(home, "zeus");
    assert.ok(!segundo.includes(PRIMARY_DUTY_HEADER), "el segundo turno dejó de recortar");
    assert.equal(primero.length, segundo.length, "dos turnos iguales tendrían que dar el mismo sobre");
  } finally {
    if (previo === undefined) delete process.env.CAUCE_SEMBRAR_CONTEXTO;
    else process.env.CAUCE_SEMBRAR_CONTEXTO = previo;
    rmSync(home, { recursive: true, force: true });
  }
});

test("CONTROL NEGATIVO: con la siembra APAGADA, el segundo turno sigue yendo entero", async () => {
  const home = mkdtempSync(join(tmpdir(), "cauce-home-sin-siembra-"));
  const previo = process.env.CAUCE_SEMBRAR_CONTEXTO;
  delete process.env.CAUCE_SEMBRAR_CONTEXTO;
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    await correrUnTurno(home, "zeus");
    const segundo = await correrUnTurno(home, "zeus");
    assert.ok(segundo.includes(PRIMARY_DUTY_HEADER), "recortó con la siembra apagada");
    assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false, "escribió el fichero estando apagada");
  } finally {
    if (previo !== undefined) process.env.CAUCE_SEMBRAR_CONTEXTO = previo;
    rmSync(home, { recursive: true, force: true });
  }
});

test("la TUI compartida recibe el perfil vivo en cada turno sin reiniciar su proceso", async () => {
  const home = mkdtempSync(join(tmpdir(), "cauce-home-shared-profile-"));
  const estado = mkdtempSync(join(tmpdir(), "cauce-shared-profile-state-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const path = join(home, ".claude", "CLAUDE.md");
  const profile = (purpose: string) => conBloqueDePerfil(
    "# Manual humano\n",
    `<!-- alias: Steven/zeus -->\n## Identidad y propósito\n\n${purpose}`,
  );
  writeFileSync(path, profile("perfil de la primera generación"), "utf8");

  const { runner, visto } = runnerEspia();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await DurableStore.open(estado),
    sharedSession: { alias: "zeus", harness: "claude", stateDirectory: estado },
  });
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const consumidos: { readonly documents: readonly { readonly path: string; readonly sha256: string }[] }[] = [];
    const run = () => adapter.execute({
      prompt: "Revisa el perfil.",
      context: contexto("zeus"),
      timeoutMs: 30_000,
      signal: AbortSignal.timeout(30_000),
      onRuntimeProfileConsumed: (profile) => consumidos.push(profile),
    });
    await run();
    writeFileSync(path, profile("perfil actualizado sin reiniciar la TUI"), "utf8");
    await run();

    assert.match(visto[0] ?? "", /BEGIN TRUSTED RUNTIME PROFILE/u);
    assert.match(visto[0] ?? "", /perfil de la primera generación/u);
    assert.match(visto[1] ?? "", /perfil actualizado sin reiniciar la TUI/u);
    assert.doesNotMatch(visto[1] ?? "", /perfil de la primera generación/u);
    assert.equal(consumidos.length, 2);
    assert.equal(consumidos[0]?.documents[0]?.path, path);
    assert.notEqual(consumidos[0].documents[0].sha256, consumidos[1]?.documents[0]?.sha256);
    assert.equal(
      consumidos[1]?.documents[0]?.sha256,
      createHash("sha256").update(profile("perfil actualizado sin reiniciar la TUI"), "utf8").digest("hex"),
    );
    // An old TUI does not accredit the fixed contract: it still travels in full.
    assert.match(visto[1] ?? "", new RegExp(PRIMARY_DUTY_HEADER, "u"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    rmSync(home, { recursive: true, force: true });
    rmSync(estado, { recursive: true, force: true });
  }
});

test("CONTROL NEGATIVO: HOME compartido no inyecta el bloque de otro alias", async () => {
  const home = mkdtempSync(join(tmpdir(), "cauce-home-shared-foreign-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      conBloqueDePerfil("", "<!-- alias: Steven/atlas -->\nperfil ajeno"),
      "utf8",
    );
    const estado = mkdtempSync(join(tmpdir(), "cauce-shared-foreign-state-"));
    const { runner, visto } = runnerEspia();
    const adapter = new HarnessAdapter({
      definition: HARNESS_DEFINITIONS.claude,
      runner,
      store: await DurableStore.open(estado),
      sharedSession: { alias: "zeus", harness: "claude", stateDirectory: estado },
    });
    const previousHome = process.env.HOME;
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      await adapter.execute({
        prompt: "x", context: contexto("zeus"), timeoutMs: 30_000,
        signal: AbortSignal.timeout(30_000),
      });
      assert.doesNotMatch(visto[0] ?? "", /perfil ajeno/u);
      assert.doesNotMatch(visto[0] ?? "", /BEGIN TRUSTED RUNTIME PROFILE/u);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      rmSync(estado, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
