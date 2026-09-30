import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CODEX_WAKE_TEXT } from "../src/shared-session/codex-chain.js";
import { correlateEnvelopePrompt } from "../src/shared-session/envelope.js";
import { grokTranscript, newGrokSessionId } from "../src/shared-session/grok.js";
import { museTranscript } from "../src/shared-session/muse.js";
import { lastPromptOrigin, promptOrigin } from "../src/shared-session/prompt-origin.js";
import { codexTranscript } from "../src/shared-session/rollout.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import { claudeTranscript } from "../src/shared-session/transcript.js";
import { GrokTmux, grokRunner, grokWorkspace } from "./grok-shared-session-fixtures.js";
import { museWorkspace } from "./muse-shared-session-fixtures.js";
import { FakeTmux, assistantEntry, claudeRunner, freshState, userEntry } from "./shared-session-fixtures.js";

/**
 * A root may leave the TUI only when a person typed the last prompt of its conversation: a bus
 * prompt (it carries the correlation block) or a codex wake means the model is still working for
 * Cauce, and anything the transcript cannot attribute is refused.
 */

const BUS_PROMPT = correlateEnvelopePrompt("--- BEGIN REQUEST ---\nrevisá el disco\n--- END REQUEST ---", "c".repeat(64), true);
const HUMAN_PROMPT = "mandale a zeus que revise el disco";

async function claudeFile(name: string): Promise<{ home: string; workspace: string; file: string; sessionId: string }> {
  const { home, workspace } = await freshState(name);
  const sessionId = randomUUID();
  return { home, workspace, sessionId, file: join(transcriptDirectory(home, workspace), `${sessionId}.jsonl`) };
}

async function claudeLines(file: string, sessionId: string, ...lines: readonly [string, "user" | "assistant" | "raw"][]): Promise<void> {
  let parent: string | null = null;
  for (const [text, role] of lines) {
    const uuid = randomUUID();
    const line = role === "raw" ? text
      : role === "user" ? userEntry(uuid, parent, text, sessionId) : assistantEntry(uuid, parent ?? uuid, text, sessionId);
    await appendFile(file, `${line}\n`);
    parent = uuid;
  }
}

test("claude: the last user entry decides, the newest conversation wins, and tags or meta are nobody's", async () => {
  const { home, workspace, file, sessionId } = await claudeFile("origen-claude");
  const reader = claudeTranscript(join(home, ".claude"), workspace);
  await claudeLines(file, sessionId, [HUMAN_PROMPT, "user"], ["listo", "assistant"], [BUS_PROMPT, "user"], ["{}", "assistant"]);
  assert.equal(await lastPromptOrigin(reader), "cauce");
  await claudeLines(file, sessionId, [`<pasted_content id="0a1b">\n${HUMAN_PROMPT}\n</pasted_content id="0a1b">`, "user"]);
  assert.equal(await lastPromptOrigin(reader), "human");
  await claudeLines(file, sessionId, [`<pasted_content id="0a1c">\n${BUS_PROMPT}</pasted_content id="0a1c">`, "user"]);
  assert.equal(await lastPromptOrigin(reader), "cauce");
  await claudeLines(file, sessionId, [HUMAN_PROMPT, "user"],
    [JSON.stringify({ type: "user", uuid: randomUUID(), isSidechain: false, sessionId,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }), "raw"]);
  assert.equal(await lastPromptOrigin(reader), "human", "a tool result is not a prompt");
  await claudeLines(file, sessionId, ["<task-notification>la tarea terminó</task-notification>", "user"]);
  assert.equal(await lastPromptOrigin(reader), undefined);
  await claudeLines(file, sessionId, [JSON.stringify({ type: "user", uuid: randomUUID(), isSidechain: false, isMeta: true,
    sessionId, message: { role: "user", content: "Base directory for this skill: /x" } }), "raw"]);
  assert.equal(await lastPromptOrigin(reader), undefined);

  const older = join(transcriptDirectory(home, workspace), `${randomUUID()}.jsonl`);
  await claudeLines(older, sessionId, [HUMAN_PROMPT, "user"]);
  await utimes(older, new Date(1_000_000), new Date(1_000_000));
  assert.equal(await lastPromptOrigin(reader), undefined, "an older conversation never speaks for the current one");
  await claudeLines(older, sessionId, [HUMAN_PROMPT, "user"]);
  assert.equal(await lastPromptOrigin(reader), "human", "the most recently written conversation is the TUI's");
});

test("claude: a transcript that cannot be read, or holds no prompt, is refused", async () => {
  const { home, workspace, file, sessionId } = await claudeFile("origen-claude-vacio");
  assert.equal(await lastPromptOrigin(claudeTranscript(join(home, "no-existe", ".claude"), workspace)), undefined);
  await claudeLines(file, sessionId, ["hola", "assistant"]);
  assert.equal(await lastPromptOrigin(claudeTranscript(join(home, ".claude"), workspace)), undefined);
});

test("the paste runner answers for its own transcript", async () => {
  const { home, workspace, file, sessionId } = await claudeFile("origen-runner");
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux: new FakeTmux() });
  await claudeLines(file, sessionId, [BUS_PROMPT, "user"]);
  assert.equal(await runner.lastUserPromptOrigin(), "cauce");
  await claudeLines(file, sessionId, [HUMAN_PROMPT, "user"]);
  assert.equal(await runner.lastUserPromptOrigin(), "human");
});

const rolloutLine = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
const codexUser = (text: string, turnId = randomUUID()): string => rolloutLine("response_item", {
  type: "message", role: "user", content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});

async function rollout(codexHome: string, source: unknown, ...lines: readonly string[]): Promise<string> {
  const day = join(codexHome, "sessions", "2026", "09", "30");
  await mkdir(day, { recursive: true });
  const sessionId = randomUUID();
  const file = join(day, `rollout-2026-09-30T10-00-00-${sessionId}.jsonl`);
  await writeFile(file, [rolloutLine("session_meta", { id: sessionId, source }), ...lines].map((line) => `${line}\n`).join(""));
  return file;
}

test("codex: bus prompts and wakes are Cauce's, the preamble is skipped, goal turns and sub-agent rollouts never count", async () => {
  const { home } = await freshState("origen-codex");
  const codexHome = join(home, ".codex");
  const reader = codexTranscript(codexHome);
  assert.equal(await lastPromptOrigin(reader), undefined, "no rollout at all");
  const cli = await rollout(codexHome, "cli", codexUser(HUMAN_PROMPT), codexUser(BUS_PROMPT));
  assert.equal(await lastPromptOrigin(reader), "cauce");
  await appendFile(cli, `${codexUser(CODEX_WAKE_TEXT)}\n`);
  assert.equal(await lastPromptOrigin(reader), "cauce", "a codex wake keeps the bus turn going");
  await appendFile(cli, `${codexUser("<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>")}\n${codexUser(HUMAN_PROMPT)}\n`);
  assert.equal(await lastPromptOrigin(reader), "human");
  await appendFile(cli, `${codexUser("<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>")}\n`);
  assert.equal(await lastPromptOrigin(reader), "human", "the preamble codex writes itself is not a prompt");
  const subagent = await rollout(codexHome, { subagent: { thread_spawn: { parent_thread_id: "x" } } }, codexUser(BUS_PROMPT));
  const later = new Date(Date.now() + 60_000);
  await utimes(subagent, later, later);
  assert.equal(await lastPromptOrigin(reader), "human", "a newer sub-agent rollout is not the TUI conversation");
  await appendFile(cli, `${codexUser('<codex_internal_context source="goal">seguí</codex_internal_context>')}\n`);
  assert.equal(await lastPromptOrigin(reader), undefined);
});

test("grok: the bus prompt holds until a person types, even across a background wake turn", async () => {
  const { grokHome, log } = await grokWorkspace("origen-grok");
  const reader = grokTranscript(grokHome);
  assert.equal(await lastPromptOrigin(reader), "human");
  await log.append(log.user(BUS_PROMPT), log.message("p-bus", "{}"), log.completed("p-bus"),
    log.message("p-wake", "sigo con lo del subagente"), log.completed("p-wake"));
  assert.equal(await lastPromptOrigin(reader), "cauce");
  await log.append(log.user(`<user_query>\n${HUMAN_PROMPT}\n</user_query>`));
  assert.equal(await lastPromptOrigin(reader), "human");
  assert.equal(await lastPromptOrigin(grokTranscript(join(grokHome, "no-existe"))), undefined);
});

test("muse: the last accepted intent decides, framed or not", async () => {
  const { museData, log } = await museWorkspace("origen-muse");
  const reader = museTranscript(museData);
  assert.equal(await lastPromptOrigin(reader), "human");
  await log.append(log.frame(log.intent("i-bus", BUS_PROMPT)), log.started("i-bus", BUS_PROMPT), log.message("i-bus", "{}"),
    log.terminal("i-bus"));
  assert.equal(await lastPromptOrigin(reader), "cauce");
  await log.append(log.intent("i-humano", HUMAN_PROMPT));
  assert.equal(await lastPromptOrigin(reader), "human");
  assert.equal(await lastPromptOrigin(museTranscript(join(museData, "no-existe"))), undefined);
});

// Shapes read from hades's real grok 1.0.41 conversation (a /goal running while its owner types).
const GOAL = "<system-reminder>\nA goal has been set: consigue 20 clientes hoy\n\nYou are working toward this goal.\n</system-reminder>";

test("grok: the goal loop and reminders around typed text are the owner's; a bus prompt stays Cauce's under any wrapper", () => {
  assert.equal(promptOrigin(GOAL), "human", "the /goal loop was launched by its owner typing it");
  assert.equal(promptOrigin(`${GOAL}\nhaz ping a jarvis`), "human", "a reminder before the typed text hid it");
  assert.equal(promptOrigin("<user_query>\nhaz ping a jarvis\n</user_query>"), "human");
  assert.equal(promptOrigin(`${GOAL}\n${BUS_PROMPT}`), "cauce");
  assert.equal(promptOrigin(`<user_query>\n${BUS_PROMPT}\n</user_query>`), "cauce");
  assert.equal(promptOrigin("<system-reminder>\nYou have 3 new messages\n</system-reminder>"), undefined, "a bare reminder is nobody's");
  assert.equal(promptOrigin("<task-notification>done</task-notification>"), undefined);
});

test("grok: a /goal planner fork written after the TUI's turn never decides (session_kind subagent_fork)", async () => {
  const { grokHome, log, sessionLog } = await grokWorkspace("origen-grok-fork");
  await log.append(log.user(BUS_PROMPT), log.message("p-bus", "ok"), log.completed("p-bus"));
  const fork = await sessionLog(newGrokSessionId(Date.now() + 5_000));
  await fork.append(fork.user("You are the Goal Plan Writer for the xAI Grok Build harness."));
  await writeFile(join(fork.file, "..", "summary.json"), JSON.stringify({ session_kind: "subagent_fork", parent_session_id: log.sessionId }));
  const later = new Date(Date.now() + 5_000);
  await utimes(fork.file, later, later);
  assert.equal(await lastPromptOrigin(grokTranscript(grokHome)), "cauce", "the planner's own prompt was taken as the owner's");
});

test("grok runner: only the TUI's own cwd group decides; a newer conversation of another cwd is another process", async () => {
  const { grokHome, sessionLog } = await grokWorkspace("origen-grok-cwd", { history: false });
  const own = await sessionLog(newGrokSessionId(), "%2Fworkspace"); // grokRunner's workspace
  await own.append(own.user(BUS_PROMPT), own.message("p-bus", "ok"), own.completed("p-bus"));
  const other = await sessionLog(newGrokSessionId(Date.now() + 1_000), "%2Fhome%2Fclaw%2Fworkspace%2Fxenia");
  await other.append(other.user(HUMAN_PROMPT));
  const later = new Date(Date.now() + 5_000);
  await utimes(other.file, later, later);
  const runner = grokRunner({ grokHome, tmux: new GrokTmux() });
  assert.equal(await runner.lastUserPromptOrigin(), "cauce", "a sibling cwd's typed prompt spoke for this TUI");
  await own.append(own.user(`${GOAL}\n${HUMAN_PROMPT}`));
  assert.equal(await runner.lastUserPromptOrigin(), "human");
});

test("a bus prompt without the correlation block (hades 2026-09-23, headless era) is still Cauce's by its identity preamble", () => {
  assert.equal(promptOrigin("--- BEGIN IDENTITY ---\nSos \"hades\", un agente de la flota Cauce V3\n--- END IDENTITY ---\nrevisá el disco"), "cauce");
  assert.equal(promptOrigin("--- BEGIN IDENTITY ---"), "cauce");
});
