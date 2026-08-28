import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEGRADED_MARK, RESET_MARK } from "../src/shared-session/notice.js";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  FakeTmux,
  RecordingFallback,
  TmuxResult,
  adapterFor,
  assistantEntry,
  claudeRunner,
  envelopeText,
  execute,
  freshState,
  userEntry,
} from "./shared-session-fixtures.js";

// ---------------------------------------------------------------------------
// 1. El bus sigue produciendo el sobre, y lo hace a través de la TUI real.
// ---------------------------------------------------------------------------

test("el turno del bus produce el sobre completo cosechado del transcript", async () => {
  const { state, home, workspace } = await freshState("sobre");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    // El modelo responde envuelto en vallado Markdown, como se midió en la TUI de verdad.
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), userUuid, "```json\n" + envelopeText("desde la TUI") + "\n```", sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde la TUI");
  assert.equal(output.status, "done");
  assert.deepEqual(output.messages, []);
  // El sobre salió de la sesión compartida, no del camino de siempre.
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  for (const call of tmux.calls.filter((entry) =>
    entry[0] === "capture-pane" || entry[0] === "paste-buffer"
      || (entry[0] === "send-keys" && entry.includes("Enter")))) {
    const target = call[call.indexOf("-t") + 1];
    assert.equal(target, "%0", `operación no exacta: ${call.join(" ")}`);
  }
  // Y sin ningún aviso pegado: el turno sí pasó por la terminal.
  assert.ok(!(output.reply ?? "").includes(DEGRADED_MARK));
  assert.deepEqual(await readDegradations(state), []);
});

// ---------------------------------------------------------------------------
// 2. La TUI del dueño NO tiene que hablar el contrato del bus.
// ---------------------------------------------------------------------------

test("los turnos en prosa del dueño conviven con el sobre del bus", async () => {
  const { state, home, workspace } = await freshState("prosa");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  // Conversación previa del dueño: preguntas y respuestas en prosa, sin una sola llave.
  let head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "que tal vas?", sessionId)}\n`);
  const proseAnswer = randomUUID();
  await appendFile(file, `${assistantEntry(proseAnswer, head, "Bien, terminando el informe.", sessionId)}\n`);
  head = proseAnswer;

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("respuesta del bus"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // La prosa del dueño no rompió nada y no se coló como resultado del bus.
  assert.equal(output.reply, "respuesta del bus");
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// 3. Los dos ven el MISMO contexto: una sola rama, y se verifica la descendencia.
//    Esta es la prueba de regresión exacta de por qué la salida (a) quedó descartada.
// ---------------------------------------------------------------------------

test("no se cosecha una respuesta de una rama hermana", async () => {
  const { state, home, workspace } = await freshState("rama");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const shared = randomUUID();
  await appendFile(file, `${userEntry(shared, null, "cabeza comun", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    // Rama HERMANA: cuelga del mismo padre que nuestro turno, exactamente como pasaba con
    // `--print --resume` corriendo en paralelo a la TUI. No debe cosecharse jamás.
    const sibling = randomUUID();
    await appendFile(file, `${userEntry(sibling, shared, "otro pedido", sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), sibling, envelopeText("RAMA HERMANA"), sessionId)}\n`);
    // Nuestra rama, colgando de la cabeza de la propia TUI.
    const mine = randomUUID();
    await appendFile(file, `${userEntry(mine, shared, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), mine, envelopeText("MI RAMA"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "MI RAMA");
});

test("el turno del bus cuelga de la cabeza viva de la TUI, no de la raiz", async () => {
  const { state, home, workspace } = await freshState("cabeza");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const root = randomUUID();
  const head = randomUUID();
  await appendFile(file, `${userEntry(root, null, "primero", sessionId)}\n`);
  await appendFile(file, `${assistantEntry(head, root, "listo", sessionId)}\n`);

  let injectedParent: string | undefined;
  const tmux = new FakeTmux();
  tmux.onSubmit = async (text) => {
    // La TUI encadena desde su cabeza en memoria: eso es lo que da UNA sola rama.
    injectedParent = head;
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("ok"), sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback: new RecordingFallback("{}"),
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  await execute(adapter);
  assert.equal(injectedParent, head);
});

// ---------------------------------------------------------------------------
// 4. Escrituras simultáneas: el bus NUNCA escribe encima del dueño.
// ---------------------------------------------------------------------------

test("con la caja ocupada el bus espera y no pega nada", async () => {
  const { state, home, workspace } = await freshState("ocupada");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ estoy escribiendo algo a medias";
  let releases = 0;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (args[0] === "capture-pane") {
      releases += 1;
      // El dueño suelta la línea al tercer sondeo.
      if (releases >= 3) tmux.paneContent = "❯ ";
      // Antes de soltarla no se pudo haber pegado nada.
      if (releases < 3) assert.equal(tmux.pasted, undefined);
    }
    return originalRun(args, stdin);
  };
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("tras esperar"), sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback: new RecordingFallback("{}"),
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "tras esperar");
  assert.ok(releases >= 3, "tuvo que sondear hasta que la caja quedo libre");
});

test("una caja que nunca se libera degrada con aviso y sin inyectar", async () => {
  const { state, home, workspace } = await freshState("nunca-libre");
  const tmux = new FakeTmux();
  tmux.paneContent = "❯ el dueno dejo esto a medias";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("por el camino viejo") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // Nunca se tocó la caja del dueño.
  assert.equal(tmux.pasted, undefined);
  assert.equal(tmux.submittedCount, 0);
  // Se respondió, pero DICIÉNDOLO.
  assert.equal(fallback.calls, 1);
  assert.ok((output.reply ?? "").includes(DEGRADED_MARK));
  assert.ok((output.reply ?? "").includes("input_busy"));
  assert.ok((output.reply ?? "").includes("por el camino viejo"));
});

// ---------------------------------------------------------------------------
// 5. El mecanismo caído SE AVISA. Es donde murió el intento anterior.
// ---------------------------------------------------------------------------

test("sin sesion compartida se responde igual pero el aviso viaja en el reply", async () => {
  const { state, home, workspace } = await freshState("caido");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.newSessionFails = true;
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("respuesta clasica") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(fallback.calls, 1);
  const reply = output.reply ?? "";
  assert.ok(reply.includes(DEGRADED_MARK), "el aviso tiene que llegar por Telegram");
  assert.ok(reply.includes("session_absent"));
  assert.ok(reply.includes("cauce kratos"), "tiene que decir como restablecerlo");
  assert.ok(reply.includes("respuesta clasica"), "la respuesta real no se pierde");

  // Y queda registrado de forma durable, que es lo que `cauce <alias>` muestra al entrar.
  const records = await readDegradations(state);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.reason, "session_absent");
  assert.equal(records[0]?.alias, "kratos");
  assert.equal(records[0]?.fellBack, true);

  // No existe un `$N` acreditado al cual avisar. Apuntar por nombre acá abriría una carrera:
  // una sesión homónima creada después del preflight recibiría un aviso que no le pertenece.
  // El aviso durable del reply/registro de arriba es la única superficie segura en este caso.
  assert.equal(tmux.used("display-message"), false);
  assert.equal(tmux.used("set-option"), false);
  // Pero SIN renombrar la ventana. Ver la prueba de enclavamiento de más abajo.
  assert.equal(tmux.used("rename-window"), false);
});

test("una TUI reiniciada avisa aunque el turno si pase por la terminal", async () => {
  const { state, home, workspace } = await freshState("reinicio");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("sigo aca"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  await execute(adapter);

  // claude se auto-actualiza y se relanza: el panel pasa a ser otro proceso.
  tmux.panePid = "9999";
  const second = await execute(adapter, "segundo");

  const reply = second.reply ?? "";
  assert.ok(reply.includes(RESET_MARK), "el reinicio se tiene que ver");
  assert.ok(reply.includes("context_reset"));
  assert.ok(reply.includes("sigo aca"), "el turno si paso por la terminal");
  assert.equal(fallback.calls, 0, "un reinicio NO es motivo para caer al camino viejo");
});
