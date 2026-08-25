/**
 * El pegado que se FUNDE con un turno en curso, y por qué mataba entregas ya terminadas.
 *
 * Cuando el panel está ocupado generando, claude no abre un turno propio para lo que se le pega: lo
 * ENCOLA y lo funde en el turno que ya está corriendo (`queue-operation enqueue` y, unos segundos
 * después, `remove`). Entonces NO existe ninguna entrada de usuario con el texto que pegamos, y la
 * correlación por ascendencia —localizar esa entrada y exigir que la respuesta descienda de ella— no
 * puede enganchar jamás, por mucho presupuesto que se le dé.
 *
 * Lo que costaba, medido en la entrega `6c7cb0c4` (janus -> kratos): ejecución 04:14:27.49, muerta
 * 04:19:28.89 = 301 s exactos, «Harness exceeded its execution deadline», sin reintento. Y el
 * trabajo ESTABA HECHO: kratos escribió el entregable completo a las 04:17 y emitió su sobre a las
 * 04:17:52, noventa y seis segundos antes de que la declararan muerta. El bug no perdía tiempo:
 * descartaba trabajo terminado y hacía que alguien lo mandara a rehacer.
 *
 * De ahí la regla que fijan estas pruebas: la ascendencia es un DESEMPATE, el sobre es la PRUEBA. Si
 * el sobre apareció después del pegado, la entrega no muere. Las tres primeras fallan contra el
 * código anterior; la cuarta es la guarda que impide que el arreglo se coma la red de los 5 min y
 * devuelva el lock retenido 24 h.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { claudeDefinition } from "../src/harnesses/index.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import type { TmuxController, TmuxResult } from "../src/shared-session/tmux.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { MERGED_MARK } from "../src/shared-session/notice.js";
import { isEnvelopeText } from "../src/shared-session/envelope.js";
import { turnInFlight } from "../src/shared-session/pane.js";
import {
  claudeTranscript,
  findEnvelopeTurn,
  type TranscriptEntry,
} from "../src/shared-session/transcript.js";
import { transcriptDirectory } from "../src/shared-session/session.js";

const stateRoot = resolve(".test-state/shared-session-turn-merge");

function envelopeText(reply: string): string {
  return JSON.stringify({
    reply,
    messages: [] as const,
    status: "done" as const,
    retryable: false,
    artifacts: [] as const,
  });
}

async function freshState(name: string): Promise<{ state: string; home: string; workspace: string }> {
  const directory = join(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  const home = join(directory, "home");
  const workspace = "/workspace";
  await mkdir(transcriptDirectory(home, workspace), { recursive: true });
  await mkdir(directory, { recursive: true });
  return { state: directory, home, workspace };
}

function userEntry(uuid: string, parentUuid: string | null, text: string, sessionId: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid, isSidechain: false, sessionId,
    promptSource: "typed", message: { role: "user", content: text },
  });
}

function assistantEntry(
  uuid: string,
  parentUuid: string,
  text: string,
  sessionId: string,
  stopReason = "end_turn",
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid, isSidechain: false, sessionId,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
}

class FakeTmux implements TmuxController {
  paneContent = "❯ ";
  pasted: string | undefined;
  submittedCount = 0;
  onSubmit: ((text: string) => Promise<void> | void) | undefined;

  async run(args: readonly string[], stdin?: string): Promise<TmuxResult> {
    const [command] = args;
    if (command === "has-session") return ok(0);
    if (command === "list-windows") return { exitCode: 0, stdout: "agente\n", stderr: "" };
    if (command === "capture-pane") return { exitCode: 0, stdout: this.paneContent, stderr: "" };
    if (command === "display-message" && args[1] === "-p") {
      return { exitCode: 0, stdout: "4242\n", stderr: "" };
    }
    if (command === "load-buffer") {
      this.pasted = stdin ?? "";
      return ok(0);
    }
    if (command === "send-keys" && args.includes("Enter")) {
      this.submittedCount += 1;
      const text = this.pasted;
      if (text !== undefined && this.onSubmit !== undefined) await this.onSubmit(text);
      return ok(0);
    }
    return ok(0);
  }
}

function ok(exitCode: number): TmuxResult {
  return { exitCode, stdout: "", stderr: "" };
}

class RecordingFallback implements CommandRunner {
  calls = 0;
  run(_request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    return Promise.resolve({
      stdout: "{}", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false,
    });
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve_) => setTimeout(resolve_, ms));

function claudeRunner(options: {
  alias: string;
  home: string;
  workspace: string;
  tmux: FakeTmux;
  fallback: CommandRunner;
  correlationTimeoutMs?: number;
  quietTimeoutMs?: number;
  mergedGraceMs?: number;
  turnTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): PasteSessionRunner<TranscriptEntry> {
  return new PasteSessionRunner({
    alias: options.alias,
    harness: "claude",
    workspace: options.workspace,
    transcript: claudeTranscript(join(options.home, ".claude"), options.workspace),
    tmux: options.tmux,
    fallback: options.fallback,
    sleep: options.sleep ?? (() => Promise.resolve()),
    acquireTimeoutMs: 30,
    turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    ...(options.correlationTimeoutMs === undefined
      ? {}
      : { correlationTimeoutMs: options.correlationTimeoutMs }),
    ...(options.quietTimeoutMs === undefined ? {} : { quietTimeoutMs: options.quietTimeoutMs }),
    ...(options.mergedGraceMs === undefined ? {} : { mergedGraceMs: options.mergedGraceMs }),
  });
}

async function adapterFor(
  runner: CommandRunner,
  state: string,
  alias: string,
): Promise<HarnessAdapter> {
  const store = await DurableStore.open(join(state, "store"));
  return new HarnessAdapter({
    definition: claudeDefinition,
    runner,
    store,
    sessionNamespace: alias,
    sharedSession: { alias, harness: "claude", stateDirectory: state },
  });
}

function execute(adapter: HarnessAdapter, timeoutMs = 10_000): Promise<{
  reply: string | null;
  status: string;
}> {
  return adapter.execute({
    prompt: "hola",
    sessionKey: "auth-v2:prueba",
    timeoutMs,
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// (a) El pegado se FUNDE con el turno en curso: no hay turno propio del que descender.
// ---------------------------------------------------------------------------

test("una entrega cuyo pegado se fundió con el turno en curso se cosecha del sobre", async () => {
  const { state, home, workspace } = await freshState("fusion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  // El dueño tecleó en el panel un momento antes (04:14:01 en la entrega real) y ese turno está en
  // marcha: por eso la caja está libre —claude la vacía mientras genera— y el pegado se encola.
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "seguí con el informe", sessionId)}\n`);

  const tmux = new FakeTmux();
  // La línea de estado de una TUI que está GENERANDO. La caja está vacía y el arbitraje la ve libre.
  tmux.paneContent = "✻ Herding… (esc to interrupt · ctrl+t to hide todos)\n❯ ";
  const fallback = new RecordingFallback();
  tmux.onSubmit = async () => {
    // La fusión, tal cual: NO se escribe ninguna entrada de usuario con el texto que pegamos. El
    // turno del dueño sigue y termina contestando las dos cosas a la vez, con su sobre.
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), duenio, envelopeText("el entregable"), sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos");
  const output = await execute(adapter);

  // Contra el código anterior esto no llegaba nunca: la correlación no enganchaba, y a los 300 s
  // salía «Harness exceeded its execution deadline».
  assert.equal(output.status, "done");
  assert.ok((output.reply ?? "").includes("el entregable"), output.reply ?? "(null)");
  // El turno pasó por la terminal: no se cayó al camino de siempre y no se ejecutó dos veces.
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  // Y se DICE que fue un turno fundido: la respuesta puede estar contestando dos pedidos a la vez.
  assert.ok((output.reply ?? "").includes(MERGED_MARK), output.reply ?? "(null)");
});

// ---------------------------------------------------------------------------
// (b) El sobre llega DESPUÉS del plazo de correlación. La terminal no estuvo callada ni un momento.
// ---------------------------------------------------------------------------

test("el sobre que llega pasado el plazo de correlación cierra la entrega igual", async () => {
  const { state, home, workspace } = await freshState("tarde");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "seguí con el informe", sessionId)}\n`);

  const tmux = new FakeTmux();
  tmux.paneContent = "✻ Herding… (esc to interrupt)\n❯ ";
  const fallback = new RecordingFallback();

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    // El plazo de correlación vence enseguida —como los 300 s de la entrega real frente a un turno
    // que tardó más— pero la terminal SIGUE escribiendo, así que no hay nada que dar por perdido.
    correlationTimeoutMs: 50,
    quietTimeoutMs: 1_000,
    turnTimeoutMs: 20_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos");

  tmux.onSubmit = () => {
    // El turno del dueño sigue trabajando: herramientas, pasos intermedios. Nada de esto es un
    // sobre, y ninguna de estas entradas es la nuestra.
    void (async () => {
      for (let paso = 0; paso < 10; paso += 1) {
        await delay(20);
        await appendFile(
          file,
          `${assistantEntry(randomUUID(), duenio, `paso ${paso}`, sessionId, "tool_use")}\n`,
        );
      }
      // Y recién ahora, muy pasado el plazo de correlación, el sobre.
      await appendFile(
        file,
        `${assistantEntry(randomUUID(), duenio, envelopeText("tarde pero entero"), sessionId)}\n`,
      );
    })();
  };

  const output = await execute(adapter, 30_000);

  assert.equal(output.status, "done");
  assert.ok((output.reply ?? "").includes("tarde pero entero"), output.reply ?? "(null)");
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// (c) El caso sano: correlación por ascendencia, y NINGÚN aviso de turno fundido.
// ---------------------------------------------------------------------------

test("el turno que sí abre turno propio se cosecha por ascendencia y sin aviso", async () => {
  const { state, home, workspace } = await freshState("sano");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback();
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), userUuid, envelopeText("desde la TUI"), sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos");
  const output = await execute(adapter);

  assert.equal(output.status, "done");
  assert.equal(output.reply, "desde la TUI");
  assert.equal(fallback.calls, 0);
  // Nada de avisos: la correlación funcionó como siempre.
  assert.ok(!(output.reply ?? "").includes(MERGED_MARK));
});

// ---------------------------------------------------------------------------
// (d) Guarda: el pegado PERDIDO de verdad sigue soltando la sesión rápido.
// ---------------------------------------------------------------------------

test("el pegado perdido sin ninguna actividad sigue soltando la sesión como ambiguo", async () => {
  const { state, home, workspace } = await freshState("perdido");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  await appendFile(file, `${userEntry(randomUUID(), null, "algo viejo", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback();
  // El pegado se perdió: la TUI no escribe absolutamente nada.
  tmux.onSubmit = () => undefined;

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    // Presupuesto larguísimo a propósito: lo que tiene que soltar la sesión es la red, no el plazo.
    turnTimeoutMs: 600_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos");

  const empezo = Date.now();
  await assert.rejects(
    execute(adapter, 600_000),
    (error: Error) => /execution deadline/iu.test(error.message),
  );
  // Y rápido: la red no se puede haber quedado esperando el presupuesto entero.
  assert.ok(Date.now() - empezo < 30_000, `tardó ${Date.now() - empezo} ms`);
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// (e) Guarda: la espera por un turno fundido tiene un final escrito aunque la terminal no calle.
// ---------------------------------------------------------------------------

test("la espera por un turno fundido termina en su techo, no en el presupuesto", async () => {
  const { state, home, workspace } = await freshState("techo");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "seguí", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback();
  let escribiendo = true;
  tmux.onSubmit = () => {
    // La terminal no se calla NUNCA, y nunca emite un sobre: el pegado se perdió de verdad y lo que
    // se ve es al dueño trabajando en su panel. Sin techo, esto esperaría toda su jornada.
    void (async () => {
      while (escribiendo) {
        await delay(5);
        await appendFile(
          file,
          `${assistantEntry(randomUUID(), duenio, "sigo en lo mío", sessionId, "tool_use")}\n`,
        );
      }
    })();
  };

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 60_000,
    mergedGraceMs: 200,
    turnTimeoutMs: 600_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos");

  const empezo = Date.now();
  try {
    await assert.rejects(
      execute(adapter, 600_000),
      (error: Error) => /execution deadline/iu.test(error.message),
    );
  } finally {
    escribiendo = false;
  }
  assert.ok(Date.now() - empezo < 30_000, `tardó ${Date.now() - empezo} ms`);
});

// ---------------------------------------------------------------------------
// Las piezas, por separado.
// ---------------------------------------------------------------------------

test("un sobre se reconoce por su forma, y una respuesta en prosa no", () => {
  assert.equal(isEnvelopeText(envelopeText("hecho")), true);
  assert.equal(isEnvelopeText("```json\n" + envelopeText("hecho") + "\n```"), true);
  assert.equal(isEnvelopeText('{"reply":null,"messages":[],"status":"failed","retryable":true}'), true);
  assert.equal(isEnvelopeText("listo, ya lo dejé andando"), false);
  assert.equal(isEnvelopeText('{"reply":"x"}'), false);
  assert.equal(isEnvelopeText('{"reply":"x","messages":[],"status":"otra"}'), false);
  assert.equal(isEnvelopeText('{"reply":"x","messages":{},"status":"done"}'), false);
  assert.equal(isEnvelopeText(undefined), false);
});

test("el sobre se localiza sin ascendencia, y un mensaje intermedio no cuenta", () => {
  const sessionId = randomUUID();
  const duenio = randomUUID();
  const entries = [
    JSON.parse(userEntry(duenio, null, "seguí", sessionId)),
    JSON.parse(assistantEntry(randomUUID(), duenio, envelopeText("a medias"), sessionId, "tool_use")),
    JSON.parse(assistantEntry(randomUUID(), duenio, envelopeText("el entregable"), sessionId)),
  ] as TranscriptEntry[];
  const found = findEnvelopeTurn(entries);
  assert.equal(found?.text, envelopeText("el entregable"));
  assert.equal(found?.sessionId, sessionId);

  // Un subagente escribe en el mismo fichero y no puede contar como el sobre del turno.
  const sidechain = [{
    ...JSON.parse(assistantEntry(randomUUID(), duenio, envelopeText("de un subagente"), sessionId)),
    isSidechain: true,
  }] as TranscriptEntry[];
  assert.equal(findEnvelopeTurn(sidechain), undefined);
});

test("la línea de estado de una TUI generando se distingue del texto de la conversación", () => {
  // claude la dibuja justo ENCIMA de la caja; codex, justo debajo. Las dos cuentan.
  assert.equal(turnInFlight("✻ Herding… (esc to interrupt · ctrl+t to hide todos)\n❯ "), true);
  assert.equal(turnInFlight("› \nEsc to interrupt\n"), true);
  assert.equal(turnInFlight("❯ "), false);
  assert.equal(turnInFlight("✻ Herding… (esc to interrupt)\n❯ \n\n\n"), true);
  // La frase LEJOS de la caja es conversación, no estado: si contara, un agente hablando de este
  // mismo mecanismo dejaría el panel marcado como ocupado para siempre.
  const relleno: string[] = new Array<string>(20).fill("blah");
  const conversacion = ["el truco es mirar 'esc to interrupt'", ...relleno, "❯ "];
  assert.equal(turnInFlight(conversacion.join("\n")), false);
  assert.equal(turnInFlight(undefined), false);
});
