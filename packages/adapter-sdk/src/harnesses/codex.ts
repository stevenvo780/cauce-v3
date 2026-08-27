import { parseCodexOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const codexDefinition: HarnessDefinition = {
  id: "codex",
  command: "codex",
  baseArgs: ["exec", "--skip-git-repo-check"],
  capabilities: capabilities("codex", true),
  sessionStrategy: { kind: "observed" },
  // `--json` emite JSONL según avanza el turno. Cero bytes en stdout indica que el proceso
  // no llegó a iniciar la ejecución.
  startWitness: { kind: "stdout-first-byte" },
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["resume", "--json", sessionId, "-"] : ["--json", "-"],
  parse: parseCodexOutput,
};
