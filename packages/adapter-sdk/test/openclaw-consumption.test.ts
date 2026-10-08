import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inputDigest } from "../src/shared-session/consumption.js";
import { prepareOpenClawConsumption, verifyOpenClawConsumption } from "../src/sdk/openclaw-consumption.js";
import type { CommandRunRequest, CommandRunResult } from "../src/sdk/types.js";

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRANSCRIPT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANSWER = JSON.stringify({ reply: "hecho", messages: [], status: "done", retryable: false, artifacts: [] });

const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
const message = (role: string, content: unknown, id = randomUUID()) => line({ type: "message", id, message: { role, content } });

async function home(options: { readonly existing?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-consumption-")));
  const sessions = join(root, ".openclaw", "agents", "main", "sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const file = join(sessions, `${TRANSCRIPT}.jsonl`);
  const index = async (): Promise<void> => {
    await writeFile(join(sessions, "sessions.json"), JSON.stringify({
      [`agent:main:${SID}`]: { sessionId: TRANSCRIPT, sessionFile: file } }), { mode: 0o600 });
  };
  if (options.existing !== false) {
    await writeFile(file, line({ type: "session", id: TRANSCRIPT }) + message("user", "turno anterior")
      + message("assistant", [{ type: "text", text: "antes" }]), { mode: 0o600 });
    await index();
  } else await writeFile(join(sessions, "sessions.json"), "{}", { mode: 0o600 });
  const request: CommandRunRequest = { command: process.execPath, args: ["--session-key", SID], harness: "openclaw",
    env: {}, stdin: `--- BEGIN REQUEST ---\npedido ${randomUUID()}\n--- END REQUEST ---\n`,
    signal: new AbortController().signal, timeoutMs: 2_000, sessionId: SID };
  const result = (stdoutText = ANSWER, session = SID): CommandRunResult => ({
    stdout: JSON.stringify({ result: { payloads: [{ text: stdoutText }] }, session_id: session }),
    stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false });
  return { root, sessions, file, index, request, result, clean: () => rm(root, { recursive: true, force: true }) };
}

test("OpenClaw atestigua el turno con la clave de sesión de Cauce y el id de la entrada nativa", async () => {
  const context = await home();
  try {
    const snapshot = await prepareOpenClawConsumption(context.request, { HOME: context.root });
    const turn = randomUUID();
    await appendFile(context.file, message("user", context.request.stdin.trim(), turn)
      + message("assistant", [{ type: "toolCall", name: "bash" }]) + message("toolResult", "ok")
      + message("assistant", [{ type: "text", text: ANSWER }]));
    const witness = await verifyOpenClawConsumption(snapshot, context.request, context.result());
    assert.deepEqual(witness, { version: 1, harness_id: "openclaw", native_session_id: SID,
      native_turn_id: turn,
      input_sha256: inputDigest(context.request.stdin), evidence_kind: "canonical_final_response" });
  } finally { await context.clean(); }
});

test("OpenClaw atestigua también el primer turno de una sesión que todavía no existía", async () => {
  const context = await home({ existing: false });
  try {
    const snapshot = await prepareOpenClawConsumption(context.request, { HOME: context.root });
    await writeFile(context.file, line({ type: "session", id: TRANSCRIPT }) + message("user", context.request.stdin.trim())
      + message("assistant", [{ type: "text", text: ANSWER }]), { mode: 0o600 });
    await context.index();
    assert.equal((await verifyOpenClawConsumption(snapshot, context.request, context.result()))?.native_session_id, SID);
  } finally { await context.clean(); }
});

const NEGATIVE: Readonly<Record<string, (context: Awaited<ReturnType<typeof home>>) => Promise<CommandRunResult | undefined>>> = {
  "la respuesta entregada no es la última del transcript": async (context) => {
    await appendFile(context.file, message("user", context.request.stdin.trim()) + message("assistant", [{ type: "text", text: ANSWER }]));
    return context.result(JSON.stringify({ reply: "otra cosa", messages: [], status: "done", retryable: false, artifacts: [] }));
  },
  "el pedido no llegó a la sesión": async (context) => {
    await appendFile(context.file, message("user", "otro pedido") + message("assistant", [{ type: "text", text: ANSWER }]));
    return undefined;
  },
  "alguien habló en la sesión después del pedido": async (context) => {
    await appendFile(context.file, message("user", context.request.stdin.trim()) + message("user", "escrito desde la web")
      + message("assistant", [{ type: "text", text: ANSWER }]));
    return undefined;
  },
  "el historial previo fue reescrito": async (context) => {
    await writeFile(context.file, line({ type: "session", id: TRANSCRIPT }) + message("user", "historia cambiada")
      + message("user", context.request.stdin.trim()) + message("assistant", [{ type: "text", text: ANSWER }]), { mode: 0o600 });
    return undefined;
  },
  "el sobre nombra otra sesión": async (context) => {
    await appendFile(context.file, message("user", context.request.stdin.trim()) + message("assistant", [{ type: "text", text: ANSWER }]));
    return context.result(ANSWER, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  },
  "el transcript quedó a medio escribir": async (context) => {
    await appendFile(context.file, message("user", context.request.stdin.trim()) + message("assistant", [{ type: "text", text: ANSWER }]).trimEnd());
    return undefined;
  },
};

for (const [name, mutate] of Object.entries(NEGATIVE)) {
  test(`OpenClaw no atestigua cuando ${name}`, async () => {
    const context = await home();
    try {
      const snapshot = await prepareOpenClawConsumption(context.request, { HOME: context.root });
      assert.ok(snapshot?.before, "el estado previo debe medirse");
      const result = await mutate(context) ?? context.result();
      assert.equal(await verifyOpenClawConsumption(snapshot, context.request, result), undefined);
    } finally { await context.clean(); }
  });
}
