import { parseClaudeOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const claudeDefinition: HarnessDefinition = {
  id: "claude",
  command: "claude",
  baseArgs: ["--print", "--output-format", "json", "--dangerously-skip-permissions"],
  capabilities: capabilities("claude", true),
  sessionStrategy: { kind: "generated" },
  sessionArgs: ({ sessionId, resume }) => {
    if (sessionId === undefined) return [];
    return resume ? ["--resume", sessionId] : ["--session-id", sessionId];
  },
  parse: parseClaudeOutput,
};
