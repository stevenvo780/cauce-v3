import { parseMuseOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

/**
 * Muse Code (Meta), headless mode. `--json` emits JSONL records while the turn progresses; the prompt arrives on
 * stdin through `--prompt-file /dev/stdin` (the CLI has no bare `-`). `--yolo` because the adapter runs inside
 * an isolated container, like the other harnesses; `--trust-workspace` so the alias's AGENTS.md is loaded.
 */
export const museDefinition: HarnessDefinition = {
  id: "muse",
  command: "muse",
  baseArgs: ["exec", "--json", "--yolo", "--trust-workspace", "--prompt-file", "/dev/stdin"],
  capabilities: capabilities("muse", true),
  sessionStrategy: { kind: "observed" },
  startWitness: { kind: "stdout-first-byte" },
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["--session-id", sessionId] : [],
  parse: parseMuseOutput,
};
