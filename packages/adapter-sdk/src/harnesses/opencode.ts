import { parseOpenCodeOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const openCodeDefinition: HarnessDefinition = {
  id: "opencode",
  command: "opencode",
  baseArgs: ["run", "--format", "json"],
  capabilities: capabilities("opencode", true),
  sessionStrategy: { kind: "generated" },
  sessionArgs: ({ sessionId }) => (sessionId === undefined ? [] : ["--session", sessionId]),
  parse: parseOpenCodeOutput,
};
