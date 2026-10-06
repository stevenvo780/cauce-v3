import type { CreateTerminalSessionInput, TerminalSessionGrant } from './api';

export interface TerminalGrantRequestOutcome {
  grant: TerminalSessionGrant;
  adopted: boolean;
}

export type RequestTerminalGrant = (
  sessionId: string,
  sessionToken: number,
  input: Omit<CreateTerminalSessionInput, 'request_id' | 'owner_token'>,
) => Promise<TerminalGrantRequestOutcome>;

/** What the workspace remembers about one agent's channel for as long as the agent stays open. */
export interface StageMemory {
  /** Channel mode of the last adopted grant: `harness`, `harness_rw` or `shell`. */
  channelMode?: string;
  /** The TUI auto-open is attempted ONCE per opening; a refusal is not retried in a loop. */
  liveTuiAttempted?: boolean;
}
