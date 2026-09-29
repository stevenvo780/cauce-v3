export const DEFAULT_MESSAGE_TIMEOUT_MS = 24 * 60 * 60_000;
// A hung turn goes quiet: 3 h without progress (longest legitimate gap measured: 76 min), never a duration cap.
export const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 3 * 60 * 60_000;
export type HarnessTimeoutKind = "hard" | "no-progress";
