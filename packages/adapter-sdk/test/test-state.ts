import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

// Two suites running at once share this working tree; without a per-process
// segment each one rm -rf's directories the other is still writing to.
export function testStateScope(): string {
  return process.env.CAUCE_TEST_STATE_ID ?? String(process.pid);
}

function processRoot(): string {
  return resolve(tmpdir(), "cauce-adapter-sdk-test-state", testStateScope());
}

process.once("exit", () => {
  rmSync(processRoot(), { recursive: true, force: true });
});

export function testStateRoot(...segments: string[]): string {
  const root = processRoot();
  const target = resolve(root, ...segments);
  const inside = relative(root, target);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`test state path escapes its per-process root: ${segments.join("/")}`);
  }
  return target;
}
