import { parseOpenClawOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
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
  sessionArgs: ({ sessionId }) => (sessionId === undefined ? [] : ["--session-key", sessionId]),
  parse: parseOpenClawOutput,
};
