import { parseHermesOutput } from "../sdk/output-parser.js";
import { HARNESS_START_MARKER, type HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";
import { HERMES_BRIDGE_PATH } from "./bridge-paths.js";

export const hermesDefinition: HarnessDefinition = {
  id: "hermes",
  command: "python3",
  baseArgs: [HERMES_BRIDGE_PATH],
  capabilities: capabilities("hermes", false),
  sessionStrategy: { kind: "none" },
  // The bridge is our code and writes the marker to stderr right before the actual call;
  // if it does not appear, the failure was the bridge's own startup.
  startWitness: { kind: "stderr-marker", marker: HARNESS_START_MARKER },
  sessionArgs: () => [],
  parse: parseHermesOutput,
};
