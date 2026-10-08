import { z } from 'zod';
import type { ProviderAuthCode } from './provider-auth.types.js';

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const ProviderAuthRequestSchema = z.object({
  operation_id: z.uuid(), expected_operation_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  request_id: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  provider_id: z.enum(['codex', 'claude', 'gemini', 'minimax', 'grok', 'feihoa']),
  account_id: Identifier, harness_id: Identifier, host_id: Identifier,
  runtime_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/), profile_id: Identifier,
}).strict();
export const ProviderAuthSessionIdSchema = z.uuid();

export class ProviderAuthError extends Error {
  constructor(readonly code: ProviderAuthCode) { super('provider authentication could not be verified'); }
}
