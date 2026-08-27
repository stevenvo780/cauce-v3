import type { ConfigMutation } from '@cauce/protocol';

/** `invalid_input` keeps malformed operator text out of opaque PostgreSQL CHECK failures. */
export type ConfigurationErrorCode = 'forbidden' | 'conflict' | 'not_found' | 'invalid_input';

export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface ConfigurationChangeResult {
  applied: boolean;
  dry_run: boolean;
  revision: number;
  /** Revision whose inverse was executed. Null proves this was a normal configuration change. */
  rolled_back_revision_id: number | null;
  summary: string;
  mutation: ConfigMutation;
  inverse_mutation: ConfigMutation;
}
