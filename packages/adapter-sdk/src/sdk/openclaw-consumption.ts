import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { consumptionWitness } from "../shared-session/consumption.js";
import { readTranscript, transcriptEntries, transcriptStillCurrent } from "./headless-transcript.js";
import { parseOpenClawOutput } from "./output-parser/harnesses.js";
import type { CommandRunRequest, CommandRunResult, HarnessConsumptionWitness } from "./types.js";

const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

interface OpenClawTranscript {
  readonly file: string;
  readonly metadata: BigIntStats;
  readonly size: number;
  readonly digest: string;
}

/** Where OpenClaw keeps the session that Cauce names with `--session-key`, before the turn. */
export interface OpenClawConsumptionSnapshot {
  readonly sessions: string;
  readonly key: string;
  readonly before?: OpenClawTranscript;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function transcriptFile(sessions: string, key: string): Promise<string | undefined> {
  const store = object(JSON.parse(await readFile(join(sessions, "sessions.json"), "utf8")));
  const entry = object(store?.[key]);
  if (entry === undefined) return undefined;
  const file = typeof entry.sessionFile === "string" ? entry.sessionFile
    : typeof entry.sessionId === "string" && NATIVE_ID.test(entry.sessionId) ? join(sessions, `${entry.sessionId}.jsonl`)
      : undefined;
  if (file === undefined || !isAbsolute(file) || dirname(file) !== sessions || !file.endsWith(".jsonl")) {
    throw new Error("Unexpected OpenClaw transcript location");
  }
  return file;
}

export async function prepareOpenClawConsumption(
  request: CommandRunRequest, environment: NodeJS.ProcessEnv,
): Promise<OpenClawConsumptionSnapshot | undefined> {
  try {
    if (request.harness !== "openclaw" || request.sessionId === undefined || !NATIVE_ID.test(request.sessionId)
      || environment.HOME === undefined || !isAbsolute(environment.HOME)) return undefined;
    const agents = join(await realpath(environment.HOME), ".openclaw", "agents");
    const found: OpenClawConsumptionSnapshot[] = [];
    const names = await readdir(agents).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const agent of names) {
      const sessions = join(agents, agent, "sessions");
      const key = `agent:${agent}:${request.sessionId}`;
      const file = await transcriptFile(sessions, key).catch(() => undefined);
      if (file === undefined) continue;
      const read = await readTranscript(file, MAX_TRANSCRIPT_BYTES);
      found.push({ sessions, key, before: { file, metadata: read.metadata, size: read.bytes.length, digest: digest(read.bytes) } });
    }
    // A brand-new session has no entry yet: OpenClaw creates it under its default agent.
    if (found.length === 0) return { sessions: join(agents, "main", "sessions"), key: `agent:main:${request.sessionId}` };
    return found.length === 1 ? found[0] : undefined;
  } catch { return undefined; }
}

function text(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map(object).filter((part) => part?.type === "text" && typeof part.text === "string");
  return parts.length === 0 ? undefined : parts.map((part) => String(part?.text)).join("");
}

function role(entry: Record<string, unknown>): unknown {
  return entry.type === "message" ? object(entry.message)?.role : undefined;
}

/**
 * Proves, from OpenClaw's own transcript, that THIS turn read exactly the prompt and that its last
 * answer is the output Cauce is about to deliver. The id reported is Cauce's session key: the same
 * one the web terminal opens with `tui --session`.
 */
export async function verifyOpenClawConsumption(
  snapshot: OpenClawConsumptionSnapshot | undefined, request: CommandRunRequest, result: CommandRunResult,
): Promise<HarnessConsumptionWitness | undefined> {
  try {
    const sid = request.sessionId;
    if (snapshot === undefined || sid === undefined || result.exitCode !== 0 || result.signal !== null
      || result.timedOut || result.cancelled || request.signal.aborted) return undefined;
    const parsed = parseOpenClawOutput(result.stdout);
    if (parsed.nativeSessionId !== sid || parsed.output.status !== "done"
      || !isDeepStrictEqual(request.emissionOutput?.() ?? parsed.output, parsed.output)) return undefined;
    const file = await transcriptFile(snapshot.sessions, snapshot.key);
    if (file === undefined) return undefined;
    const read = await readTranscript(file, MAX_TRANSCRIPT_BYTES);
    const before = snapshot.before;
    let appended: Buffer;
    if (before?.file === file) {
      if (before.metadata.dev !== read.metadata.dev || before.metadata.ino !== read.metadata.ino
        || read.bytes.length < before.size || digest(read.bytes.subarray(0, before.size)) !== before.digest
        || (before.size > 0 && read.bytes[before.size - 1] !== 10)) return undefined;
      appended = read.bytes.subarray(before.size);
    } else {
      // A new transcript (first turn or rotation) must be a whole session of its own.
      appended = read.bytes;
      if (transcriptEntries(appended)[0]?.type !== "session") return undefined;
    }
    const entries = transcriptEntries(appended);
    const users = entries.flatMap((entry, index) => role(entry) === "user" ? [index] : []);
    const prompt = request.stdin.trim();
    const own = users.filter((index) => text(object(entries[index]?.message)?.content)?.trim() === prompt);
    const injected = own[0];
    // Exactly one copy of the prompt, and nobody (the web TUI included) spoke after it.
    if (own.length !== 1 || injected === undefined || users.at(-1) !== injected) return undefined;
    const turnId = entries[injected]?.id;
    if (typeof turnId !== "string") return undefined;
    const answer = entries.slice(injected + 1).filter((entry) => role(entry) === "assistant")
      .map((entry) => text(object(entry.message)?.content)).filter((value) => value !== undefined && value.trim().length > 0)
      .at(-1);
    if (answer === undefined) return undefined;
    const canonical = parseOpenClawOutput(JSON.stringify({ result: { payloads: [{ text: answer }] }, session_id: sid }));
    if (!isDeepStrictEqual(canonical.output, parsed.output)) return undefined;
    if (!await transcriptStillCurrent(file, read.metadata)) return undefined;
    return consumptionWitness("openclaw", sid, turnId, request.stdin);
  } catch { return undefined; }
}
