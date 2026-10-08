import { ConfigMutationSchema } from './schemas/configuration.js';
import type { ConfigMutation } from './schemas/types.js';

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, normalized(child)]));
  }
  return value;
}
export function configurationMutationCanonical(value: unknown): string {
  return JSON.stringify(normalized(ConfigMutationSchema.parse(value)));
}
export function configurationMutationHashInput(value: unknown): string {
  return `cauce-v3:configuration-mutation:v1\n${configurationMutationCanonical(value)}`;
}
export async function configurationMutationSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(configurationMutationHashInput(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function publicConfigurationMutation(input: unknown): ConfigMutation {
  const value = ConfigMutationSchema.parse(input);
  if (value.resource === 'batch') {
    return { ...value, mutations: value.mutations.map(leaf => publicConfigurationMutation(leaf)) as typeof value.mutations };
  }
  if (value.resource !== 'provider_account' || value.value === undefined) return value;
  const { credential_ref: discarded, ...publicValue } = value.value;
  void discarded;
  return { ...value, value: publicValue };
}
export function configurationReceiptMatches(
  mutation: unknown, expected: unknown, hash: unknown, expectedHash?: string,
): boolean {
  if (!ConfigMutationSchema.safeParse(mutation).success
      || (expected !== undefined && !ConfigMutationSchema.safeParse(expected).success)) return false;
  const publicMutation = publicConfigurationMutation(mutation);
  if (configurationMutationCanonical(publicMutation) !== configurationMutationCanonical(mutation)) return false;
  if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) return false;
  if (expected === undefined) return true;
  if (configurationMutationCanonical(publicConfigurationMutation(expected)) !== configurationMutationCanonical(mutation)) return false;
  const sameFull = configurationMutationCanonical(expected) === configurationMutationCanonical(mutation);
  return hash === undefined ? sameFull : expectedHash !== undefined && hash === expectedHash;
}
