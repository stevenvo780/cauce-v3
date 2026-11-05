import assert from "node:assert/strict";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inputBoxState } from "../src/shared-session/pane.js";
import { ENVELOPE_TAIL_BYTES } from "../src/shared-session/paste-runner/base.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner/runner.js";
import type { TranscriptReader, TranscriptSlice, TurnOutcome } from "../src/shared-session/types.js";
import { FakeTmux, envelopeText, freshState } from "./shared-session-fixtures.js";

interface Line { readonly text: string }

const CORRELATION = "3e673be0".padEnd(64, "a");
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const slice = (lines: readonly Line[]): TranscriptSlice<Line> => ({ entries: lines, appended: lines });

/** Exposes the late-envelope lookup that `reconcileTerminalPending` runs before releasing a quarantine. */
class Probe extends PasteSessionRunner<Line> {
  lookup(correlationId: string): Promise<string | undefined> {
    const reader = this.options.transcript;
    return this.hasValidTerminalEnvelope(correlationId, (entries, id) => reader.findEnvelope?.(entries, id));
  }
}

function transcript(file: string, read: (offset: number) => Promise<TranscriptSlice<Line>>): TranscriptReader<Line> {
  return {
    files: () => Promise.resolve([file]),
    read: (_file, offset) => read(offset),
    findInjected: () => undefined,
    findAnswer: () => undefined,
    findEnvelope: (entries, correlationId): TurnOutcome | undefined => {
      const hit = [...entries].reverse().find((line) => line.text.includes(correlationId));
      return hit === undefined ? undefined : { kind: "answer", text: hit.text };
    },
    compactions: () => [],
    stdout: (text) => text,
  };
}

function probe(reader: TranscriptReader<Line>, workspace: string): Probe {
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-operador";
  return new Probe({
    alias: "operador", harness: "muse", workspace, transcript: reader, tmux,
    sleep: () => Promise.resolve(), acquireTimeoutMs: 30, turnTimeoutMs: 2_000, settleMs: 0, pollMs: 1,
    readyTimeoutMs: 30, quarantineOperationTimeoutMs: 200,
  });
}

/** A transcript bigger than the tail window, as Muse's session.jsonl grows to tens of MB. */
async function bigTranscript(name: string): Promise<{ file: string; workspace: string }> {
  const { state, workspace } = await freshState(name);
  const file = join(state, "session.jsonl");
  await writeFile(file, "");
  await truncate(file, ENVELOPE_TAIL_BYTES + 1024);
  return { file, workspace };
}

test("a finished turn's envelope is found in the tail of a transcript too large to read whole in time", async () => {
  const { file, workspace } = await bigTranscript("envelope-tail-fast-path");
  const envelope = envelopeText("rescued from the tail", CORRELATION);
  // The whole-file read never finishes inside the quarantine deadline (busy disk); the tail does.
  const reader = transcript(file, (offset) => offset === 0 ? never() : Promise.resolve(slice([{ text: envelope }])));
  assert.equal(await probe(reader, workspace).lookup(CORRELATION), envelope);
});

test("an envelope older than the tail window is still found by reading the whole transcript", async () => {
  const { file, workspace } = await bigTranscript("envelope-tail-fallback");
  const envelope = envelopeText("found in the full read", CORRELATION);
  const offsets: number[] = [];
  const reader = transcript(file, (offset) => {
    offsets.push(offset);
    return Promise.resolve(slice(offset === 0 ? [{ text: envelope }, { text: "later chatter" }] : [{ text: "later chatter" }]));
  });
  assert.equal(await probe(reader, workspace).lookup(CORRELATION), envelope);
  assert.deepEqual(offsets, [1024, 0]);
});

test("a transcript that cannot be read in time still keeps the quarantine (no envelope is invented)", async () => {
  const { file, workspace } = await bigTranscript("envelope-tail-unreadable");
  const reader = transcript(file, () => never());
  assert.equal(await probe(reader, workspace).lookup(CORRELATION), undefined);
});

test("Muse's grey 242 composer tip counts as an empty box (raw capture from operador, 2026-11-04)", () => {
  const raw = "\u001b[0m\u001b[38;5;214m\u001b[49m❯ \u001b[38;5;242m/goal pins a session objective with a progress bar\u001b[39m";
  const pane = ["◆ Worked for 11m 03s · 11:02 PM · 4/Nov", "─".repeat(20), raw, "─".repeat(20),
    "  muse-wonder-full-1.0 · max · ~/.cauce/operador/space/projects · YOLO"].join("\n");
  assert.equal(inputBoxState(pane).occupied, false);
  // Without the styled capture the same words are indistinguishable from typed text.
  // eslint-disable-next-line no-control-regex
  assert.equal(inputBoxState(pane.replace(/\u001b\[[0-9;]*m/gu, "")).occupied, true);
});
