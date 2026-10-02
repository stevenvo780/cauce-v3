const SHA = /^[0-9a-f]{64}$/u;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** A current file snapshot alone cannot attest what the session adopted. */
export function profileIsAdopted(profile: AgentPerfil | undefined): boolean {
  const verification = object(profile?.runtime_verification);
  const adoption = object(profile?.runtime_adoption);
  const names = new Set((profile?.ficheros ?? []).map((file) => file.nombre));
  if (profile?.runtime_state !== 'applied' || profile.exists !== true || profile.agent_enabled !== true
    || names.size !== profile.ficheros?.length || !Number.isSafeInteger(profile.revision)
    || Number(profile.revision) < 1 || profile.applied_revision !== profile.revision
    || verification?.state !== 'current' || typeof verification.generation !== 'string'
    || verification.generation.length === 0 || !Array.isArray(verification.documents)
    || verification.documents.length === 0 || verification.documents.length !== names.size
    || adoption?.evidence !== 'adapter_delivery'
    || adoption.revision !== profile.revision || adoption.generation !== verification.generation
    || typeof adoption.adopted_at !== 'string' || !Number.isFinite(Date.parse(adoption.adopted_at))
    || !Array.isArray(adoption.documents) || adoption.documents.length !== verification.documents.length) return false;
  const expected = new Map<string, { path: string; sha: string }>();
  for (const value of verification.documents) {
    const document = object(value);
    if (typeof document?.name !== 'string' || !names.has(document.name) || expected.has(document.name)
      || typeof document.path !== 'string' || !document.path.startsWith('/')
      || !document.path.endsWith(`/${document.name}`) || document.path.includes('\0')
      || document.path.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')
      || typeof document.expected_sha !== 'string' || !SHA.test(document.expected_sha)
      || document.current !== true || document.observed_sha !== document.expected_sha
      || !Number.isSafeInteger(document.expected_bytes) || Number(document.expected_bytes) < 0
      || document.observed_bytes !== document.expected_bytes) return false;
    expected.set(document.name, { path: document.path, sha: document.expected_sha });
  }
  for (const value of adoption.documents) {
    const document = object(value);
    if (typeof document?.name !== 'string') return false;
    const file = expected.get(document.name);
    if (!file || file.path !== document.path || file.sha !== document.sha) return false;
    expected.delete(document.name);
  }
  return expected.size === 0;
}

export function pendingProfileReceipt(
  value: unknown, tenant: string, alias: string, names: readonly string[],
): { revision: number; generation: string } | undefined {
  const row = object(value);
  const verification = object(row?.runtime_verification);
  if (row?.ok !== true || row.state !== 'pending_session_refresh'
    || row.tenant_id !== tenant || row.alias !== alias || !Number.isSafeInteger(row.revision)
    || Number(row.revision) < 1 || row.runtime_adoption !== null
    || verification?.state !== 'current' || typeof verification.generation !== 'string'
    || verification.generation.length === 0 || !Array.isArray(row.acknowledgements)
    || !Array.isArray(verification.documents) || names.length === 0
    || row.acknowledgements.length !== names.length || verification.documents.length !== names.length) return undefined;
  const remaining = new Set(names);
  const evidence = new Map(verification.documents.map((item: unknown) => {
    const document = object(item);
    return [document?.name, document];
  }));
  if (remaining.size !== names.length || evidence.size !== names.length) return undefined;
  for (const item of row.acknowledgements) {
    const ack = object(item);
    const document = evidence.get(ack?.name);
    if (typeof ack?.name !== 'string' || !remaining.delete(ack.name)
      || typeof ack.path !== 'string' || !ack.path.startsWith('/') || !ack.path.endsWith(`/${ack.name}`)
      || typeof ack.sha !== 'string' || !SHA.test(ack.sha) || !Number.isSafeInteger(ack.bytes)
      || Number(ack.bytes) < 0 || ack.generation !== verification.generation
      || !['written', 'already_current', 'preserved'].includes(String(ack.state))
      || document?.path !== ack.path || document.current !== true
      || document.expected_sha !== ack.sha || document.observed_sha !== ack.sha
      || document.expected_bytes !== ack.bytes || document.observed_bytes !== ack.bytes) return undefined;
  }
  return remaining.size === 0 ? { revision: Number(row.revision), generation: verification.generation } : undefined;
}
import type { AgentPerfil } from '../../api/types';
