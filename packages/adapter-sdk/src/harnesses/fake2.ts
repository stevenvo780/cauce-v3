import { parseDirectOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

// Second test harness: same fake CLI contract as `fake`, its own adapter id so
// multi-harness paths (packaging, sessions, fleet templates) can be exercised
// with two distinct test harnesses.
export const fake2Definition: HarnessDefinition = {
  id: "fake2",
  command: "cauce-fake-harness",
  baseArgs: [],
  capabilities: capabilities("fake2", true),
  sessionStrategy: { kind: "generated" },
  sessionArgs: ({ sessionId }) => (sessionId === undefined ? [] : ["--session", sessionId]),
  parse: parseDirectOutput,
};
