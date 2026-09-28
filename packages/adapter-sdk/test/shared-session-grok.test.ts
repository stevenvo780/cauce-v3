import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { StructuredOutput } from "../src/sdk/types.js";
import { grokTranscript } from "../src/shared-session/grok.js";
import {
  adapterFor,
  assertExecutionPrevented,
  correlationIdFromPrompt,
  envelopeText,
  execute,
  expectSharedTuiUnavailable,
} from "./shared-session-fixtures.js";
import {
  GrokTmux,
  THINKING,
  grokFrame,
  grokRunner,
  grokWorkspace,
} from "./grok-shared-session-fixtures.js";

// ---------------------------------------------------------------------------------------------
// grok: the SAME paste mechanism; the answer comes out of `updates.jsonl` or the MCP deposit.
// ---------------------------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DEPOSIT: StructuredOutput = {
  reply: "depositado por cauce_reply", messages: [], notify: [], status: "done", retryable: false, artifacts: [],
};

test("grok: el turno del bus entra por la caja de la TUI y la respuesta final sale de updates.jsonl", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-turno-normal");
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    const correlation = correlationIdFromPrompt(text);
    await log.append(
      log.user(text),
      log.thought("p-bus"),
      // Narration before a tool is not the answer: only the text after the last tool is.
      log.message("p-bus", "Voy a revisar el estado antes de contestar."),
      log.tool("p-bus", "call-1", "run_terminal_command", { command: "uptime" }),
      log.toolDone("p-bus", "call-1"),
      log.message("p-bus", envelopeText("hola desde la TUI de grok", correlation)),
      log.completed("p-bus"),
    );
  };

  const runner = grokRunner({ grokHome, tmux });
  const adapter = await adapterFor(runner, state, "hades", "grok");
  const output = await execute(adapter);

  assert.equal(output.reply, "hola desde la TUI de grok");
  assert.equal(tmux.submittedCount, 1);
  assert.ok(tmux.calls.some((call) => call[0] === "paste-buffer" && call.includes("-p")),
    "el pedido entra como UN pegado entre corchetes, igual que en claude/codex");
  assert.equal(tmux.interruptedCount, 0);
  assert.equal(runner.takeDegradation(), undefined, "un turno propio no es un turno fundido");
});

test("grok: localiza el turno aunque el prompt quede envuelto en <user_query> y sin salto final", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-prompt-envuelto");
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await log.append(
      log.user(`<user_query>\n${text.replace(/\s+$/u, "")}\n</user_query>`),
      log.message("p-envuelto", envelopeText("envuelto y reconocido")),
      log.completed("p-envuelto"),
    );
  };

  const output = await execute(await adapterFor(grokRunner({ grokHome, tmux }), state, "hades", "grok"));

  assert.equal(output.reply, "envuelto y reconocido");
});

test("grok: la respuesta es el texto tras la última herramienta, y el turno posterior del dueño no la pisa", async () => {
  const { grokHome, log } = await grokWorkspace("grok-turno-ajeno");
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await log.append(
      log.user(text),
      log.message("p-bus", "Primero miro el disco."),
      log.tool("p-bus", "call-1", "run_terminal_command", { command: "df -h" }),
      log.toolDone("p-bus", "call-1"),
      log.message("p-bus", envelopeText("respuesta del bus")),
      log.completed("p-bus"),
      log.user("pregunta que el dueño tecleó después"),
      log.message("p-dueño", envelopeText("respuesta del dueño")),
      log.completed("p-dueño"),
    );
  };

  const outcome = await grokRunner({ grokHome, tmux }).run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal((JSON.parse(outcome.stdout) as { text: string }).text, envelopeText("respuesta del bus"));
});

test("grok: con la TUI generando NO pega (grok encolaría detrás del turno) y entra al quedar ociosa", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-fundido-espera");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "running", spinner: THINKING });
  let polls = 0;
  const sleep = async (): Promise<void> => {
    polls += 1;
    if (polls === 5) tmux.paneContent = grokFrame();
    await Promise.resolve();
  };
  let pastedWhileGenerating = false;
  tmux.onSubmit = async (text) => {
    pastedWhileGenerating = tmux.paneContent.includes("Ctrl+c");
    await log.append(log.user(text), log.message("p-bus", envelopeText("tras esperar")), log.completed("p-bus"));
  };

  const runner = grokRunner({ grokHome, tmux, sleep, acquireTimeoutMs: 5_000 });
  const output = await execute(await adapterFor(runner, state, "hades", "grok"));

  assert.equal(output.reply, "tras esperar");
  assert.equal(pastedWhileGenerating, false);
  assert.ok(polls >= 5, "tiene que haber esperado a que el turno en curso terminara");
});

test("grok: un pedido encolado detrás de un turno que ya corría se cosecha cuando grok lo ejecuta, sin cuarentena", async () => {
  // The owner's turn began right before the barrier: grok queues the paste and runs it as its own
  // turn when the other ends. With `startedTurn` undeclared the 20 ms inject deadline cannot kill it.
  const { state, grokHome, log } = await grokWorkspace("grok-fundido-encolado");
  const tmux = new GrokTmux();
  tmux.onSubmit = (text) => {
    tmux.paneContent = grokFrame({ footer: "queued", spinner: THINKING, queue: "pedido del bus" });
    void (async () => {
      await log.append(log.message("p-dueño", "sigo con lo del dueño"));
      await delay(120);
      await log.append(log.message("p-dueño", envelopeText("respuesta al dueño")), log.completed("p-dueño"));
      await log.append(log.user(text), log.message("p-bus", envelopeText("el encolado")), log.completed("p-bus"));
      tmux.paneContent = grokFrame();
    })();
  };

  const runner = grokRunner({ grokHome, tmux, sleep: delay, quarantineFile: join(state, "quarantine") });
  const output = await execute(await adapterFor(runner, state, "hades", "grok"));

  assert.equal(output.reply, "el encolado");
  assert.equal(runner.takeDegradation(), undefined);
});

test("grok: un depósito MCP sin texto final cierra la entrega en turn_completed, sin esperar silencio", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-deposito-mcp");
  let deposited: StructuredOutput | undefined;
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await log.append(
      log.user(text),
      log.tool("p-mcp", "cauce__cauce_reply", "use_tool", {
        tool_name: "cauce__cauce_reply",
        tool_input: { reply: DEPOSIT.reply, status: "done", retryable: false },
      }),
    );
    deposited = DEPOSIT;
    await log.append(log.toolDone("p-mcp", "cauce__cauce_reply"), log.completed("p-mcp"));
  };

  const adapter = await adapterFor(grokRunner({ grokHome, tmux, sleep: delay }), state, "hades", "grok");
  const started = Date.now();
  const output = await adapter.execute({
    prompt: "tarea por MCP", sessionKey: "auth-v2:prueba", timeoutMs: 5_000,
    signal: new AbortController().signal, emissionOutput: () => deposited,
  });

  assert.equal(output.reply, DEPOSIT.reply);
  assert.ok(Date.now() - started < 1_500, `retuvo la entrega ${String(Date.now() - started)} ms`);
});

test("grok: texto a medio escribir en la caja degrada sin pegar ni ejecutar nada", async () => {
  const { state, grokHome } = await grokWorkspace("grok-caja-ocupada");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "typed", box: "respondé solo: ho" });

  const runner = grokRunner({ grokHome, tmux });
  const error = await expectSharedTuiUnavailable(execute(await adapterFor(runner, state, "hades", "grok")));

  assert.match(error.message, /input_busy/u);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.submittedCount, 0);
});

test("grok: un turno que no termina nunca agota la espera propia de 'generando' (tui_generating), no la de la caja", async () => {
  const { grokHome } = await grokWorkspace("grok-siempre-generando");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "tool", spinner: THINKING });

  const runner = grokRunner({ grokHome, tmux });
  const outcome = await runner.run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assertExecutionPrevented(runner, outcome, "tui_generating");
  assert.match(outcome.stderr, /encolaría/u);
  assert.equal(tmux.submittedCount, 0);
});

test("grok: sin panel ni forma de crearlo NO hay ejecutor alternativo", async () => {
  const { state, grokHome } = await grokWorkspace("grok-pane-ausente");
  const tmux = new GrokTmux();
  tmux.sessionExists = false;
  tmux.newSessionFails = true;

  const runner = grokRunner({ grokHome, tmux });
  const error = await expectSharedTuiUnavailable(execute(await adapterFor(runner, state, "hades", "grok")));

  assert.match(error.message, /session_absent/u);
  assert.equal(tmux.submittedCount, 0);
});

test("grok: si la TUI muere en pleno turno la entrega termina con error, sin reintento a ciegas", async () => {
  const { grokHome, log } = await grokWorkspace("grok-pane-muere");
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.thought("p-bus"));
    await delay(20);
    tmux.sessionExists = false;
  };

  const outcome = await grokRunner({ grokHome, tmux }).run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.timedOut, false);
  assert.match(outcome.stderr, /desapareció o cambió/u);
});

test("grok: cancelar manda Ctrl+C (nunca Escape) sólo mientras el turno corre, y el cancelled lo cierra", async () => {
  const { grokHome, log } = await grokWorkspace("grok-cancela");
  const tmux = new GrokTmux();
  const controller = new AbortController();
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.thought("p-bus"));
    tmux.paneContent = grokFrame({ footer: "running", spinner: THINKING });
    controller.abort(new Error("cancelado por el bus"));
  };
  tmux.onInterrupt = async (key) => {
    assert.equal(key, "C-c");
    await log.append(log.completed("p-bus", "cancelled"));
    tmux.paneContent = grokFrame();
  };

  const outcome = await grokRunner({ grokHome, tmux, cancelDrainTimeoutMs: 1_000 }).run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000, signal: controller.signal,
  });

  assert.equal(outcome.cancelled, true);
  assert.deepEqual(tmux.interruptKeys, ["C-c"]);
  assert.match(outcome.stderr, /límite terminal/u);
});

test("grok: con la TUI ya ociosa la cancelación NO manda Ctrl+C (armaría la salida) y pone en cuarentena", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-cancela-ociosa");
  const tmux = new GrokTmux();
  const controller = new AbortController();
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text));
    controller.abort(new Error("cancelado por el bus"));
  };

  const outcome = await grokRunner({
    grokHome, tmux, cancelDrainTimeoutMs: 30, quarantineFile: join(state, "quarantine"),
  }).run({ command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000, signal: controller.signal });

  assert.equal(outcome.cancelled, true);
  assert.deepEqual(tmux.interruptKeys, []);
  assert.match(outcome.stderr, /cuarentena/u);
});

test("grok: un turno cortado por stop_reason distinto de end_turn es un fallo declarado", async () => {
  const { grokHome, log } = await grokWorkspace("grok-stop-reason");
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.message("p-bus", "a medias"), log.completed("p-bus", "max_tokens"));
  };

  const outcome = await grokRunner({ grokHome, tmux }).run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /max_tokens/u);
});

test("grok: el lector sólo lista updates.jsonl de carpetas de sesión, de todos los cwd y en orden temporal", async () => {
  const { grokHome, log, sessionLog } = await grokWorkspace("grok-listado");
  const older = await sessionLog("01a0cc55-12cc-71f0-884c-f9032608d0fd", "%2Fhome%2Fclaw%2Fclawd");
  await older.append(older.user("vieja"));
  const files = await grokTranscript(grokHome).files();

  assert.deepEqual(files.map((file) => file.slice(grokHome.length)), [
    "/sessions/%2Fhome%2Fclaw%2Fclawd/01a0cc55-12cc-71f0-884c-f9032608d0fd/updates.jsonl",
    `/sessions/%2Fhome%2Fclaw/${log.sessionId}/updates.jsonl`,
  ]);
});
