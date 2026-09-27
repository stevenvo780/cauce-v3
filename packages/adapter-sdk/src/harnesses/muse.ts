import { parseMuseOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const museDefinition: HarnessDefinition = {
  id: "muse",
  command: "muse",
  baseArgs: ["serve"],
  capabilities: capabilities("muse", true),
  sessionStrategy: { kind: "generated" },
  sessionArgs: () => [],
  parse: parseMuseOutput,
};
