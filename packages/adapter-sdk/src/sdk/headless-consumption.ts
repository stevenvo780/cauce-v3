import type { BigIntStats } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { consumptionWitness } from "../shared-session/consumption.js";
import { codexTranscript, rolloutSessionId } from "../shared-session/rollout.js";
import { transcriptDirectoryIn } from "../shared-session/session.js";
import { claudeTranscript } from "../shared-session/transcript.js";
import { parseClaudeOutput, parseCodexOutput } from "./output-parser/harnesses.js";
import {
  sameDirectory, snapshotTranscripts, transcriptDirectory, transcriptEntries, transcriptStillCurrent,
  verifyTranscript, type TranscriptSnapshot,
} from "./headless-transcript.js";
import type { CommandRunRequest, CommandRunResult, HarnessConsumptionWitness } from "./types.js";

const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

interface HeadlessConsumptionSnapshot {
  readonly harness: "claude" | "codex";
  readonly config: string;
  readonly configuredPath: string;
  readonly workingPath: string;
  readonly workspace: string;
  readonly anchors: ReadonlyMap<string, BigIntStats>;
  readonly transcripts: TranscriptSnapshot;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nativeInput(entry: Record<string, unknown>, harness: "claude" | "codex"): string | undefined {
  const message = harness === "claude" ? object(entry.message) : object(entry.payload);
  if (message === undefined) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts = message.content.map(object);
  if (parts.some((part) => part === undefined || typeof part.text !== "string"
    || !["text", "input_text"].includes(String(part.type)))) return undefined;
  return parts.map((part) => part?.text).join("");
}

function turnId(entry: Record<string, unknown>, harness: "claude" | "codex"): unknown {
  return harness === "claude" ? entry.uuid
    : object(object(entry.payload)?.internal_chat_message_metadata_passthrough)?.turn_id;
}

export async function prepareHeadlessConsumption(
  request: CommandRunRequest, environment: NodeJS.ProcessEnv,
): Promise<HeadlessConsumptionSnapshot | undefined> {
  try {
    if (request.harness !== "claude" && request.harness !== "codex") return undefined;
    if (request.sessionId !== undefined && !NATIVE_ID.test(request.sessionId)) return undefined;
    if (request.harness === "claude" && request.sessionId === undefined) return undefined;
    const configured = request.harness === "claude" ? environment.CLAUDE_CONFIG_DIR : environment.CODEX_HOME;
    const path = configured ?? (environment.HOME === undefined ? undefined
      : join(environment.HOME, request.harness === "claude" ? ".claude" : ".codex"));
    if (path === undefined || !isAbsolute(path)) return undefined;
    const config = await realpath(path);
    const workingPath = request.cwd ?? process.cwd();
    const workspace = await realpath(workingPath);
    const anchors = new Map<string, BigIntStats>();
    for (const directory of [config, workspace]) {
      const metadata = await transcriptDirectory(directory);
      if (metadata === undefined) return undefined;
      anchors.set(directory, metadata);
    }
    const root = request.harness === "claude" ? transcriptDirectoryIn(config, workspace) : join(config, "sessions");
    const transcripts = await snapshotTranscripts(root, request.harness === "codex", (file) =>
      request.sessionId !== undefined && (request.harness === "claude"
        ? basename(file, ".jsonl") === request.sessionId : rolloutSessionId(file) === request.sessionId));
    return { harness: request.harness, config, configuredPath: path, workingPath, workspace, anchors, transcripts };
  } catch { return undefined; }
}

export async function verifyHeadlessConsumption(
  snapshot: HeadlessConsumptionSnapshot | undefined, request: CommandRunRequest, result: CommandRunResult,
): Promise<HarnessConsumptionWitness | undefined> {
  try {
    if (snapshot === undefined || result.exitCode !== 0 || result.signal !== null
      || result.timedOut || result.cancelled || request.signal.aborted) return undefined;
    const parsed = snapshot.harness === "claude" ? parseClaudeOutput(result.stdout) : parseCodexOutput(result.stdout);
    const sid = parsed.nativeSessionId;
    if (sid === undefined || !NATIVE_ID.test(sid) || parsed.output.status !== "done"
      || (request.sessionId !== undefined && sid !== request.sessionId)
      || !isDeepStrictEqual(request.emissionOutput?.() ?? parsed.output, parsed.output)) return undefined;
    if (request.resumeSession !== true && [...snapshot.transcripts.files.keys()].some((file) =>
      (snapshot.harness === "claude" ? basename(file, ".jsonl") : rolloutSessionId(file)) === sid)) return undefined;
    const port = snapshot.harness === "claude" ? claudeTranscript(snapshot.config, snapshot.workspace)
      : codexTranscript(snapshot.config);
    const inventory = await snapshotTranscripts(snapshot.transcripts.root, snapshot.harness === "codex", () => false);
    const candidates = [...inventory.files.keys()].filter((file) => snapshot.harness === "claude"
      ? basename(file, ".jsonl") === sid : rolloutSessionId(file) === sid);
    const file = candidates[0];
    if (candidates.length !== 1 || file === undefined) return undefined;
    const read = await verifyTranscript(snapshot.transcripts, file, request.resumeSession === true);
    if (read === undefined) return undefined;
    const entries = transcriptEntries(read.appended);
    const previous = transcriptEntries(read.bytes.subarray(0, read.bytes.length - read.appended.length));
    const injected = port.findInjected(file, entries, request.stdin);
    if (injected?.sessionId !== sid
      || previous.some((entry) => turnId(entry, snapshot.harness) === injected.key)) return undefined;
    const inputs = entries.filter((entry) => turnId(entry, snapshot.harness) === injected.key
      && (snapshot.harness === "claude" ? entry.type === "user"
        : entry.type === "response_item" && object(entry.payload)?.role === "user"));
    const input = inputs[0];
    if (inputs.length !== 1 || input === undefined || nativeInput(input, snapshot.harness) !== request.stdin) return undefined;
    if (snapshot.harness === "claude") {
      if (inputs[0]?.cwd !== snapshot.workspace) return undefined;
    } else {
      const meta = transcriptEntries(read.bytes).filter((entry) => entry.type === "session_meta");
      const metadata = object(meta[0]?.payload);
      if (meta.length !== 1 || metadata?.id !== sid || metadata.cwd !== snapshot.workspace
        || metadata.source !== "exec") return undefined;
    }
    const answer = port.findAnswer(entries, injected.key);
    if (answer?.kind !== "answer" || !port.provesConsumption?.(entries, injected.key, answer.text, sid, request.stdin)) return undefined;
    const canonical = snapshot.harness === "claude"
      ? parseClaudeOutput(JSON.stringify({ session_id: sid, result: answer.text }))
      : parseCodexOutput(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer.text } }));
    if (!isDeepStrictEqual(canonical.output, parsed.output)) return undefined;
    if (await realpath(snapshot.configuredPath) !== snapshot.config
      || await realpath(snapshot.workingPath) !== snapshot.workspace) return undefined;
    for (const [directory, metadata] of snapshot.anchors) {
      if (!await sameDirectory(directory, metadata)) return undefined;
    }
    for (const [directory, metadata] of inventory.directories) {
      if (!await sameDirectory(directory, metadata)) return undefined;
    }
    if (!await transcriptStillCurrent(file, read.metadata)) return undefined;
    return consumptionWitness(snapshot.harness, sid, injected.key, request.stdin);
  } catch { return undefined; }
}
