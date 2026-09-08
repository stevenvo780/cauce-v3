import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { validateStructuredOutput } from "../sdk/output-parser.js";
import { envelopeHasCorrelation, stripJsonFence } from "./envelope.js";
import { SharedTuiPointerStore, type NativePointerBinding } from "./native-pointer.js";
import { transcriptDirectoryIn } from "./session.js";
import { claudeTranscript, type TranscriptEntry } from "./transcript.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 1000;

interface FileSnapshot {
  readonly metadata: BigIntStats;
  readonly size: number;
  readonly digest: string;
}

export interface NativeTurnSnapshot {
  readonly binding: NativePointerBinding;
  readonly directory: string;
  readonly files: ReadonlyMap<string, FileSnapshot>;
  readonly expectedNativeId?: string;
}

type WitnessResult = "written" | "unchanged" | "unverified" | "conflict";

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeFile(metadata: BigIntStats): boolean {
  const uid = process.geteuid?.();
  return uid !== undefined && metadata.isFile() && metadata.uid === BigInt(uid)
    && metadata.nlink === 1n && (metadata.mode & 0o022n) === 0n
    && metadata.size >= 0n && metadata.size <= BigInt(MAX_FILE_BYTES);
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function secureRead(file: string, remainingBytes: number): Promise<{ metadata: BigIntStats; buffer: Buffer }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!safeFile(metadata) || metadata.size > BigInt(remainingBytes)) {
      throw new Error("Unsafe or over-budget native transcript");
    }
    const buffer = Buffer.alloc(Number(metadata.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error("Native transcript shortened");
      offset += bytesRead;
    }
    if (!unchanged(metadata, await handle.stat({ bigint: true }))
      || !unchanged(metadata, await lstat(file, { bigint: true }))) {
      throw new Error("Native transcript changed while reading");
    }
    return { metadata, buffer };
  } finally {
    await handle.close();
  }
}

async function filesIn(directory: string): Promise<readonly string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((name) => name.endsWith(".jsonl"));
  if (files.length > MAX_FILES) throw new Error("Native transcript inventory exceeds witness budget");
  return files.map((name) => join(directory, name));
}

function appendedEntries(buffer: Buffer, offset: number): readonly TranscriptEntry[] {
  // A line started before the cut cannot attest this turn, even when it is completed afterwards.
  const start = offset === 0 || buffer[offset - 1] === 10 ? offset : buffer.indexOf(10, offset) + 1;
  if (start === 0 && offset !== 0) return [];
  const end = buffer.lastIndexOf(10);
  if (end < start) return [];
  const entries: TranscriptEntry[] = [];
  for (const line of buffer.subarray(start, end).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Native transcript entry is invalid");
    }
    entries.push(value);
  }
  return entries;
}

/** Observes only this shared TUI's correlated terminal envelopes; headless results are not input. */
export class NativePointerAttestor {
  constructor(
    private readonly store: SharedTuiPointerStore,
    private readonly binding: NativePointerBinding,
  ) {}

  async capture(baseline: ReadonlyMap<string, number>): Promise<NativeTurnSnapshot | undefined> {
    try {
      await this.store.recover();
      const binding: NativePointerBinding = {
        ...this.binding,
        configDirectory: await realpath(this.binding.configDirectory),
        workspace: await realpath(this.binding.workspace),
      };
      const pointer = await this.store.read(binding);
      if (pointer.state === "invalid") return undefined;
      const canonicalBaseline = new Map<string, number>();
      for (const [file, size] of baseline) {
        const canonical = await realpath(file);
        if (canonicalBaseline.has(canonical)) return undefined;
        canonicalBaseline.set(canonical, size);
      }
      const directory = transcriptDirectoryIn(binding.configDirectory, binding.workspace);
      try {
        if (await realpath(directory) !== directory) return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      const files = new Map<string, FileSnapshot>();
      let total = 0;
      for (const file of await filesIn(directory)) {
        const read = await secureRead(file, MAX_SNAPSHOT_BYTES - total);
        const size = canonicalBaseline.get(file);
        if (size === undefined || size !== read.buffer.length) return undefined;
        total += size;
        if (total > MAX_SNAPSHOT_BYTES) return undefined;
        files.set(file, { metadata: read.metadata, size, digest: digest(read.buffer) });
      }
      if (files.size !== baseline.size) return undefined;
      return {
        binding, directory, files,
        ...(pointer.state === "valid" ? { expectedNativeId: pointer.nativeId } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async publish(
    snapshot: NativeTurnSnapshot,
    correlationId: string,
    promptText: string,
    paneGeneration: string,
    stillCurrent: () => Promise<boolean>,
    mcpDeposited = false,
  ): Promise<WitnessResult> {
    try {
      if (!/^[a-f0-9]{64}$/u.test(correlationId)) return "unverified";
      if (await realpath(snapshot.directory) !== snapshot.directory) return "unverified";
      const port = claudeTranscript(snapshot.binding.configDirectory, snapshot.binding.workspace);
      const candidates: { file: string; nativeId: string; metadata: BigIntStats }[] = [];
      let total = 0;
      for (const file of await filesIn(snapshot.directory)) {
        const before = snapshot.files.get(file);
        const observed = await lstat(file, { bigint: true });
        if (!safeFile(observed)) return "unverified";
        if (before !== undefined && unchanged(before.metadata, observed)) continue;
        const read = await secureRead(file, MAX_SNAPSHOT_BYTES - total);
        total += read.buffer.length;
        if (total > MAX_SNAPSHOT_BYTES) return "unverified";
        const offset = before?.size ?? 0;
        if (before !== undefined && (before.metadata.dev !== read.metadata.dev
          || before.metadata.ino !== read.metadata.ino || offset > read.buffer.length
          || digest(read.buffer.subarray(0, offset)) !== before.digest)) return "unverified";
        const entries = appendedEntries(read.buffer, offset);
        const nativeId = basename(file, ".jsonl");
        const injected = port.findInjected(file, entries, promptText);
        let matched = false;
        if (mcpDeposited && injected !== undefined) {
          const terminal = port.findAnswer(entries, injected.key);
          if (terminal?.kind === "answer" && UUID.test(nativeId)
            && terminal.sessionId === nativeId && injected.sessionId === nativeId) matched = true;
        }
        for (const entry of entries) {
          const outcome = port.findEnvelope?.([entry], correlationId);
          if (outcome === undefined) continue;
          if (outcome.kind !== "answer" || !UUID.test(nativeId)
            || outcome.sessionId !== nativeId
            || (injected !== undefined && injected.sessionId !== nativeId)
            || !envelopeHasCorrelation(outcome.text, correlationId)) return "unverified";
          validateStructuredOutput(JSON.parse(stripJsonFence(outcome.text)) as unknown);
          matched = true;
        }
        if (matched) candidates.push({ file, nativeId, metadata: read.metadata });
      }
      const candidate = candidates[0];
      if (candidates.length !== 1 || candidate === undefined) return "unverified";
      if (!unchanged(candidate.metadata, await lstat(candidate.file, { bigint: true }))) {
        return "unverified";
      }
      if (await realpath(this.binding.configDirectory) !== snapshot.binding.configDirectory
        || await realpath(this.binding.workspace) !== snapshot.binding.workspace) return "unverified";
      return await this.store.publishWitness({
        binding: snapshot.binding,
        nativeId: candidate.nativeId,
        paneGeneration,
        stillCurrent: async () => unchanged(candidate.metadata, await lstat(candidate.file, { bigint: true }))
          && await realpath(this.binding.configDirectory) === snapshot.binding.configDirectory
          && await realpath(this.binding.workspace) === snapshot.binding.workspace
          && await stillCurrent(),
        ...(snapshot.expectedNativeId === undefined ? {} : { expectedNativeId: snapshot.expectedNativeId }),
      });
    } catch {
      return "unverified";
    }
  }
}
