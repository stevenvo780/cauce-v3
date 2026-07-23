import { parseCodexOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const codexDefinition: HarnessDefinition = {
  id: "codex",
  command: "codex",
  baseArgs: ["exec", "--skip-git-repo-check"],
  capabilities: capabilities("codex", true),
  sessionStrategy: { kind: "observed" },
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["resume", "--json", sessionId, "-"] : ["--json", "-"],
  parse: parseCodexOutput,
};
