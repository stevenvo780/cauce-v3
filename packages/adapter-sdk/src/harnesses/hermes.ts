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
  // El puente es codigo nuestro y escribe la marca en stderr justo antes de la llamada
  // efectiva; si no aparece, el fallo fue de arranque del propio puente.
  startWitness: { kind: "stderr-marker", marker: HARNESS_START_MARKER },
  sessionArgs: () => [],
  parse: parseHermesOutput,
};
