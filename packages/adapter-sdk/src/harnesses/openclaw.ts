import { parseOpenClawOutput } from "../sdk/output-parser.js";
import { HARNESS_START_MARKER, type HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";
import { OPENCLAW_BRIDGE_PATH } from "./bridge-paths.js";

/** OpenClaw 2026.6.6 is invoked in-process by the packaged stdin bridge. */
export const openClawDefinition: HarnessDefinition = {
  id: "openclaw",
  command: process.execPath,
  baseArgs: [OPENCLAW_BRIDGE_PATH],
  capabilities: capabilities("openclaw", true, {
    loopback_api: true,
    stable_alias_sessions: true,
    api_cancellation: "abort_signal",
  }),
  sessionStrategy: { kind: "generated" },
  // El puente es codigo nuestro y escribe la marca en stderr justo antes de la llamada
  // efectiva; si no aparece, el fallo fue de arranque del propio puente.
  startWitness: { kind: "stderr-marker", marker: HARNESS_START_MARKER },
  sessionArgs: ({ sessionId }) => (sessionId === undefined ? [] : ["--session-key", sessionId]),
  parse: parseOpenClawOutput,
};
