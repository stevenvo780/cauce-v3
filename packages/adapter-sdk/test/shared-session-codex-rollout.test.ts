import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { CommandRunner } from "../src/sdk/types.js";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { CONTEXT_MARK } from "../src/shared-session/notice.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { codexTranscript, rolloutSessionId, type RolloutLine } from "../src/shared-session/rollout.js";
import {
  FakeTmux,
  RecordingFallback,
  TmuxResult,
  adapterFor,
  claudeRunner,
  correlationIdFromPrompt,
  envelopeText,
  execute,
  freshState,
  randomUUID,
} from "./shared-session-fixtures.js";

// ---------------------------------------------------------------------------
// codex: el MISMO mecanismo, y el sobre sale de su rollout.
// ---------------------------------------------------------------------------

const immediate = (): Promise<void> => Promise.resolve();

/**
 * Una línea de rollout con el formato generado por codex.
 */
function rolloutLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
}

function codexStarted(turnId: string): string {
  return rolloutLine("event_msg", { type: "task_started", turn_id: turnId });
}

/** El pedido, tal como lo registra codex: `response_item` de rol `user` CON su `turn_id`. */
function codexUser(text: string, turnId: string): string {
  return rolloutLine("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

/** El cierre del turno, que trae el desenlace Y la respuesta final, los dos con `turn_id`. */
function codexComplete(turnId: string, text: string): string {
  return rolloutLine("event_msg", {
    type: "task_complete", turn_id: turnId, last_agent_message: text,
  });
}

function codexAborted(turnId: string): string {
  return rolloutLine("event_msg", {
    type: "turn_aborted", turn_id: turnId, reason: "interrupted",
  });
}

async function codexWorkspace(name: string): Promise<{
  state: string;
  codexHome: string;
  rollout: string;
  sessionId: string;
}> {
  const { state, home } = await freshState(name);
  const codexHome = join(home, ".codex");
  const day = join(codexHome, "sessions", "2026", "07", "31");
  await mkdir(day, { recursive: true });
  const sessionId = randomUUID();
  // El nombre lleva el session_id, que es de donde sale la sesión observada sin abrir el fichero.
  const rollout = join(day, `rollout-2026-07-31T16-33-07-${sessionId}.jsonl`);
  await appendFile(rollout, `${rolloutLine("session_meta", { session_id: sessionId })}\n`);
  return { state, codexHome, rollout, sessionId };
}

function codexRunner(
  options: { alias: string; codexHome: string; tmux: FakeTmux; fallback: CommandRunner },
): PasteSessionRunner<RolloutLine> {
  options.tmux.sessionName = `cauce-${options.alias}`;
  if (options.tmux.sessionOptions.size === 0) options.tmux.paneStartCommand = "exec codex";
  return new PasteSessionRunner({
    alias: options.alias,
    harness: "codex",
    workspace: "/workspace",
    transcript: codexTranscript(options.codexHome),
    tmux: options.tmux,
    fallback: options.fallback,
    sleep: immediate,
    acquireTimeoutMs: 30,
    turnTimeoutMs: 2_000,
    injectTimeoutMs: 20,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
  });
}

test("el turno del bus entra por la caja de codex y el sobre sale de su rollout", async () => {
  const { state, codexHome, rollout, sessionId } = await codexWorkspace("codex-sobre");
  const tmux = new FakeTmux();
  // La caja de codex se dibuja con `›`, no con `❯`.
  tmux.paneContent = "› ";
  const fallback = new RecordingFallback("{}");
  const turnId = "019fb910-ddd9-7d80-af14-8cb69357d917";
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted(turnId),
      codexUser(text, turnId),
      codexComplete(turnId, envelopeText("desde codex")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde codex");
  assert.equal(fallback.calls, 0);
  // El pedido entró por la caja de entrada, entre corchetes y como UNA sola entrada.
  assert.ok(tmux.used("load-buffer"));
  assert.ok(tmux.calls.some((call) => call[0] === "paste-buffer" && call.includes("-p")));
  assert.equal(tmux.submittedCount, 1);
  // Y la conversación observada es la del rollout, que es la que reanudaría el camino de siempre.
  assert.equal(rolloutSessionId(rollout), sessionId);
});

test("codex ignora un rollout headless ajeno y rescata sólo el sobre con su nonce", async () => {
  const { state, codexHome, rollout } = await codexWorkspace("codex-multifile-headless");
  const headlessSessionId = randomUUID();
  const headless = join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "31",
    `rollout-2026-07-31T16-34-00-${headlessSessionId}.jsonl`,
  );
  await appendFile(
    headless,
    `${rolloutLine("session_meta", { session_id: headlessSessionId })}\n`,
  );
  const tmux = new FakeTmux();
  tmux.paneContent = "› \nEsc to interrupt\n";
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(
      headless,
      `${codexComplete("headless", envelopeText("RESPUESTA HEADLESS"))}\n`,
    );
    await appendFile(
      rollout,
      `${codexComplete(
        "fundido",
        envelopeText("RESPUESTA TUI", correlationIdFromPrompt(text)),
      )}\n`,
    );
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("RESPUESTA TUI"));
  assert.ok(!(output.reply ?? "").includes("RESPUESTA HEADLESS"));
  assert.equal(fallback.calls, 0);
});

test("codex recorta el salto final al enviar y aun así se reconoce el turno", async () => {
  // Cuando el harness recorta el newline final al registrar el prompt, el runner debe reconocer igualmente el turno.
  const { state, codexHome, rollout } = await codexWorkspace("codex-recorte");
  const tmux = new FakeTmux();
  tmux.paneContent = "› ";
  const fallback = new RecordingFallback("{}");
  const turnId = "019fb92d-2577-7c12-a243-7152c7e05bce";
  tmux.onSubmit = async (text) => {
    // Exactamente lo que hace la caja de codex: recorta el blanco final.
    assert.ok(/\s$/u.test(text), "el prompt de protocolo tiene que llegar con blanco al final");
    await appendFile(rollout, `${[
      codexStarted(turnId),
      codexUser(text.replace(/\s+$/u, ""), turnId),
      codexComplete(turnId, envelopeText("recortado y reconocido")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "recortado y reconocido");
  // Lo que importa: NO degradó al camino de siempre y NO se comió el presupuesto.
  assert.equal(fallback.calls, 0);
});

test("el turno del dueño no puede cortar la cosecha del turno del bus", async () => {
  // El rollout es COMPARTIDO: mientras corre el turno del bus, el dueño puede lanzar el suyo desde
  // el panel. Sin filtrar por `turn_id`, su `task_complete` cerraría la cosecha y el bus se
  // llevaría la respuesta ajena.
  const { state, codexHome, rollout } = await codexWorkspace("codex-turno-ajeno");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted("turno-del-bus"),
      codexUser(text, "turno-del-bus"),
      codexStarted("turno-del-dueño"),
      codexUser("lo que escribió el dueño", "turno-del-dueño"),
      codexComplete("turno-del-dueño", envelopeText("RESPUESTA AJENA")),
      codexComplete("turno-del-bus", envelopeText("MI RESPUESTA")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "MI RESPUESTA");
  assert.equal(fallback.calls, 0);
});

test("codex avisa cuando compacta durante el turno", async () => {
  const { state, codexHome, rollout } = await codexWorkspace("codex-compactacion");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted("t1"),
      codexUser(text, "t1"),
      // Forma real: el aviso de compactación de codex NO trae ningún campo, ni cifras ni id.
      rolloutLine("event_msg", { type: "context_compacted" }),
      codexComplete("t1", envelopeText("respondido tras compactar")),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.ok(reply.includes("respondido tras compactar"));
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_compacted"));
  assert.equal(fallback.calls, 0);
  assert.equal((await readDegradations(state))[0]?.fellBack, false);
});

test("Enter aceptado sin startedTurn queda ambiguo y bloquea un segundo pegado", async () => {
  // Aceptar Enter es el commit: que el rollout todavía no lo haya registrado NO prueba que no
  // corrió. El antiguo fallback podía ejecutar el mismo pedido dos veces y liberar el mismo pane.
  const { state: _state, codexHome } = await codexWorkspace("codex-sin-registro");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  // El Enter no produce nada: el rollout no crece.
  tmux.onSubmit = undefined;

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const first = await runner.run({
    command: "codex",
    args: [],
    harness: "codex",
    stdin: "pedido que pudo arrancar",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(first.timedOut, true);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /paste\+Enter.*cuarentena/u);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  const second = await runner.run({
    command: "codex",
    args: [],
    harness: "codex",
    stdin: "no reutilizar la generación ambigua",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  assert.equal(second.cancelled, false);
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1, "el segundo pedido no entra en el pane ambiguo");
});

test("un turno que el dueño interrumpe no se cobra como respuesta", async () => {
  // Sin esto el runner espera el presupuesto entero por una respuesta que ya nadie va a escribir, y
  // el dueño ve un agente mudo durante los 30 minutos del plazo de ACK.
  const { state, codexHome, rollout } = await codexWorkspace("codex-interrumpido");
  void state;
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(rollout, `${[
      codexStarted("t1"),
      codexUser(text, "t1"),
      codexAborted("t1"),
    ].join("\n")}\n`);
  };

  const runner = codexRunner({ alias: "socrates", codexHome, tmux, fallback });
  const outcome = await runner.run({
    command: "codex",
    args: [],
    harness: "codex",
    stdin: "pedido del bus",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /se interrumpió/u);
  // Y NO se reintenta por el camino de siempre: el turno sí entró en la terminal.
  assert.equal(fallback.calls, 0);
});

test("cancelar durante el preflight corta después del await y no ejecuta ningún camino", async () => {
  const { home, workspace } = await freshState("abort-preflight");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const controller = new AbortController();
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "list-sessions") controller.abort();
    return response;
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no ejecutar",
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.harnessStarted, false);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.calls.some((call) => call.includes("Enter")), false);
});
