import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { paneGenerationKey, type PaneIdentity } from "../tmux.js";
import type { FileQuarantineState, QuarantinePersistence } from "./contracts.js";

async function fileQuarantineState(
  path: string,
  identity: PaneIdentity,
): Promise<FileQuarantineState> {
  const states: FileQuarantineState[] = [];
  const marker = await readQuarantineMarker(path);
  states.push(marker.state === "present"
    ? (marker.value === paneGenerationKey(identity) ? "current" : "stale")
    : marker.state);
  try {
    const base = basename(path);
    const names = await readdir(dirname(path));
    const pendingNames = names.filter((name) => name.startsWith(`${base}.`)
      && name.endsWith(".pending"));
    // A `.tmp` for an ACTIVE marker proves a durable write was left half-finished. The only
    // exceptions are `.arming` preparations with exact correlation+token: by protocol, the
    // paste cannot start until `commitPrepared` publishes the `.pending` name, so a crash or
    // late finalization at that phase is recoverable and cannot block another turn.
    if (names.some((name) => (name.startsWith(`${base}.`) || name.startsWith(`.${base}.`))
      && name.endsWith(".tmp")
      && !isPendingQuarantinePreparationArtifact(base, name))) states.push("unreadable");
    for (const name of pendingNames) {
      const pending = await readQuarantineMarker(join(dirname(path), name));
      states.push(pending.state === "present"
        ? (pending.value === paneGenerationKey(identity) ? "current" : "stale")
        : "unreadable");
    }
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") states.push("unreadable");
  }
  if (states.includes("current")) return "current";
  if (states.includes("unreadable")) return "unreadable";
  return states.includes("stale") ? "stale" : "absent";
}

export async function readQuarantineMarker(path: string): Promise<
  | { readonly state: "present"; readonly value: string }
  | { readonly state: "absent" | "unreadable" }
> {
  try {
    const value = (await readFile(path, "utf8")).replace(/\r?\n$/u, "");
    return /^\$[0-9]+:@[0-9]+:%[0-9]+:[0-9]+$/u.test(value)
      ? { state: "present", value }
      : { state: "unreadable" };
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
}

/** Atomic, private, synced write: never stores delivery text. */
async function persistQuarantineMarker(target: string, identity: PaneIdentity): Promise<boolean> {
  const directory = dirname(target);
  const temporary = join(
    directory,
    `.${basename(target)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${paneGenerationKey(identity)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export function pendingQuarantinePath(path: string, correlationId: string): string {
  return `${path}.${correlationId}.pending`;
}

export function pendingQuarantinePreparationPath(pendingPath: string, attemptToken: string): string {
  return `${pendingPath.slice(0, -".pending".length)}.${attemptToken}.arming`;
}

/** Only recognises artefacts that the protocol guarantees predate any paste. */
function isPendingQuarantinePreparationArtifact(base: string, name: string): boolean {
  const token = "[a-f0-9]{64}";
  if (name.startsWith(`${base}.`) && name.endsWith(".arming")) {
    const body = name.slice(`${base}.`.length, -".arming".length);
    return new RegExp(`^${token}\\.${token}$`, "u").test(body);
  }
  if (!name.startsWith(`.${base}.`) || !name.endsWith(".tmp")) return false;
  const body = name.slice(`.${base}.`.length, -".tmp".length);
  return new RegExp(`^${token}\\.${token}\\.arming\\.[0-9]+\\.[a-f0-9]{16}$`, "u")
    .test(body);
}

/**
 * Publishes an already-durable preparation without replacing another attempt.
 *
 * `link` is the name CAS missing from `rename`: EEXIST preserves the foreign destination byte
 * for byte. The hard-link is synced before the arming phase is removed: a crash before the link
 * leaves only an ignorable preparation, and after it a recoverable pending remains.
 */
async function commitPreparedQuarantineMarker(
  preparedPath: string,
  pendingPath: string,
  identity: PaneIdentity,
): Promise<boolean> {
  if (dirname(preparedPath) !== dirname(pendingPath)) return false;
  const expected = paneGenerationKey(identity);
  const prepared = await readQuarantineMarker(preparedPath);
  if (prepared.state !== "present" || prepared.value !== expected) return false;
  let linked = false;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await link(preparedPath, pendingPath);
    linked = true;
    const published = await readQuarantineMarker(pendingPath);
    if (published.state !== "present" || published.value !== expected) throw new Error("bad link");
    directoryHandle = await open(dirname(pendingPath), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    // The pending is already durable. Failure to remove the arming name does not revert the
    // commit: that phase is contractually optional and both names point at the same private inode.
    await unlink(preparedPath).catch(() => undefined);
    return true;
  } catch {
    // Only compensate the destination if THIS link created it. EEXIST or other rejection
    // never deletes a marker that was already at `pendingPath`.
    if (linked) await clearPendingQuarantineFile(pendingPath);
    return false;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function clearPendingQuarantineFile(path: string): Promise<boolean> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await unlink(path);
    directoryHandle = await open(dirname(path), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

/** Production implementation: atomic+fsync write and fail-closed read. */
export const fileQuarantinePersistence: QuarantinePersistence = {
  inspect: fileQuarantineState,
  persist: persistQuarantineMarker,
  commitPrepared: commitPreparedQuarantineMarker,
  clear: clearPendingQuarantineFile,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}
