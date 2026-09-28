import { parseMuseOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

/**
 * Muse Code (Meta), headless mode. `--json` emits JSONL records while the turn progresses. The command is the
 * `muse-cauce` bridge (ops/container-runtime/muse-cauce): `--prompt-file` rejects a pipe ("is not a regular
 * file") and the adapter writes the prompt on stdin, so the bridge copies it to a file. `--yolo` because the
 * adapter runs inside an isolated container, like the other harnesses; `--trust-workspace` so the alias's
 * AGENTS.md is loaded.
 */
export const museDefinition: HarnessDefinition = {
  id: "muse",
  command: "muse-cauce",
  baseArgs: ["exec", "--json", "--yolo", "--trust-workspace"],
  capabilities: capabilities("muse", true),
  sessionStrategy: { kind: "observed" },
  startWitness: { kind: "stdout-first-byte" },
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["--session-id", sessionId] : [],
  parse: parseMuseOutput,
};
