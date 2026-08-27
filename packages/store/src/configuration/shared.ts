import type { ConfigMutation } from '@cauce/protocol';
import { ConfigurationError } from './contracts.js';

export function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** alias_routing_ceiling has no mutable value: it is granted or revoked. */
type ValuedConfigMutation = Exclude<ConfigMutation, { resource: 'alias_routing_ceiling' }>;

export function valueRequired(mutation: ValuedConfigMutation): Record<string, unknown> {
  if (mutation.action === 'delete') return {};
  if (!mutation.value) throw new ConfigurationError('conflict', `${mutation.resource} ${mutation.action} requires value`);
  return mutation.value;
}

export function databaseError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['23503', '23505', '23514', '23P01'].includes(code)) {
    throw new ConfigurationError('conflict', 'configuration change violates a durable constraint');
  }
  throw error;
}

/** Reject generic mutations whose runtime projection cannot be synchronously acknowledged. */
export function assertRuntimeSynchronizedMutation(mutation: unknown): void {
  if (mutation === null || typeof mutation !== 'object' || Array.isArray(mutation)) return;
  const record = mutation as Record<string, unknown>;
  if (record.resource === 'agent_profile') {
    throw new ConfigurationError(
      'invalid_input',
      'agent_profile is only writable through the canonical profile endpoint with runtime ACK',
    );
  }
  if (record.resource !== 'agent') return;
  const value = record.value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && has(value, 'role_brief')) {
    throw new ConfigurationError(
      'invalid_input',
      'agent role_brief is a read-only legacy projection; write the canonical profile instead',
    );
  }
}
