import { fileURLToPath } from "node:url";

// Compiled modules live at dist/src/harnesses; bridges ship at dist/bridge.
export const HERMES_BRIDGE_PATH = fileURLToPath(
  new URL("../../bridge/hermes-stdin-bridge.py", import.meta.url),
);
export const OPENCLAW_BRIDGE_PATH = fileURLToPath(
  new URL("../../bridge/openclaw-stdin-bridge.mjs", import.meta.url),
);
