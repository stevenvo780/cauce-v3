import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationMutationSha256, publicConfigurationMutation, type ConfigMutation } from '@cauce/protocol/configuration';
import type { ConfigurationChangeResult } from '../../api/types';
import { ApiError } from '../../api/client/core';
import { describeConfigError, executeConfigurationChange } from './config-change';

const mutation: ConfigMutation = { resource: 'provider_account', action: 'create', id: 'account', value: {
  provider: 'codex', payer_tenant_id: 'Steven', external_account_id: 'one',
  credential_ref_kind: 'env_path', credential_ref: 'PRIVATE_LOCATOR' } };
async function receipt(input = mutation): Promise<ConfigurationChangeResult> {
  return { applied: false, dry_run: true, revision: 4, summary: 'preview account', rolled_back_revision_id: null,
    mutation: publicConfigurationMutation(input), mutation_sha256: await configurationMutationSha256(input),
    inverse_mutation: { resource: 'provider_account', action: 'delete', id: input.resource === 'provider_account' ? input.id : 'account' } };
}
const reload = vi.fn(async () => ({ data: { revision: 4 } }));
afterEach(() => { vi.restoreAllMocks(); reload.mockClear(); });

describe('full intent proof before configuration transport', () => {
  it('accepts a redacted server receipt with a hash of the full request', async () => {
    const change = vi.fn(async () => receipt());
    const outcome = await executeConfigurationChange({ mutation, dryRun: true, expectedRevision: 4, change, reload });
    expect(outcome.ok).toBe(true);
    expect(change).toHaveBeenCalledWith(mutation, { dryRun: true, expectedRevision: 4 });
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_LOCATOR');
    expect(reload).not.toHaveBeenCalled();
  });
  it('rejects another locator hash even when the public payload is identical', async () => {
    const other = { ...mutation, value: { ...mutation.value, credential_ref: 'OTHER_LOCATOR' } };
    const change = vi.fn(async () => receipt(other));
    const outcome = await executeConfigurationChange({ mutation, dryRun: true, change, reload });
    expect(outcome).toMatchObject({ ok: false, uncertain: false });
    expect(reload).not.toHaveBeenCalled();
  });
  it('sends no request when the full intent digest cannot be computed', async () => {
    const change = vi.fn(async () => receipt());
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable'));
    const outcome = await executeConfigurationChange({ mutation, dryRun: false, change, reload });
    expect(outcome).toMatchObject({ ok: false, message: 'digest unavailable' });
    expect(change).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
  it('keeps a concrete 403 reason beside the Spanish action', () => {
    const described = describeConfigError(new ApiError('operator must be hub', 403, 'forbidden'), 'fallback');
    expect(described.message).toContain('permiso de control');
    expect(described.message).toContain('operator must be hub');
    const generic = describeConfigError(new ApiError('Forbidden', 403, 'forbidden'), 'fallback');
    expect(generic.message).not.toContain('Forbidden');
  });
  it('maps an expired session to re-entering instead of echoing the server sentence', () => {
    const described = describeConfigError(new ApiError('Unauthorized', 401, 'unauthorized'), 'fallback');
    expect(described.message).toContain('Tu sesión terminó');
    expect(described.message).not.toContain('Unauthorized');
  });
  it('maps rate limiting to waiting instead of echoing the server sentence', () => {
    const described = describeConfigError(new ApiError('Too Many Requests', 429, 'rate_limited'), 'fallback');
    expect(described.message).toContain('demasiadas solicitudes');
    expect(described.message).not.toContain('Too Many Requests');
  });
  it('maps invalid data to reviewing the fields instead of echoing the server sentence', () => {
    const described = describeConfigError(new ApiError('Bad Request', 400, 'bad_request'), 'fallback');
    expect(described.message).toContain('Revisa los campos');
    expect(described.message).not.toContain('Bad Request');
  });
  it('maps a missing resource to rereading instead of echoing the server sentence', () => {
    const described = describeConfigError(new ApiError('Not Found', 404, 'gone'), 'fallback');
    expect(described.message).toContain('ya no existe');
    expect(described.message).not.toContain('Not Found');
  });
  it('hides a 5xx server sentence behind the reread instruction', () => {
    const described = describeConfigError(new ApiError('English server error', 500, 'internal'), 'fallback');
    expect(described.message).toContain('relee el inventario');
    expect(described.message).not.toContain('English server error');
  });
});
