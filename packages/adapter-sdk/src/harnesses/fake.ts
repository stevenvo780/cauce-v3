import { parseDirectOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const fakeDefinition: HarnessDefinition = {
  id: "fake",
  command: "cauce-fake-harness",
  baseArgs: [],
  capabilities: capabilities("fake", true),
  sessionStrategy: { kind: "generated" },
  sessionArgs: ({ sessionId }) => (sessionId === undefined ? [] : ["--session", sessionId]),
  parse: parseDirectOutput,
};
