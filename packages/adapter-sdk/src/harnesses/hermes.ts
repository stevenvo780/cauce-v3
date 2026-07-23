import { parseHermesOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";
import { HERMES_BRIDGE_PATH } from "./bridge-paths.js";

export const hermesDefinition: HarnessDefinition = {
  id: "hermes",
  command: "python3",
  baseArgs: [HERMES_BRIDGE_PATH],
  capabilities: capabilities("hermes", false),
  sessionStrategy: { kind: "none" },
  sessionArgs: () => [],
  parse: parseHermesOutput,
};
