import { parseOpenCodeOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

// Kant is currently the only OpenCode alias. Keep its persistent-server defaults
// explicit until the adapter supports per-alias harness invocation settings.
export const OPEN_CODE_KANT_ATTACH_URL = "http://127.0.0.1:4097";
export const OPEN_CODE_KANT_WORKING_DIRECTORY = "/workspace/kant";

export const openCodeDefinition: HarnessDefinition = {
  id: "opencode",
  command: "opencode",
  baseArgs: [
    "run",
    "--format",
    "json",
    "--attach",
    OPEN_CODE_KANT_ATTACH_URL,
    "--dir",
    OPEN_CODE_KANT_WORKING_DIRECTORY,
  ],
  capabilities: capabilities("opencode", true),
  sessionStrategy: { kind: "observed" },
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["--session", sessionId] : [],
  parse: parseOpenCodeOutput,
};
