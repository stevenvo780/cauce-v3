import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshState } from "./shared-session-fixtures.js";

/** Writes `session.jsonl` records shaped like Muse 1.4.0's. */
export class MuseLog {
  private sequence = 0;

  constructor(readonly file: string, readonly sessionId: string) {}

  private record(payloadType: string, payload: Record<string, unknown>): Record<string, unknown> {
    this.sequence += 1;
    return {
      schema_version: 1,
      id: randomUUID(),
      stream: { kind: "session", id: this.sessionId },
      sequence: this.sequence,
      recorded_at: 1_790_555_476_699_047 + this.sequence,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: payloadType,
      payload_schema_version: 1,
      payload,
    };
  }

  private run(runId: string, event: Record<string, unknown>): string {
    return JSON.stringify(this.record("runtime.session", { event, kind: "run", run_id: runId }));
  }

  intent(intentId: string, text: string): string {
    return JSON.stringify(this.record("runtime.user_intent.accepted", {
      bindings: [], delivery_policy: "session_current", intent_id: intentId,
      model_messages: [{ content: [{ kind: "text", text }] }],
      refill_blocks: [{ kind: "text", text }],
    }));
  }

  started(runId: string, prompt: string): string {
    return this.run(runId, { kind: "started", prompt });
  }

  message(runId: string, text: string): string {
    return this.run(runId, {
      kind: "assistant_message_committed", message_id: randomUUID(), provider_item_id: "msg_1",
      response_id: "resp_1", text,
    });
  }

  tools(runId: string): string {
    return this.run(runId, { kind: "assistant_tool_calls_committed", message_id: randomUUID(), tool_calls: [] });
  }

  terminal(runId: string, terminal = "completed", reason: unknown = null): string {
    return this.run(runId, { kind: "terminal", reason, terminal, turn_duration_ms: 10_026 });
  }

  compaction(runId: string): string {
    return this.run(runId, { kind: "context_compaction_installed", install_id: "install-1517" });
  }

  /** A `retained_frame` line: several records serialized inside `children[].record_json`. */
  frame(...lines: readonly string[]): string {
    return JSON.stringify({
      retained_frame: "session_permission_transaction",
      frame_schema_version: 1,
      outer_log_ordinal: 1,
      transaction_id: randomUUID(),
      children: lines.map((line, index) => ({ child_index: index, record_json: line })),
    });
  }

  async append(...lines: readonly string[]): Promise<void> {
    await appendFile(this.file, `${lines.join("\n")}\n`);
  }
}

export function museSessionId(): string {
  // Muse mints UUIDv7; the listing only needs the canonical shape.
  const hex = randomUUID().replace(/-/gu, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function museWorkspace(name: string, options: { history?: boolean } = {}): Promise<{
  state: string;
  home: string;
  museData: string;
  log: MuseLog;
}> {
  const { state, home } = await freshState(name);
  const museData = join(home, ".local", "share", "cauce-v3", "config", "hegel", ".local", "share", "muse");
  const sessionId = museSessionId();
  const directory = join(museData, "sessions", "2026", "09", "28", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  // Folders Muse keeps next to the sessions that are NOT conversations.
  await mkdir(join(museData, "sessions", ".msp-view-v1", sessionId), { recursive: true });
  await mkdir(join(directory, "subagent", randomUUID()), { recursive: true });
  const log = new MuseLog(join(directory, "session.jsonl"), sessionId);
  if (options.history !== false) {
    await log.append(log.intent("i-previo", "respondé solo: hola"), log.started("i-previo", "respondé solo: hola"),
      log.message("i-previo", "hola"), log.terminal("i-previo"));
  } else {
    await writeFile(log.file, "");
  }
  return { state, home, museData, log };
}
