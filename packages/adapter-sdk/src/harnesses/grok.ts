import { parseGrokOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

// Grok CLI 1.0.41, headless single turn. Why fd 0 is a file, why there is no start witness and
// how the cauce MCP server is registered: packages/adapter-sdk/README.md, "Arnés grok".
export const grokDefinition: HarnessDefinition = {
  id: "grok",
  command: "grok",
  baseArgs: ["--prompt-file", "/dev/stdin", "--output-format", "json", "--always-approve", "--verbatim"],
  capabilities: capabilities("grok", true),
  sessionStrategy: { kind: "observed" },
  stdinSource: "file",
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["--resume", sessionId] : [],
  parse: parseGrokOutput,
};
