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
