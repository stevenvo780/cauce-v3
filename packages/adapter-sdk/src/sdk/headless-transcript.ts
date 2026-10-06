import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const MAX_FILES = 1_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORIES = 256;

export interface TranscriptFile {
  readonly metadata: BigIntStats;
  readonly prefix?: Buffer;
}

export interface TranscriptSnapshot {
  readonly root: string;
  readonly directories: ReadonlyMap<string, BigIntStats>;
  readonly files: ReadonlyMap<string, TranscriptFile>;
}

function owned(metadata: BigIntStats): boolean {
  const uid = process.geteuid?.();
  return uid !== undefined && metadata.uid === BigInt(uid) && (metadata.mode & 0o022n) === 0n;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.gid === right.gid && left.mode === right.mode;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function transcriptDirectory(path: string): Promise<BigIntStats | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isDirectory() || !owned(metadata) || await realpath(path) !== path) {
      throw new Error("Unsafe transcript directory");
    }
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function sameDirectory(path: string, expected: BigIntStats): Promise<boolean> {
  const current = await transcriptDirectory(path);
  return current !== undefined && sameIdentity(current, expected);
}

export async function readTranscript(file: string, remainingBytes = MAX_BYTES): Promise<{ metadata: BigIntStats; bytes: Buffer }> {
  if (await realpath(file) !== file) throw new Error("Noncanonical transcript path");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || !owned(metadata) || metadata.nlink !== 1n
      || metadata.size < 0n || metadata.size > BigInt(remainingBytes)) throw new Error("Unsafe transcript file");
    const bytes = Buffer.alloc(Number(metadata.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("Transcript shortened");
      offset += read.bytesRead;
    }
    if (!sameFile(metadata, await handle.stat({ bigint: true }))
      || !sameFile(metadata, await lstat(file, { bigint: true }))
      || await realpath(file) !== file) throw new Error("Transcript changed during read");
    return { metadata, bytes };
  } finally { await handle.close(); }
}

export async function snapshotTranscripts(
  root: string, recursive: boolean, ownFile: (file: string) => boolean,
): Promise<TranscriptSnapshot> {
  const files = new Map<string, TranscriptFile>();
  const directories = new Map<string, BigIntStats>();
  let capturedBytes = 0;
  async function visit(directory: string): Promise<void> {
    const metadata = await transcriptDirectory(directory);
    if (metadata === undefined) return;
    directories.set(directory, metadata);
    if (directories.size > MAX_DIRECTORIES) throw new Error("Transcript directory limit");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (recursive && entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith(".jsonl")) {
        if (!entry.isFile() || files.size >= MAX_FILES) throw new Error("Transcript inventory limit");
        const stat = await lstat(file, { bigint: true });
        if (ownFile(file)) {
          const read = await readTranscript(file, MAX_BYTES - capturedBytes);
          capturedBytes += read.bytes.length;
          files.set(file, { metadata: read.metadata, prefix: read.bytes });
        } else files.set(file, { metadata: stat });
      }
    }
  }
  await visit(root);
  return { root, directories, files };
}

export async function verifyTranscript(
  snapshot: TranscriptSnapshot, file: string, resumed: boolean,
): Promise<{ bytes: Buffer; appended: Buffer; metadata: BigIntStats } | undefined> {
  const inside = relative(snapshot.root, file);
  if (inside.startsWith("..") || inside.length === 0) return undefined;
  let directory = dirname(file);
  while (directory.startsWith(snapshot.root)) {
    const metadata = await transcriptDirectory(directory);
    if (metadata === undefined) return undefined;
    const previous = snapshot.directories.get(directory);
    if (previous !== undefined && !sameIdentity(previous, metadata)) return undefined;
    if (directory === snapshot.root) break;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  const before = snapshot.files.get(file);
  if (resumed ? before?.prefix === undefined : before !== undefined) return undefined;
  const read = await readTranscript(file);
  const offset = before?.prefix?.length ?? 0;
  if (before !== undefined && (before.prefix === undefined || !sameIdentity(before.metadata, read.metadata)
    || read.bytes.length < offset || !read.bytes.subarray(0, offset).equals(before.prefix)
    || (offset > 0 && before.prefix[offset - 1] !== 10))) return undefined;
  return { ...read, appended: read.bytes.subarray(offset) };
}

export async function transcriptStillCurrent(file: string, metadata: BigIntStats): Promise<boolean> {
  return await realpath(file) === file && sameFile(metadata, await lstat(file, { bigint: true }));
}

export function transcriptEntries(bytes: Buffer): readonly Record<string, unknown>[] {
  const text = bytes.toString("utf8");
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) throw new Error("Incomplete transcript");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Invalid transcript encoding");
  return text.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    const entry: unknown = JSON.parse(line);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid transcript entry");
    return entry as Record<string, unknown>;
  });
}

