import { constants as fsConstants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { realpathSync } from "node:fs";
import {
  atomicWrite,
  defaultDirectoryFsync,
  recoverAtomicArtifacts,
} from "../sdk/durable-store/atomic-state.js";
import {
  SHARED_TUI_POINTER_FILE,
  type DirectoryFsync,
} from "../sdk/durable-store/contracts.js";

export { SHARED_TUI_POINTER_FILE } from "../sdk/durable-store/contracts.js";

const MAX_POINTER_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/u;
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,512}$/u;
const PANE_GENERATION = /^\$[0-9]+:@[0-9]+:%[0-9]+:[1-9][0-9]*$/u;
const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);

export interface NativePointerBinding {
  readonly alias: string;
  readonly harness: "claude";
  readonly configDirectory: string;
  readonly workspace: string;
}

interface NativePointerDocument {
  readonly schemaVersion: 1;
  readonly binding: NativePointerBinding;
  readonly native_id: string;
}

export type NativePointerRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | {
    readonly state: "valid";
    readonly binding: NativePointerBinding;
    readonly nativeId: string;
  };

export interface PublishWitnessInput {
  readonly binding: NativePointerBinding;
  readonly nativeId: string;
  readonly expectedNativeId?: string;
  readonly paneGeneration: string;
  stillCurrent(): Promise<boolean>;
}

export type PublishWitnessResult = "written" | "unchanged" | "conflict";

export interface SharedTuiPointerStoreOptions {
  readonly directoryFsync?: DirectoryFsync;
}

type StoredRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly document: NativePointerDocument };

const serializationTails = new Map<string, Promise<void>>();

function invalidInput(message: string): never {
  throw new TypeError(message);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validPathInput(value: string): boolean {
  return isAbsolute(value)
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
    && !value.includes("\0");
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!validPathInput(value)) invalidInput("Native pointer binding directory is invalid");
  let canonical: string;
  try {
    canonical = await realpath(normalize(value));
  } catch {
    invalidInput("Native pointer binding directory is unavailable");
  }
  if (!validPathInput(canonical) || normalize(canonical) !== canonical) {
    invalidInput("Native pointer binding directory is invalid");
  }
  let handle;
  try {
    handle = await open(
      canonical,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
    );
    if (!(await handle.stat()).isDirectory()) {
      invalidInput("Native pointer binding path is not a directory");
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    invalidInput("Native pointer binding directory is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return canonical;
}

async function normalizeBinding(value: unknown): Promise<NativePointerBinding> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidInput("Native pointer binding is invalid");
  }
  const binding = value as Record<string, unknown>;
  if (!exactKeys(binding, ["alias", "harness", "configDirectory", "workspace"])
    || typeof binding.alias !== "string"
    || !ALIAS.test(binding.alias)
    || binding.harness !== "claude"
    || typeof binding.configDirectory !== "string"
    || typeof binding.workspace !== "string") invalidInput("Native pointer binding is invalid");
  const [configDirectory, workspace] = await Promise.all([
    canonicalDirectory(binding.configDirectory),
    canonicalDirectory(binding.workspace),
  ]);
  return { alias: binding.alias, harness: "claude", configDirectory, workspace };
}

function validateDocument(value: unknown): NativePointerDocument | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["schemaVersion", "binding", "native_id"])
    || root.schemaVersion !== 1
    || typeof root.native_id !== "string"
    || !NATIVE_ID.test(root.native_id)
    || typeof root.binding !== "object"
    || root.binding === null
    || Array.isArray(root.binding)) return undefined;
  const binding = root.binding as Record<string, unknown>;
  if (!exactKeys(binding, ["alias", "harness", "configDirectory", "workspace"])
    || typeof binding.alias !== "string"
    || !ALIAS.test(binding.alias)
    || binding.harness !== "claude"
    || typeof binding.configDirectory !== "string"
    || !validPathInput(binding.configDirectory)
    || normalize(binding.configDirectory) !== binding.configDirectory
    || typeof binding.workspace !== "string"
    || !validPathInput(binding.workspace)
    || normalize(binding.workspace) !== binding.workspace) return undefined;
  return {
    schemaVersion: 1,
    binding: {
      alias: binding.alias,
      harness: "claude",
      configDirectory: binding.configDirectory,
      workspace: binding.workspace,
    },
    native_id: root.native_id,
  };
}

async function readStored(path: string): Promise<StoredRead> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "invalid" };
  }
  try {
    const before = await handle.stat({ bigint: true });
    const euid = process.geteuid?.();
    if (euid === undefined
      || !before.isFile()
      || before.uid !== BigInt(euid)
      || (before.mode & 0o777n) !== 0o600n
      || before.nlink !== 1n
      || before.size <= 0n
      || before.size > BigInt(MAX_POINTER_BYTES)) return { state: "invalid" };

    const buffer = Buffer.alloc(MAX_POINTER_BYTES + 1);
    let length = 0;
    while (length <= MAX_POINTER_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        MAX_POINTER_BYTES + 1 - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length > MAX_POINTER_BYTES
      || BigInt(length) !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) return { state: "invalid" };

    const text = buffer.subarray(0, length).toString("utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      return { state: "invalid" };
    }
    const document = validateDocument(decoded);
    if (document === undefined || text !== `${JSON.stringify(document)}\n`) {
      return { state: "invalid" };
    }
    return { state: "valid", document };
  } catch {
    return { state: "invalid" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameBinding(left: NativePointerBinding, right: NativePointerBinding): boolean {
  return left.alias === right.alias
    && left.configDirectory === right.configDirectory
    && left.workspace === right.workspace;
}

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = serializationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  serializationTails.set(key, turn);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (serializationTails.get(key) === turn) serializationTails.delete(key);
  }
}

/**
 * Private pointer store for the sole shared-session runtime writer in one alias.
 * Serialization spans store instances in this process; another process may only call `read`.
 */
export class SharedTuiPointerStore {
  private readonly stateDirectory: string;
  private readonly pointerPath: string;
  private readonly directoryFsync: DirectoryFsync;

  constructor(stateDirectory: string, options: SharedTuiPointerStoreOptions = {}) {
    if (!validPathInput(stateDirectory)) invalidInput("Shared TUI state directory is invalid");
    try {
      this.stateDirectory = realpathSync.native(normalize(stateDirectory));
    } catch {
      invalidInput("Shared TUI state directory is unavailable");
    }
    this.pointerPath = join(this.stateDirectory, SHARED_TUI_POINTER_FILE);
    this.directoryFsync = options.directoryFsync ?? defaultDirectoryFsync;
  }

  async read(binding: NativePointerBinding): Promise<NativePointerRead> {
    const normalized = await normalizeBinding(binding);
    const stored = await this.readStoredSecurely();
    if (stored.state !== "valid") return stored;
    if (!sameBinding(stored.document.binding, normalized)) return { state: "invalid" };
    return {
      state: "valid",
      binding: stored.document.binding,
      nativeId: stored.document.native_id,
    };
  }

  async recover(): Promise<void> {
    await serialize(this.pointerPath, async () => {
      if (!await this.stateDirectoryIsSecure()) {
        throw new Error("Shared TUI state directory failed secure validation");
      }
      await recoverAtomicArtifacts(
        this.stateDirectory,
        [SHARED_TUI_POINTER_FILE],
        this.directoryFsync,
      );
    });
  }

  async publishWitness(input: PublishWitnessInput): Promise<PublishWitnessResult> {
    const binding = await normalizeBinding(input.binding);
    if (!NATIVE_ID.test(input.nativeId)
      || (input.expectedNativeId !== undefined && !NATIVE_ID.test(input.expectedNativeId))
      || !PANE_GENERATION.test(input.paneGeneration)
      || typeof input.stillCurrent !== "function") {
      invalidInput("Shared TUI native pointer witness is invalid");
    }
    return serialize(this.pointerPath, async () => {
      if (!await this.stateDirectoryIsSecure()) return "conflict";
      await recoverAtomicArtifacts(
        this.stateDirectory,
        [SHARED_TUI_POINTER_FILE],
        this.directoryFsync,
      );
      const stored = await this.readStoredSecurely();
      if (stored.state === "invalid") return "conflict";
      if (stored.state === "absent") {
        if (input.expectedNativeId !== undefined) return "conflict";
        if (!await witnessIsStillCurrent(input)) return "conflict";
        await this.write(binding, input.nativeId);
        return "written";
      }
      if (!sameBinding(stored.document.binding, binding)) return "conflict";
      if (input.expectedNativeId !== undefined
        && input.expectedNativeId !== stored.document.native_id) return "conflict";
      if (stored.document.native_id === input.nativeId) return "unchanged";
      if (input.expectedNativeId === undefined) return "conflict";
      if (!await witnessIsStillCurrent(input)) return "conflict";
      await this.write(binding, input.nativeId);
      return "written";
    });
  }

  private async readStoredSecurely(): Promise<StoredRead> {
    if (!await this.stateDirectoryIsSecure()) return { state: "invalid" };
    if (await this.hasAtomicArtifacts()) return { state: "invalid" };
    return readStored(this.pointerPath);
  }

  private async stateDirectoryIsSecure(): Promise<boolean> {
    let directory;
    try {
      directory = await open(
        this.stateDirectory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
      );
      const metadata = await directory.stat({ bigint: true });
      const euid = process.geteuid?.();
      if (euid === undefined
        || !metadata.isDirectory()
        || metadata.uid !== BigInt(euid)
        || (metadata.mode & 0o022n) !== 0n) return false;
    } catch {
      return false;
    } finally {
      await directory?.close().catch(() => undefined);
    }
    return true;
  }

  private async hasAtomicArtifacts(): Promise<boolean> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.stateDirectory);
    } catch {
      return true;
    }
    return entries.some((entry) => entry.startsWith(`${SHARED_TUI_POINTER_FILE}.`)
      && (entry.includes(".atomic-") || entry.endsWith(".tmp") || entry.endsWith(".rollback")));
  }

  private async write(binding: NativePointerBinding, nativeId: string): Promise<void> {
    const document: NativePointerDocument = {
      schemaVersion: 1,
      binding,
      native_id: nativeId,
    };
    await atomicWrite(this.pointerPath, document, this.directoryFsync);
    const persisted = await readStored(this.pointerPath);
    if (persisted.state !== "valid"
      || !sameBinding(persisted.document.binding, binding)
      || persisted.document.native_id !== nativeId) {
      throw new Error("Shared TUI native pointer persistence could not be verified");
    }
  }
}

async function witnessIsStillCurrent(input: PublishWitnessInput): Promise<boolean> {
  try {
    // JavaScript callers may resolve a truthy non-boolean; only literal true credits the fence.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    return await input.stillCurrent() === true;
  } catch {
    return false;
  }
}
