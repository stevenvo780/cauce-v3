import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ConsumerLeaseError } from "../errors.js";

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process guard for one long-lived consumer per stable alias. */
export class ConsumerLease {
  private constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async acquire(stateDirectory: string, alias: string, instanceId: string): Promise<ConsumerLease> {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, `.consumer-${alias}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, instance_id: instanceId })}\n`, "utf8");
        await handle.sync();
        return new ConsumerLease(path, handle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
          stale = typeof parsed.pid !== "number" || !pidIsAlive(parsed.pid);
        } catch {
          const age = await stat(path)
            .then((metadata) => Date.now() - metadata.mtimeMs)
            .catch(() => 0);
          stale = age > 30_000;
        }
        if (!stale) {
          throw new ConsumerLeaseError(`A consumer already owns stable alias '${alias}'`);
        }
        await unlink(path).catch(() => undefined);
      }
    }
    throw new ConsumerLeaseError(`Could not acquire consumer lease for '${alias}'`);
  }

  async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await unlink(this.path).catch(() => undefined);
  }
}
