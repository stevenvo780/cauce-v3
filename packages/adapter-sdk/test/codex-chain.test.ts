import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CODEX_WAKE_TEXT, type CodexLine } from "../src/shared-session/codex-chain.js";
import { codexTranscript, type RolloutLine } from "../src/shared-session/rollout.js";

/**
 * Real socrates rollout (sanitized: texts replaced, structure, timestamps and turn ids intact).
 * 13:24 turn b1e2a45b (Steven): delegates, the sub-agent answers DURING the turn, the root closes
 * with no message. 14:20 turn 39549913 (zeus): delegates to finish_muse and closes at 14:25:45 with
 * no message; finish_muse closed in ITS rollout at 14:30:43, but codex only wrote its FINAL_ANSWER
 * into the root at 14:31:55, inside the NEXT bus turn. Both deliveries died as «sin ningún mensaje
 * del agente» and their answers were lost.
 */
const FIXTURE: readonly RolloutLine[] = readFileSync(resolve("test/fixtures/codex-rollout-delegacion-socrates.jsonl"), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as RolloutLine);
const STEVEN = "01a0f27d-4fa4-7810-9be3-6b17b1e2a45b";
const ZEUS = "01a0f2af-f3bc-7502-a0e5-743d39549913";
const port = codexTranscript("/nonexistent");
const upTo = (stamp: string): RolloutLine[] => FIXTURE.filter((line) => String(line.timestamp) <= stamp);
const failure = (outcome: ReturnType<typeof port.findAnswer>): string => (outcome?.kind === "failed" ? outcome.detail : "");

function userLine(turn: string, text: string): CodexLine {
  return { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn } } };
}
function wakeTurn(turn: string, answer: string | null, preamble?: string): CodexLine[] {
  return [
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    ...(preamble === undefined ? [] : [userLine(turn, preamble)]),
    userLine(turn, CODEX_WAKE_TEXT),
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: answer } },
  ];
}
function turnWith(turn: string, middle: CodexLine[], answer: string | null): CodexLine[] {
  return [{ type: "event_msg", payload: { type: "task_started", turn_id: turn } }, userLine(turn, "pedido"), ...middle,
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: answer } }];
}
const call = (name: string, args: Record<string, unknown>, id: string): CodexLine =>
  ({ type: "response_item", payload: { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) } });
const output = (id: string, text: string): CodexLine =>
  ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: text } });

test("codex: la raíz que delegó y cerró muda NO es el final: hay que despertarla (zeus 39549913)", () => {
  const atClose = upTo("2026-09-30T14:25:45.9");
  assert.equal(port.findAnswer(atClose, ZEUS), undefined, "se dio por muerto el turno que esperaba a finish_muse");
  const wake = port.wakePrompt?.(atClose, ZEUS);
  assert.equal(wake?.text, CODEX_WAKE_TEXT); assert.equal(wake.wakes, 0);
});

test("codex: la respuesta del turno despertado es la de la entrega", () => {
  const woken = [...upTo("2026-09-30T14:25:45.9"), ...wakeTurn("wake-1", '{"reply":"hecho","messages":[]}')];
  assert.deepEqual(port.findAnswer(woken, ZEUS), { kind: "answer", text: '{"reply":"hecho","messages":[]}' });
});

test("codex: el preámbulo que codex escribe al abrir el turno no convierte el despertar en un turno ajeno", () => {
  const woken = [...upTo("2026-09-30T14:25:45.9"),
    ...wakeTurn("wake-1", "respuesta", "<environment_context>\n  <subagents>finish_muse</subagents>\n</environment_context>")];
  assert.deepEqual(port.findAnswer(woken, ZEUS), { kind: "answer", text: "respuesta" });
});

test("codex: un turno ya arrancado pero todavía sin clasificar es la raíz ocupada, no un despertar pendiente", () => {
  const starting = [...upTo("2026-09-30T14:25:45.9"), { type: "event_msg", payload: { type: "task_started", turn_id: "w" } }];
  assert.equal(port.wakePrompt?.(starting, ZEUS), undefined);
  assert.equal(port.findAnswer(starting, ZEUS), undefined);
});

test("codex: la raíz que delegó, recibió la respuesta DENTRO del turno y cerró muda también se despierta (Steven b1e2a45b)", () => {
  const atClose = upTo("2026-09-30T14:20:10.7");
  assert.equal(port.findAnswer(atClose, STEVEN), undefined);
  assert.equal(port.wakePrompt?.(atClose, STEVEN)?.wakes, 0);
});

test("codex: si otro turno entra antes de la respuesta final, la entrega termina con error claro, no muda", () => {
  assert.match(failure(port.findAnswer(FIXTURE, ZEUS)), /delegó en subagentes y alguien escribió/u); // the real next bus paste
});

test("codex: dos despertares mudos agotan la espera y fallan con motivo", () => {
  const twice = [...upTo("2026-09-30T14:25:45.9"), ...wakeTurn("wake-1", null), ...wakeTurn("wake-2", null)];
  assert.equal(port.wakePrompt?.(twice, ZEUS), undefined);
  assert.match(failure(port.findAnswer(twice, ZEUS)), /aun después de despertarlo/u);
});

test("codex: si la raíz respondió, esa es la respuesta aunque haya delegado", () => {
  const answered = turnWith("t", [call("spawn_agent", { task_name: "w" }, "c1"), output("c1", '{"task_name":"/root/w"}')], "hecho");
  assert.deepEqual(port.findAnswer(answered, "t"), { kind: "answer", text: "hecho" });
});

test("codex: una delegación que codex rechazó no es delegar: el cierre mudo falla como siempre, sin despertar", () => {
  const rejected = [call("spawn_agent", { task_name: "w" }, "c1"), output("c1", "collab spawn failed: agent thread limit reached")];
  assert.equal(port.wakePrompt?.(turnWith("t", rejected, null), "t"), undefined);
  assert.equal(failure(port.findAnswer(turnWith("t", rejected, null), "t")), "el turno terminó en la terminal sin ningún mensaje del agente");
});

test("codex: un turno sin delegaciones sigue cerrando como siempre", () => {
  assert.deepEqual(port.findAnswer(turnWith("p", [], "listo"), "p"), { kind: "answer", text: "listo" });
  assert.equal(failure(port.findAnswer(turnWith("p", [], null), "p")), "el turno terminó en la terminal sin ningún mensaje del agente");
  assert.equal(port.wakePrompt?.(turnWith("p", [], null), "p"), undefined, "sin delegaciones no se despierta a nadie");
});

test("codex: un cierre con error (cuota, token revocado) se informa tal cual y no se despierta contra la misma pared", () => {
  const delegated = [call("spawn_agent", { task_name: "w" }, "c1"), output("c1", '{"task_name":"/root/w"}')];
  const lines = [...turnWith("t", delegated, null).slice(0, -1), { type: "event_msg", payload: { type: "task_complete", turn_id: "t",
    last_agent_message: null, error: { message: "Your access token could not be refreshed", codex_error_info: "unauthorized" } } }];
  assert.equal(port.wakePrompt?.(lines, "t"), undefined);
  assert.match(failure(port.findAnswer(lines, "t")), /codex cerró el turno con error \(unauthorized\): Your access token/u);
});

test("codex: el turno que codex abre solo en modo goal continúa la cadena y su respuesta es la de la entrega", () => {
  const silent = turnWith("t", [call("spawn_agent", { task_name: "w" }, "c1"), output("c1", '{"task_name":"/root/w"}')], null);
  const goal: CodexLine[] = [{ type: "event_msg", payload: { type: "task_started", turn_id: "g" } },
    userLine("g", '<codex_internal_context source="goal">continuar</codex_internal_context>'),
    { type: "event_msg", payload: { type: "task_complete", turn_id: "g", last_agent_message: "respuesta del goal" } }];
  assert.deepEqual(port.findAnswer([...silent, ...goal], "t"), { kind: "answer", text: "respuesta del goal" });
});

test("codex: un mensaje del dueño que empieza con una etiqueta es del dueño, no un preámbulo de codex", () => {
  const silent = turnWith("t", [call("spawn_agent", { task_name: "w" }, "c1"), output("c1", '{"task_name":"/root/w"}')], null);
  const owner: CodexLine[] = [{ type: "event_msg", payload: { type: "task_started", turn_id: "o" } }, userLine("o", "<b>hola</b> revisá esto")];
  assert.equal(port.wakePrompt?.([...silent, ...owner], "t"), undefined, "despertó encima del turno del dueño");
  assert.match(failure(port.findAnswer([...silent, ...owner], "t")), /alguien escribió/u);
});

test("codex: un turno respondido no queda retenido por otro turno que todavía no se clasificó", () => {
  const answered = [...turnWith("t", [], "listo"), { type: "event_msg", payload: { type: "task_started", turn_id: "x" } }];
  assert.deepEqual(port.findAnswer(answered, "t"), { kind: "answer", text: "listo" });
});

test("codex: un spawn exitoso cuyo nombre contiene «error» no se toma por rechazado, y send_message también delega", () => {
  const spawned = turnWith("t", [call("spawn_agent", { task_name: "fix-error-x" }, "c1"), output("c1", '{"task_name":"/root/fix-error-x"}')], null);
  assert.equal(port.wakePrompt?.(spawned, "t")?.wakes, 0);
  const messaged = turnWith("m", [call("send_message", { target: "w", message: "seguí" }, "c1"), output("c1", "")], null);
  assert.equal(port.wakePrompt?.(messaged, "m")?.wakes, 0);
});
