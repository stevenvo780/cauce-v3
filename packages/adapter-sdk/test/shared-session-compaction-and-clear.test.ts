import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { CONTEXT_MARK, DEGRADED_MARK, RESET_MARK } from "../src/shared-session/notice.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  descendsFrom,
  findFinalAssistant,
  indexByUuid,
  type TranscriptEntry,
} from "../src/shared-session/transcript.js";
import {
  FakeTmux,
  RecordingFallback,
  adapterFor,
  assistantEntry,
  claudeRunner,
  envelopeText,
  execute,
  freshState,
  randomUUID,
  userEntry,
} from "./shared-session-fixtures.js";

// ---------------------------------------------------------------------------
// Casos de prueba de compactación de conversación y límites de contexto.
// ---------------------------------------------------------------------------

/** Una compactación real, con la forma exacta que escribe claude 2.1.220. */
function boundaryEntry(
  uuid: string,
  logicalParentUuid: string,
  trigger: "auto" | "manual",
  preTokens: number,
  postTokens: number,
): string {
  return JSON.stringify({
    type: "system", subtype: "compact_boundary", uuid, parentUuid: null, logicalParentUuid,
    isSidechain: false, content: "Conversation compacted", level: "info",
    compactMetadata: {
      trigger, preTokens, postTokens,
      cumulativeDroppedTokens: preTokens - postTokens, durationMs: 153_352,
    },
  });
}

function parseEntries(...lines: readonly string[]): readonly TranscriptEntry[] {
  return lines.map((line) => JSON.parse(line) as TranscriptEntry);
}

test("la cosecha atraviesa una compactación a mitad de turno", () => {
  // El fallo medido: una compactación CORTA la cadena de padres —el `compact_boundary` trae
  // `parentUuid: null` y la continuidad sólo vive en `logicalParentUuid`— y además REEMITE el
  // segmento preservado con los MISMOS uuid recolgados del resumen (1.873 uuid repetidos en un
  // transcript real de 13.976 entradas). Con cualquiera de las dos cosas sin tratar,
  // `findFinalAssistant` devuelve `undefined`: el runner no cosecha nunca, agota una hora de
  // presupuesto y entrega AMBIGUO. El agente contestó y el dueño ve una entrega muerta.
  const inj = "11111111-1111-4111-8111-111111111111";
  const a1 = "22222222-2222-4222-8222-222222222222";
  const leaf = "33333333-3333-4333-8333-333333333333";
  const boundary = "44444444-4444-4444-8444-444444444444";
  const summary = "55555555-5555-4555-8555-555555555555";
  const final = "66666666-6666-4666-8666-666666666666";
  const sid = "sesion-1";

  const entries = parseEntries(
    userEntry(inj, null, "pedido del bus", sid),
    assistantEntry(a1, inj, "voy a mirar", sid, "tool_use"),
    userEntry(leaf, a1, "resultado de la herramienta", sid),
    boundaryEntry(boundary, leaf, "auto", 767_812, 12_269),
    userEntry(summary, boundary, "resumen de la conversación", sid),
    // La copia REEMITIDA del segmento preservado: mismo uuid, otro padre.
    userEntry(leaf, summary, "resultado de la herramienta", sid),
    assistantEntry(final, summary, envelopeText("tras compactar"), sid),
  );

  const answer = findFinalAssistant(entries, inj);
  assert.notEqual(answer, undefined);
  assert.ok((answer?.text ?? "").includes("tras compactar"));

  // Y las dos piezas por separado, para que se vea qué sostiene qué.
  const byUuid = indexByUuid(entries);
  assert.equal(byUuid.get(leaf)?.parentUuid, a1, "el índice se queda con la PRIMERA aparición");
  assert.equal(descendsFrom(byUuid, entries[6]!, inj), true);
});

test("una compactación durante el turno se cosecha Y se avisa con sus cifras", async () => {
  const { state, home, workspace } = await freshState("compactacion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const injected = randomUUID();
    const leaf = randomUUID();
    const boundary = randomUUID();
    const summary = randomUUID();
    await appendFile(file, `${userEntry(injected, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(leaf, injected, "trabajando", sessionId, "tool_use")}\n`);
    await appendFile(file, `${boundaryEntry(boundary, leaf, "auto", 767812, 12269)}\n`);
    await appendFile(file, `${userEntry(summary, boundary, "resumen", sessionId)}\n`);
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), summary, envelopeText("respondido tras compactar"), sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  // 1. La entrega NO se pierde.
  assert.ok(reply.includes("respondido tras compactar"));
  assert.equal(fallback.calls, 0, "compactar no es motivo para caer al camino viejo");
  // 2. Y el remitente se entera de que la memoria ya no es la que cree, con las cifras del evento.
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_compacted"));
  assert.ok(reply.includes("auto"));
  assert.ok(reply.includes("767812"), "las cifras las trae el propio evento");
  assert.ok(reply.includes("12269"));
  // 3. Y el dueño también, en su panel, sin teñirlo de rojo (no es una caída).
  assert.ok(tmux.calls.some((call) =>
    call[0] === "display-message" && call.some((part) => part.includes("context_compacted"))));
  assert.equal(
    tmux.calls.some((call) => call[0] === "set-option" && call.includes("status-style")
      && call.includes("bg=red,fg=white")),
    false,
  );
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "context_compacted");
  assert.equal(records[0]?.fellBack, false);
});

test("un /clear del dueño se dice en la respuesta en vez de mentir", async () => {
  // Medido: `/clear` cierra el `.jsonl` y abre otro con sessionId nuevo, sin marcar el viejo y SIN
  // reiniciar el proceso (`pane_pid` idéntico), así que el heurístico de PID no lo ve jamás. La
  // cosecha seguía funcionando perfecta: el bus entregaba una respuesta impecable producida por un
  // contexto vacío, con cero señal en ninguna superficie.
  const { state, home, workspace } = await freshState("clear");
  const directory = transcriptDirectory(home, workspace);
  const primera = randomUUID();
  const segunda = randomUUID();
  let sessionId = primera;

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const file = join(directory, `${sessionId}.jsonl`);
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("respondido"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const first = await execute(adapter);
  assert.ok(!(first.reply ?? "").includes(CONTEXT_MARK), "el primer turno no puede avisar de nada");

  // El dueño teclea /clear: fichero nuevo, sessionId nuevo, MISMO proceso en el panel.
  sessionId = segunda;
  const second = await execute(adapter, "segundo pedido");

  const reply = second.reply ?? "";
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_cleared"));
  assert.ok(reply.includes("respondido"), "el turno SÍ pasó por la terminal: no se degrada");
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.panePid, "4242", "sin reinicio de proceso: el PID no delata nada");
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "context_cleared");
  assert.equal(records[0]?.fellBack, false);
});

test("resucitar la sesión no puede parecer una sesión compartida de siempre", async () => {
  // Medido: borrada la sesión entera, la entrega creó una TUI nueva, contestó en 75,9 s con
  // `exitCode 0` y CERO avisos. `ensure` ya devolvía `created:true` y el runner lo descartaba.
  const { state, home, workspace } = await freshState("resurreccion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("desde una TUI nueva"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.ok(reply.includes("desde una TUI nueva"), "el turno sí se sirvió");
  assert.equal(fallback.calls, 0, "crear la sesión NO es caer al camino viejo");
  assert.ok(reply.includes(RESET_MARK));
  assert.ok(reply.includes("session_created"));
  assert.equal((await readDegradations(state))[0]?.reason, "session_created");
});

test("un diálogo abierto no se confunde con una línea a medio escribir", async () => {
  const { state, home, workspace } = await freshState("modal");
  const tmux = new FakeTmux();
  // El diálogo real de confianza de carpeta, tal como lo dibuja claude 2.1.220.
  tmux.paneContent = "Quick safety check\n❯ 1. Yes, I trust this folder";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("por el camino viejo") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.equal(tmux.pasted, undefined, "no se pega NADA dentro de un diálogo");
  assert.ok(reply.includes("modal_blocking"));
  assert.ok(reply.includes("contestá el diálogo"), "la salida es contestar, no borrar");
  assert.ok(!reply.includes("input_busy"));
  assert.equal((await readDegradations(state))[0]?.reason, "modal_blocking");
});

test("una degradación NO deja la sesión enclavada para siempre", async () => {
  // El defecto más grave que encontró el diagnóstico 2, verificado de punta a punta: al degradar,
  // la versión anterior renombraba la ventana a `⚠ CAUCE-DEGRADADO`; `tuiTarget()` la busca por
  // nombre, así que a partir de ahí TODAS las entregas degradaban `tui_absent` en 0,2 s, para
  // siempre, con la TUI viva y sana delante, y diciéndole al dueño la mentira «la sesión existe
  // pero no tiene panel de TUI».
  const { state, home, workspace } = await freshState("enclavada");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ el dueno esta escribiendo";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("de vuelta en la terminal"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const degraded = await execute(adapter);
  assert.ok((degraded.reply ?? "").includes(DEGRADED_MARK));
  assert.deepEqual(tmux.windows, ["agente"], "la ventana conserva su identidad");

  // El dueño suelta la caja: el turno siguiente tiene que volver a la terminal.
  tmux.paneContent = "❯ ";
  const recovered = await execute(adapter, "segundo");
  assert.ok((recovered.reply ?? "").includes("de vuelta en la terminal"));
  assert.equal(fallback.calls, 1, "sólo degradó el primero");
});

test("una sesión ya enclavada por el build viejo se repara sola", async () => {
  const { state, home, workspace } = await freshState("reparacion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  // Como quedan hoy las sesiones que ya degradaron con la versión que renombraba.
  tmux.windows = ["⚠ CAUCE-DEGRADADO"];
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("resucitada"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("resucitada"));
  assert.deepEqual(tmux.windows, ["agente"]);
  assert.equal(fallback.calls, 0);
});