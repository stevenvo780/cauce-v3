import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessExecutionError } from "./errors.js";

/**
 * fd 0 backed by an owner-only regular file that is already unlinked when the harness starts:
 * reopenable through /proc/self/fd/0 (a libuv socketpair is not: ENXIO), never findable by path.
 */
export function promptFileDescriptor(prompt: string): number {
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "cauce-stdin-"));
    const path = join(directory, "prompt");
    writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return openSync(path, "r");
  } catch {
    throw new ProcessExecutionError(
      "PROMPT_STDIN_UNAVAILABLE",
      "Harness prompt could not be staged as stdin; nothing was executed",
      true,
    );
  } finally {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}
