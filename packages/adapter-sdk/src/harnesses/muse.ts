import { parseMuseOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

/** Muse Code (Meta), headless mode: `--json` emits JSONL as the turn progresses, via the `muse-cauce` bridge (copies the prompt from stdin to a file, since `--prompt-file` rejects a pipe); `--yolo` runs unattended in the isolated container, `--trust-workspace` loads the alias's AGENTS.md. */
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
